/** Runs calculations on the WebAssembly engine in workers, one calculation at a time, with progress and cancellation.
 *
 * Ordinary studies run on the first worker. Contingency analysis splits its outages into contiguous chunks across a
 * pool of workers, and the engine merges the chunks in outage order, so the result is the same as a sequential run
 * whatever the pool size. When a worker cannot be started (some file:// contexts), one engine runs on the main
 * thread instead.
 *
 * Each worker's engine holds the document open. It receives the document as JSON once per document (serialised in
 * slices, so a national network does not hold the page), and after that only the store's operations, which it applies
 * to its open document; a calculation names the document state it expects. So the page never copies the whole
 * document for a calculation, a contingency analysis across eight workers does not copy it eight times, and the
 * engine does not read the document's text again after an edit. */

import { engineModule } from '../engine/module.js';
import { EngineHost, jsonPayload } from '../engine/host.js';
import { study } from '../engine/studies.js';
import { importFiles } from '../engine/exchange.js';
import { adapt } from '../engine/reports.js';
import { serialise } from './persistence.js';
import { DRAWING_KEYS } from '../core/store.js';
import { autoLayout, laidOut, drawingOf } from '../core/layout.js';
import { yieldToBrowser } from './dom.js';

/** @typedef {import('../engine/reports.js').CalcKind} CalcKind */
/** @typedef {(done: number, total: number) => void} OnProgress */
/** @typedef {{ engine: string, model?: string, study?: string, results: string }} Hashes A run record's hashes from the engine */
/** @typedef {{ bytes: Uint8Array, ms: number, summary?: import('../engine/reports.js').ImportSummary, record?: Hashes, header?: Record<string, any> }} Reply */
/** @typedef {{ id: number, resolve: (v: Reply) => void, reject: (e: Error) => void, onProgress?: OnProgress }} Pending */
/** @typedef {{ worker: Worker, pending: Pending | null, key: string }} Slot A worker, its call in progress and the document state its copy holds */

/** Outages below which contingency analysis stays on one worker. */
const PARALLEL_FROM = 16;
/** Fewest outages per chunk. */
const MIN_CHUNK = 8;
/** Chunks per worker: more chunks than workers, handed out as workers come free, so one slow stretch of outages (the
 * machines and network splits at the end of the list) does not hold the whole run. Each chunk solves the base case
 * again, a fraction of a second on a national network. */
const CHUNKS_PER_WORKER = 4;

/** A worker's engine did not hold the document state a study named; the message says why when opening or editing
 * the document failed. */
class StaleDocument extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'StaleDocument'; }
}

export class CancelledError extends Error {
  constructor() { super('The calculation was cancelled.'); this.name = 'CancelledError'; }
}

export class EngineClient {
  /** @param {() => Worker} factory @param {{ poolSize?: number }} [opt] */
  constructor(factory, opt = {}) {
    this.factory = factory;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    this.poolSize = opt.poolSize ?? Math.min(8, Math.max(1, cores - 1));
    /** @type {Array<Slot | null>} */
    this.slots = [];
    /** The document the workers' copies follow, and how many times one was opened and edited since. */
    /** @type {import('../core/document.js').PowerDocument | null} */
    this.doc = null;
    this.opened = 0;
    this.edits = 0;
    /** The document's JSON for a state, built when a worker first needs it. @type {{ key: string, text: Promise<string> } | null} */
    this.json = null;
    /** @type {EngineHost | null} */
    this.host = null;
    this.inThread = false;
    this.seq = 0;
    this.active = 0;
    /** Identifies the current run; cancelling or starting a run moves it on, and older runs stop at their next step. */
    this.token = 0;
    /** How long each worker took over the last parallel contingency analysis, ms (for support and benchmarks). */
    /** @type {number[]} */
    this.lastChunks = [];
    /** The last parallel analysis's phases, ms: planning, the chunks, and merging. */
    this.lastPhases = { plan: 0, chunks: 0, merge: 0 };
  }

  get busy() { return this.active > 0; }

  /** The document state the workers' copies should hold. */
  get key() { return `${this.opened}:${this.edits}`; }

