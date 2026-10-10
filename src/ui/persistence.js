/** Local-first storage. Documents live in IndexedDB in this browser; small preferences live in localStorage. Nothing
 * leaves the machine. When IndexedDB is unavailable (some private windows) documents are kept in memory for the
 * session and the app says so. */

const DB = 'powerstudio', STORE = 'documents', META = 'meta', VERSION = 2;

/** @typedef {import('../core/document.js').PowerDocument} PowerDocument */
/** What the library lists: a document's name, last save and size. @typedef {{ id: string, name: string, updated: number, elements: number }} DocMeta */
/** @typedef {DocMeta & { doc: PowerDocument }} StoredDoc */
/** A stored document: its JSON text (version 2), or the document itself as version 1 stored it.
 * @typedef {{ id: string, json?: string, doc?: PowerDocument }} DocRecord */

/** Elements serialised between two pauses of `serialise`. */
const SLICE = 5000;

/**
 * A document as JSON text, built a few thousand elements at a time with a pause between, so saving a national network
 * never holds the page. Returns null when `same` says the document changed meanwhile (the change schedules a save
 * of its own), so what is stored is always one consistent state.
 * @param {PowerDocument} doc @param {() => boolean} same @param {() => Promise<void>} pause @returns {Promise<string | null>}
 */
export async function serialise(doc, same, pause) {
  const { elements, ...rest } = doc;
  const head = JSON.stringify(rest);
  /** @type {string[]} */
  const parts = [];
  for (let i = 0; i < elements.length; i += SLICE) {
    const chunk = JSON.stringify(elements.slice(i, i + SLICE));
    parts.push(chunk.slice(1, -1));
    if (i + SLICE < elements.length) {
      await pause();
      if (!same()) return null;
    }
  }
  return `${head.slice(0, -1)}${head.length > 2 ? ',' : ''}"elements":[${parts.filter(Boolean).join(',')}]}`;
}

export class DocumentLibrary {
  constructor() {
    /** @type {IDBDatabase | null} */
    this.db = null;
    /** @type {Map<string, { meta: DocMeta, json: string }>} */
    this.memory = new Map();
    this.persistent = false;
  }

  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, VERSION);
        req.onupgradeneeded = event => {
          const db = req.result, tx = /** @type {IDBTransaction} */ (req.transaction);
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('updated', 'updated');
          if (!db.objectStoreNames.contains(META)) {
            // Listing reads only this store; the documents saved before it (version 1) get their entries here.
            const meta = db.createObjectStore(META, { keyPath: 'id' });
            if (event.oldVersion >= 1) {
              tx.objectStore(STORE).openCursor().onsuccess = e => {
                const cursor = /** @type {IDBCursorWithValue | null} */ (/** @type {IDBRequest} */ (e.target).result);
                if (!cursor) return;
                const { id, name, updated, elements } = cursor.value;
                meta.put({ id, name, updated, elements });
                cursor.continue();
              };
            }
          }
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

  /** @template T @param {IDBTransactionMode} mode @param {(s: IDBObjectStore, meta: IDBObjectStore) => IDBRequest<T>} fn
   * @returns {Promise<T>} */
  request(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = /** @type {IDBDatabase} */ (this.db).transaction([STORE, META], mode);
      const req = fn(tx.objectStore(STORE), tx.objectStore(META));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted.'));
    });
  }

  /** @returns {Promise<DocMeta[]>} newest first */
  async list() {
    const all = this.db ? /** @type {DocMeta[]} */ (await this.request('readonly', (_, meta) => meta.getAll())) : [...this.memory.values()].map(m => m.meta);
    return all.map(({ id, name, updated, elements }) => ({ id, name, updated, elements })).sort((a, b) => b.updated - a.updated);
  }

  /** @param {string} id @returns {Promise<StoredDoc | undefined>} */
  async get(id) {
    if (!this.db) {
      const m = this.memory.get(id);
      return m && { ...m.meta, doc: JSON.parse(m.json) };
    }
    const [rec, meta] = await Promise.all([
      /** @type {Promise<DocRecord | undefined>} */ (this.request('readonly', s => s.get(id))),
      /** @type {Promise<DocMeta | undefined>} */ (this.request('readonly', (_, m) => m.get(id))),
    ]);
    if (!rec) return undefined;
    const doc = rec.json !== undefined ? JSON.parse(rec.json) : /** @type {PowerDocument} */ (rec.doc);
    return { id, name: meta?.name ?? doc.name, updated: meta?.updated ?? 0, elements: meta?.elements ?? doc.elements.length, doc };
  }

  /** Stores a document's JSON text (from `serialise`). @param {string} id @param {string} name @param {number} elements @param {string} json */
  async put(id, name, elements, json) {
    const meta = { id, name, updated: Date.now(), elements };
    if (!this.db) { this.memory.set(id, { meta, json }); return; }
    await this.request('readwrite', (s, m) => { m.put(meta); return s.put({ id, json }); });
  }

  /** @param {string} id */
  async remove(id) {
    if (!this.db) { this.memory.delete(id); return; }
    await this.request('readwrite', (s, m) => { m.delete(id); return s.delete(id); });
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
