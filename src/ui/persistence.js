/** Local-first storage. Documents live in IndexedDB in this browser; small preferences live in localStorage. Nothing
 * leaves the machine. When IndexedDB is unavailable (some private windows) documents are kept in memory for the
 * session and the app says so. */

const DB = 'powerstudio', STORE = 'documents', VERSION = 1;

/** @typedef {{ id: string, name: string, updated: number, elements: number, doc: import('../core/document.js').PowerDocument }} StoredDoc */

export class DocumentLibrary {
  constructor() {
    /** @type {IDBDatabase | null} */
    this.db = null;
    /** @type {Map<string, StoredDoc>} */
    this.memory = new Map();
    this.persistent = false;
  }

  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('updated', 'updated');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('The document database is blocked by another tab.'));
      });
      this.persistent = true;
    } catch {
      this.db = null;
      this.persistent = false;
    }
    return this.persistent;
  }

  /** @template T @param {IDBTransactionMode} mode @param {(s: IDBObjectStore) => IDBRequest<T>} fn @returns {Promise<T>} */
  request(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted.'));
    });
  }

  /** @returns {Promise<Array<Omit<StoredDoc, 'doc'>>>} newest first */
  async list() {
    const all = this.db ? /** @type {StoredDoc[]} */ (await this.request('readonly', s => s.getAll())) : [...this.memory.values()];
    return all.map(({ id, name, updated, elements }) => ({ id, name, updated, elements })).sort((a, b) => b.updated - a.updated);
  }

  /** @param {string} id @returns {Promise<StoredDoc | undefined>} */
  async get(id) {
    if (!this.db) return this.memory.get(id);
    return /** @type {StoredDoc | undefined} */ (await this.request('readonly', s => s.get(id)));
  }

  /** @param {string} id @param {import('../core/document.js').PowerDocument} doc */
  async put(id, doc) {
    /** @type {StoredDoc} */
    // IndexedDB copies the document as it stores it; only the in-memory fallback needs its own copy.
    const rec = { id, name: doc.name, updated: Date.now(), elements: doc.elements.length, doc };
    if (!this.db) { this.memory.set(id, { ...rec, doc: structuredClone(doc) }); return; }
    await this.request('readwrite', s => s.put(rec));
  }

  /** @param {string} id */
  async remove(id) {
    if (!this.db) { this.memory.delete(id); return; }
    await this.request('readwrite', s => s.delete(id));
  }
}

/** A new document id. */
export const newDocId = () => `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const PREFS = 'powerstudio.prefs';

/** @typedef {{ theme: 'system' | 'light' | 'dark', renderer: 'auto' | 'canvas', lastDoc: string, leftW: number, rightW: number,
 *   dockH: number, left: boolean, right: boolean, dock: boolean, names: boolean, branchNames: boolean, boxes: boolean,
 *   colouring: 'results' | 'voltage', autoLoadFlow: boolean, lastKV: number, dockTab: string, ribbonTab: string, welcomed: boolean }} Prefs */

/** @type {Prefs} */
const DEFAULTS = { theme: 'system', renderer: 'auto', lastDoc: '', leftW: 248, rightW: 304, dockH: 210, left: true, right: true, dock: true,
  names: true, branchNames: false, boxes: true, colouring: 'results', autoLoadFlow: true, lastKV: 20, dockTab: 'output', ribbonTab: 'home', welcomed: false };

/** @returns {Prefs} */
export function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS) ?? '{}');
    /** @type {Record<string, unknown>} */
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (k in raw && typeof raw[k] === typeof (/** @type {Record<string, unknown>} */ (DEFAULTS))[k]) out[k] = raw[k];
    return /** @type {Prefs} */ (out);
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {Prefs} prefs */
export function savePrefs(prefs) {
  try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* storage unavailable: preferences last for this session */ }
}