  /** A new document: every worker gets it before its next calculation. @param {import('../core/document.js').PowerDocument} doc */
  setDocument(doc) {
    this.doc = doc;
    this.opened++;
    this.edits = 0;
    this.json = null;
  }

  /** Forwards an edit to the workers whose copies are current; the others get the whole document when next needed.
   * @param {import('../core/store.js').Op[]} ops */
  applyOps(ops) {
    // The engines never read where elements are drawn, so moving them is not sent.
    ops = ops.filter(op => !(op.type === 'set' && DRAWING_KEYS.has(op.key)));
    if (!this.doc || !ops.length) return;
    const before = this.key;
    this.edits++;
    this.json = null;
    for (const s of this.slots) {
      if (s?.key === before) { s.worker.postMessage({ type: 'ops', ops, key: this.key }); s.key = this.key; }
    }
  }

  /** Brings a worker's copy of the document up to date. @param {Slot} s */
  async ensureDocument(s) {
    while (this.doc && s.key !== this.key) {
      const key = this.key, doc = this.doc;
      if (this.json?.key !== key) {
        this.json = { key, text: serialise(doc, () => this.key === key, yieldToBrowser).then(t => t ?? '') };
      }
      const text = await this.json.text;
      // An edit or another document came meanwhile: start again with the state as it is now.
      if (!text || this.key !== key) continue;
      s.worker.postMessage({ type: 'doc', json: text, key });
      s.key = key;
    }
  }

  /**
   * Starts worker `k` if needed. Returns null when workers are unavailable.
   * @param {number} k @param {WebAssembly.Module} module
   */
  slot(k, module) {
    if (this.inThread) return null;
    const existing = this.slots[k];
    if (existing) return existing;
    let worker;
    try { worker = this.factory(); } catch { this.inThread = true; return null; }
    /** @type {Slot} */
    const s = { worker, pending: null, key: '' };
    worker.onmessage = e => {
      const msg = e.data, p = s.pending;
      if (!p || msg.id !== p.id) return;
      if (msg.type === 'progress') { p.onProgress?.(msg.done, msg.total); return; }
      s.pending = null;
      if (msg.type === 'result') p.resolve({ bytes: msg.bytes, ms: msg.ms, summary: msg.summary, record: msg.record, header: msg.header });
      else p.reject(msg.stale ? new StaleDocument(msg.message) : new Error(msg.message));
    };
    worker.onerror = e => {
      e.preventDefault();
      const p = s.pending;
      s.pending = null;
      worker.terminate();
      this.slots[k] = null;
      p?.reject(new Error(e.message || 'The calculation worker failed.'));
    };
    worker.postMessage({ type: 'init', module });
    this.slots[k] = s;
    return s;
  }

