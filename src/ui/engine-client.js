/** Runs calculations on the WebAssembly engine in workers, one calculation at a time, with progress and cancellation.
 *
 * Ordinary studies run on the first worker. Contingency analysis splits its outages into contiguous chunks across a
 * pool of workers, and the engine merges the chunks in outage order, so the result is the same as a sequential run
 * whatever the pool size. When a worker cannot be started (some file:// contexts), one engine runs on the main
 * thread instead.
 *
 * Each worker keeps its own copy of the document. It receives the document as JSON once per document (serialised in
 * slices, so a national network does not hold the page), and after that only the store's operations, which it applies
 * to its copy; a calculation names the document state it expects. So the page never copies the whole document for a
 * calculation, and a contingency analysis across eight workers does not copy it eight times. */

import { engineModule } from '../engine/module.js';
import { EngineHost, jsonPayload } from '../engine/host.js';
import { request } from '../engine/studies.js';
import { importFiles } from '../engine/exchange.js';
import { autoLayout } from '../core/layout.js';
import { adapt } from '../engine/reports.js';
import { serialise } from './persistence.js';
import { yieldToBrowser } from './dom.js';

/** @typedef {import('../engine/reports.js').CalcKind} CalcKind */
/** @typedef {(done: number, total: number) => void} OnProgress */
/** @typedef {{ bytes: Uint8Array, ms: number, summary?: import('../engine/reports.js').ImportSummary }} Reply */
/** @typedef {{ id: number, resolve: (v: Reply) => void, reject: (e: Error) => void, onProgress?: OnProgress }} Pending */
/** @typedef {{ worker: Worker, pending: Pending | null, key: string }} Slot A worker, its call in progress and the document state its copy holds */

/** Outages below which contingency analysis stays on one worker. */
const PARALLEL_FROM = 16;
/** Fewest outages per chunk. */
const MIN_CHUNK = 8;

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
      if (msg.type === 'result') p.resolve({ bytes: msg.bytes, ms: msg.ms, summary: msg.summary });
      else p.reject(new Error(msg.message));
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
   * @returns {Promise<{ bytes: Uint8Array, ms: number }>}
   */
  async exec(k, module, kind, doc, options, onProgress) {
    const s = this.slot(k, module);
    if (!s) {
      this.host ??= await EngineHost.create(module);
      const host = this.host;
      return new Promise((resolve, reject) => setTimeout(() => {
        const t0 = performance.now();
        try { resolve({ bytes: request(host, kind, doc, options, onProgress), ms: performance.now() - t0 }); }
        catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      }, 0));
    }
    // The worker computes on its own copy of the document when the request is about the current one.
    const resident = doc !== null && doc === this.doc;
    if (resident) await this.ensureDocument(s);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      s.pending = { id, resolve, reject, onProgress };
      s.worker.postMessage(resident ? { id, kind, key: this.key, options } : { id, kind, doc, options });
    });
  }

  /**
   * Runs a calculation. A new calculation cancels the one in progress.
   * @param {CalcKind} kind @param {import('../core/document.js').PowerDocument} doc @param {Record<string, unknown>} [options]
   * @param {OnProgress} [onProgress] @returns {Promise<{ result: any, ms: number }>}
   */
  async run(kind, doc, options = {}, onProgress) {
    if (this.busy) this.cancel();
    const token = ++this.token;
    this.active++;
    const t0 = performance.now();
    try {
      const module = await engineModule();
      this.check(token);
      const { bytes } = kind === 'contingency'
        ? await this.contingency(token, module, doc, onProgress)
        : await this.exec(0, module, kind, doc, options, onProgress);
      this.check(token);
      return { result: adapt(kind, jsonPayload(bytes)), ms: performance.now() - t0 };
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

  /** Stops a run that has been cancelled or superseded. @param {number} token */
  check(token) {
    if (token !== this.token) throw new CancelledError();
  }

  /**
   * Contingency analysis across the pool.
   * @param {number} token @param {WebAssembly.Module} module @param {import('../core/document.js').PowerDocument} doc
   * @param {OnProgress} [onProgress]
   */
  async contingency(token, module, doc, onProgress) {
    const plan = jsonPayload((await this.exec(0, module, 'contingency_plan', doc, {})).bytes);
    this.check(token);
    const count = /** @type {number} */ (plan.count);
    const parts = this.inThread || count < PARALLEL_FROM ? 1 : Math.min(this.poolSize, Math.ceil(count / MIN_CHUNK));
    if (parts <= 1) return this.exec(0, module, 'contingency', doc, {}, onProgress);
    const size = Math.ceil(count / parts);
    const done = new Array(parts).fill(0);
    const chunks = await Promise.all(Array.from({ length: parts }, (_, k) => this.exec(k, module, 'contingency_chunk', doc, { from: k * size, to: (k + 1) * size },
      d => { done[k] = d; onProgress?.(done.reduce((a, b) => a + b, 0), count); })));
    this.check(token);
    return this.exec(0, module, 'contingency_merge', null, chunks.map(c => jsonPayload(c.bytes)));
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
