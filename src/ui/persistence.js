/** Local-first storage. Projects live in IndexedDB in this browser; small preferences live in localStorage. Nothing
 * leaves the machine. When IndexedDB is unavailable (some private windows) projects are kept in memory for the
 * session and the app says so.
 *
 * A project is stored in parts, so an edit rewrites only the part it changed: the base document's JSON (`documents`,
 * the store version 1 and 2 kept whole documents in), its catalogue entry (`meta`: name, size, last save), and its
 * manifest, variants and scenarios (`parts`, keyed `<project>/manifest`, `<project>/variant/<id>`,
 * `<project>/scenario/<id>`). Run records go in `runs`, keyed `<project>/<run>`, and each run's report, compressed, in
`results` under the same key, so two runs can be compared later. A document saved before projects
 * (versions 1 and 2) has no parts and opens as a project with one study case. OPFS would suit large files, but
 * Chromium refuses it to pages opened from a file, which PowerStudio supports; IndexedDB keeps large values as files and
 * works from both. */

const DB = 'powerstudio', STORE = 'documents', META = 'meta', PARTS = 'parts', RUNS = 'runs', RESULTS = 'results', VERSION = 4;

/** @typedef {import('../core/document.js').PowerDocument} PowerDocument */
/** What the library lists: a document's name, last save and size. @typedef {{ id: string, name: string, updated: number, elements: number }} DocMeta */
/** @typedef {DocMeta & { doc: PowerDocument }} StoredDoc */
/** One calculation as the run log keeps it (docs/design/NATIONAL-GRADE.md, section 9.2).
 * @typedef {{ run: string, time: string, kind: string, studyCase: string, scenario: string, variants: string[],
 *   engine: { version: string, wasmSha256: string }, inputs: { modelSha256: string, studySha256: string, startSha256: string },
 *   outcome: Record<string, unknown>, resultsSha256: string, durationMs: number }} RunRecord */
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
    /** Parts and run records when IndexedDB is unavailable. @type {Map<string, { key: string, project: string, json: string }>} */
    this.memoryParts = new Map();
    /** @type {Map<string, RunRecord & { key: string, project: string }>} */
    this.memoryRuns = new Map();
    /** @type {Map<string, { key: string, project: string, kind: string, report: Blob }>} */
    this.memoryResults = new Map();
    this.persistent = false;
  }

  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, VERSION);
        req.onupgradeneeded = event => {
          const db = req.result, tx = /** @type {IDBTransaction} */ (req.transaction);
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('updated', 'updated');
          for (const name of [PARTS, RUNS, RESULTS]) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' }).createIndex('project', 'project');
          }
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

  /** @template T @param {IDBTransactionMode} mode
   * @param {(s: IDBObjectStore, meta: IDBObjectStore, parts: IDBObjectStore, runs: IDBObjectStore, results: IDBObjectStore) => IDBRequest<T>} fn
   * @returns {Promise<T>} */
  request(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = /** @type {IDBDatabase} */ (this.db).transaction([STORE, META, PARTS, RUNS, RESULTS], mode);
      const req = fn(tx.objectStore(STORE), tx.objectStore(META), tx.objectStore(PARTS), tx.objectStore(RUNS), tx.objectStore(RESULTS));
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

  /** The parts of a project, keyed by their name within it (`manifest`, `variant/<id>`, `scenario/<id>`), as JSON text.
   * @param {string} id @returns {Promise<Map<string, string>>} */
  async parts(id) {
    const all = this.db
      ? /** @type {Array<{ key: string, json: string }>} */ (await this.request('readonly', (_, __, parts) => parts.index('project').getAll(id)))
      : [...this.memoryParts.values()].filter(p => p.project === id);
    return new Map(all.map(p => [p.key.slice(id.length + 1), p.json]));
  }

  /**
   * Writes parts of a project in one transaction (JSON text, or null to delete one) and marks it saved now.
   * @param {string} id @param {Array<[string, string | null]>} parts by name within the project
   */
  async putParts(id, parts) {
    if (!this.db) {
      for (const [name, json] of parts) {
        const key = `${id}/${name}`;
        if (json === null) this.memoryParts.delete(key); else this.memoryParts.set(key, { key, project: id, json });
      }
      const m = this.memory.get(id);
      if (m) m.meta.updated = Date.now();
      return;
    }
    await this.request('readwrite', (_, meta, store) => {
      for (const [name, json] of parts) {
        if (json === null) store.delete(`${id}/${name}`); else store.put({ key: `${id}/${name}`, project: id, json });
      }
      const touch = meta.get(id);
      touch.onsuccess = () => { if (touch.result) meta.put({ ...touch.result, updated: Date.now() }); };
      return touch;
    });
  }

  /** Appends a run record to a project's run log. @param {string} id @param {RunRecord} record */
  async addRun(id, record) {
    const row = { ...record, key: `${id}/${record.run}`, project: id };
    if (!this.db) { this.memoryRuns.set(row.key, row); return; }
    await this.request('readwrite', (_, __, ___, runs) => runs.put(row));
  }

  /** Stores a run's report (the engine's JSON, gzip-compressed). @param {string} id @param {string} run @param {string} kind
   * @param {Blob} report */
  async putResult(id, run, kind, report) {
    const row = { key: `${id}/${run}`, project: id, kind, report };
    if (!this.db) { this.memoryResults.set(row.key, row); return; }
    await this.request('readwrite', (_, __, ___, ____, results) => results.put(row));
  }

  /** A run's stored report, or undefined. @param {string} id @param {string} run @returns {Promise<Blob | undefined>} */
  async getResult(id, run) {
    const key = `${id}/${run}`;
    const row = this.db
      ? /** @type {{ report: Blob } | undefined} */ (await this.request('readonly', (_, __, ___, ____, results) => results.get(key)))
      : this.memoryResults.get(key);
    return row?.report;
  }

  /** Deletes a run from the log, with its report. @param {string} id @param {string} run */
  async removeRun(id, run) {
    const key = `${id}/${run}`;
    if (!this.db) { this.memoryRuns.delete(key); this.memoryResults.delete(key); return; }
    await this.request('readwrite', (_, __, ___, runs, results) => { results.delete(key); return runs.delete(key); });
  }

  /** A project's run log, oldest first. @param {string} id @returns {Promise<RunRecord[]>} */
  async runs(id) {
    const all = this.db
      ? /** @type {Array<RunRecord & { key: string, project: string }>} */ (await this.request('readonly', (_, __, ___, runs) => runs.index('project').getAll(id)))
      : [...this.memoryRuns.values()].filter(r => r.project === id);
    return all.map(({ key: _, project: __, ...r }) => /** @type {RunRecord} */ (r)).sort((a, b) => a.time.localeCompare(b.time));
  }

  /** Deletes a project with its parts, run log and stored reports. @param {string} id */
  async remove(id) {
    if (!this.db) {
      this.memory.delete(id);
      for (const [k, p] of this.memoryParts) if (p.project === id) this.memoryParts.delete(k);
      for (const [k, r] of this.memoryRuns) if (r.project === id) this.memoryRuns.delete(k);
      for (const [k, r] of this.memoryResults) if (r.project === id) this.memoryResults.delete(k);
      return;
    }
    await this.request('readwrite', (s, m, parts, runs, results) => {
      for (const store of [parts, runs, results]) {
        store.index('project').getAllKeys(id).onsuccess = e => {
          for (const key of /** @type {IDBValidKey[]} */ (/** @type {IDBRequest} */ (e.target).result)) store.delete(key);
        };
      }
      m.delete(id);
      return s.delete(id);
    });
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