  /**
   * Runs one engine request on worker `k`, or on the main thread when there are no workers.
   * @param {number} k @param {WebAssembly.Module} module @param {string} kind
   * @param {import('../core/document.js').PowerDocument | null} doc @param {Record<string, any>} options @param {OnProgress} [onProgress]
   * @param {boolean} [record] ask for the run record's hashes
   * @returns {Promise<Reply>}
   */
  async exec(k, module, kind, doc, options, onProgress, record = false) {
    const s = this.slot(k, module);
    if (!s) {
      this.host ??= await EngineHost.create(module);
      const host = this.host;
      return new Promise((resolve, reject) => setTimeout(() => {
        const t0 = performance.now();
        try {
          const reply = study(host, kind, doc, options, onProgress, { record });
          resolve({ bytes: reply.payload, record: reply.header.record, ms: performance.now() - t0 });
        } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      }, 0));
    }
    // The worker's engine computes on the document it holds open when the request is about the current one.
    const resident = doc !== null && doc === this.doc;
    /** @returns {Promise<Reply>} */
    const send = async () => {
      if (resident) await this.ensureDocument(s);
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        s.pending = { id, resolve, reject, onProgress };
        s.worker.postMessage(resident ? { id, kind, key: this.key, options, record } : { id, kind, doc, options, record });
      });
    };
    try {
      return await send();
    } catch (error) {
      // An edit the engine could not apply: it gets the whole document again, once. A second failure reports the
      // engine's reason as an ordinary error.
      if (!(error instanceof StaleDocument)) throw error;
      s.key = '';
      try { return await send(); }
      catch (again) { throw again instanceof StaleDocument ? new Error(again.message) : again; }
    }
  }

  /**
   * Runs a calculation. A new calculation cancels the one in progress. With `record`, the reply carries the run
   * record's hashes (the engine version, the model, the study case and the report).
   * @param {CalcKind} kind @param {import('../core/document.js').PowerDocument} doc @param {Record<string, unknown>} [options]
   * @param {OnProgress} [onProgress] @param {{ record?: boolean }} [opt]
   * @returns {Promise<{ result: any, ms: number, record?: Hashes, bytes: Uint8Array }>} `bytes` is the report as the
   * engine wrote it (JSON)
   */
  async run(kind, doc, options = {}, onProgress, opt = {}) {
    if (this.busy) this.cancel();
    const token = ++this.token;
    this.active++;
    const t0 = performance.now();
    try {
      const module = await engineModule();
      this.check(token);
      const { bytes, record } = kind === 'contingency'
        ? await this.contingency(token, module, doc, onProgress, !!opt.record)
        : await this.exec(0, module, kind, doc, options, onProgress, !!opt.record);
      this.check(token);
      return { result: adapt(kind, jsonPayload(bytes)), ms: performance.now() - t0, record, bytes };
    } finally {
      this.active--;
    }
  }

  /**
   * Opens other tools' files (CGMES, PSS/E RAW, MATPOWER) as a laid-out document. Cancels a calculation in progress: the
   * document it was running on is being replaced. The files' buffers are transferred to the worker.
   * @param {import('../engine/exchange.js').NamedBytes[]} files
   * @returns {Promise<{ summary: import('../engine/reports.js').ImportSummary, doc: import('../core/document.js').PowerDocument }>}
   */
  async importFiles(files) {
    if (this.busy) this.cancel();
    this.active++;
    try {
      const module = await engineModule();
      const s = this.slot(0, module);
      if (!s) {
        this.host ??= await EngineHost.create(module);
        const imported = importFiles(this.host, files);
        autoLayout(imported.doc);
        return imported;
      }
      /** @type {Reply} */
      const reply = await new Promise((resolve, reject) => {
        const id = ++this.seq;
        s.pending = { id, resolve, reject };
        s.worker.postMessage({ id, type: 'import', files }, files.map(f => f.bytes.buffer));
      });
      if (!reply.summary) throw new Error('The engine returned no import summary.');
      return { summary: reply.summary, doc: jsonPayload(reply.bytes) };
    } finally {
      this.active--;
    }
  }

  /**
   * Lays a document's diagram out again on the first worker (on this thread when there are no workers), and returns
   * every element's drawing fields as laid out, or null when the document changed while it was being serialised.
   * @param {import('../core/document.js').PowerDocument} doc @param {() => boolean} same whether the document is unchanged
   * @returns {Promise<Array<Record<string, unknown>> | null>}
   */
  async layout(doc, same) {
    this.active++;
    try {
      const json = await serialise(doc, same, yieldToBrowser);
      if (json === null) return null;
      const module = await engineModule();
      const s = this.slot(0, module);
      if (!s) return drawingOf(laidOut(json));
      /** @type {Reply} */
      const reply = await new Promise((resolve, reject) => {
        const id = ++this.seq;
        s.pending = { id, resolve, reject };
        s.worker.postMessage({ id, type: 'layout', json });
      });
      return jsonPayload(reply.bytes);
    } finally {
      this.active--;
    }
  }

  /**
   * Any other engine operation (such as `export_cgmes`), on the first worker or on this thread when there are none.
   * The payload's buffer is transferred to the worker.
   * @param {Record<string, unknown>} header @param {Uint8Array} payload
   * @returns {Promise<{ header: Record<string, any>, payload: Uint8Array }>}
   */
  async call(header, payload) {
    this.active++;
    try {
      const module = await engineModule();
      const s = this.slot(0, module);
      if (!s) {
        this.host ??= await EngineHost.create(module);
        const reply = this.host.call(header, payload);
        return { header: reply.header, payload: reply.payload };
      }
      /** @type {Reply} */
      const reply = await new Promise((resolve, reject) => {
        const id = ++this.seq;
        s.pending = { id, resolve, reject };
        s.worker.postMessage({ id, type: 'call', header, payload }, [payload.buffer]);
      });
      return { header: reply.header ?? {}, payload: reply.bytes };
    } finally {
      this.active--;
    }
  }

  /** Stops a run that has been cancelled or superseded. @param {number} token */
  check(token) {
    if (token !== this.token) throw new CancelledError();
  }

  /**
   * Contingency analysis across the pool.
   * @param {number} token @param {WebAssembly.Module} module @param {import('../core/document.js').PowerDocument} doc
   * @param {OnProgress} [onProgress] @param {boolean} [record] ask for the run record's hashes: the inputs' from the
   * plan, the report's from the merge
   * @returns {Promise<Reply>}
   */
  async contingency(token, module, doc, onProgress, record = false) {
    const t0 = performance.now();
    const planned = await this.exec(0, module, 'contingency_plan', doc, {}, undefined, record);
    const t1 = performance.now();
    const plan = jsonPayload(planned.bytes);
    this.check(token);
    const count = /** @type {number} */ (plan.count);
    const parts = this.inThread || count < PARALLEL_FROM ? 1 : Math.min(this.poolSize, Math.ceil(count / MIN_CHUNK));
    if (parts <= 1) return this.exec(0, module, 'contingency', doc, {}, onProgress, record);
    const pieces = Math.min(parts * CHUNKS_PER_WORKER, Math.ceil(count / MIN_CHUNK));
    const size = Math.ceil(count / pieces);
    const done = new Array(pieces).fill(0);
    /** @type {Reply[]} */
    const chunks = new Array(pieces);
    const busy = new Array(parts).fill(0);
    let next = 0;
    try {
      // Each worker takes the next chunk when it finishes one; the engine merges them in chunk order.
      await Promise.all(Array.from({ length: parts }, async (_, k) => {
        while (next < pieces) {
          const p = next++;
          chunks[p] = await this.exec(k, module, 'contingency_chunk', doc, { from: p * size, to: (p + 1) * size },
            d => { done[p] = d; onProgress?.(done.reduce((a, b) => a + b, 0), count); });
          busy[k] += chunks[p].ms;
          this.check(token);
        }
      }));
      this.check(token);
      this.lastChunks = busy.map(Math.round);
      const t2 = performance.now();
      // The chunks go to the engine as the workers wrote them, so the page parses none of them.
      const payload = new Uint8Array(chunks.reduce((n, c) => n + c.bytes.length, 0));
      let at = 0;
      for (const c of chunks) { payload.set(c.bytes, at); at += c.bytes.length; }
      const reply = await this.call({ op: 'study', kind: 'contingency_merge', options: null, chunks: chunks.map(c => c.bytes.length), record }, payload);
      const merged = { bytes: reply.payload, ms: 0, record: reply.header.record };
      this.lastPhases = { plan: Math.round(t1 - t0), chunks: Math.round(t2 - t1), merge: Math.round(performance.now() - t2) };
      return { ...merged, record: merged.record && planned.record ? { ...planned.record, results: merged.record.results } : undefined };
    } finally {
      this.releasePool();
    }
  }

  /** Ends the pool's idle workers after a contingency analysis, keeping the first. Each engine holds a national
   * network's document and model, and WebAssembly memory never shrinks, so only one stays resident between runs; the
   * next analysis starts the others again and sends them the document. */
  releasePool() {
    for (let k = 1; k < this.slots.length; k++) {
      const s = this.slots[k];
      if (!s || s.pending) continue;
      s.worker.terminate();
      this.slots[k] = null;
    }
  }

  /** Stops the running calculation by restarting the busy workers. A run on the main thread cannot be interrupted;
   * its result is discarded. */
  cancel() {
    this.token++;
    for (const [k, s] of this.slots.entries()) {
      if (!s?.pending) continue;
      s.worker.terminate();
      this.slots[k] = null;
      s.pending.reject(new CancelledError());
    }
  }
}

