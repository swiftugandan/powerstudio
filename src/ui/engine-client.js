/** Runs calculations on the WebAssembly engine in workers, one calculation at a time, with progress and cancellation.
 *
 * Ordinary studies run on the first worker. Contingency analysis splits its outages into contiguous chunks across a
 * pool of workers, and the engine merges the chunks in outage order, so the result is the same as a sequential run
 * whatever the pool size. When a worker cannot be started (some file:// contexts), one engine runs on the main
 * thread instead. */

import { engineModule } from '../engine/module.js';
import { EngineHost, jsonPayload } from '../engine/host.js';
import { request } from '../engine/studies.js';
import { adapt } from '../engine/reports.js';

/** @typedef {import('../engine/reports.js').CalcKind} CalcKind */
/** @typedef {(done: number, total: number) => void} OnProgress */
/** @typedef {{ id: number, resolve: (v: { bytes: Uint8Array, ms: number }) => void, reject: (e: Error) => void, onProgress?: OnProgress }} Pending */

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
    /** @type {Array<{ worker: Worker, pending: Pending | null } | null>} */
    this.slots = [];
    /** @type {EngineHost | null} */
    this.host = null;
    this.inThread = false;
    this.seq = 0;
    this.active = 0;
    /** Identifies the current run; cancelling or starting a run moves it on, and older runs stop at their next step. */
    this.token = 0;
  }

  get busy() { return this.active > 0; }

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
    const s = { worker, pending: /** @type {Pending | null} */ (null) };
    worker.onmessage = e => {
      const msg = e.data, p = s.pending;
      if (!p || msg.id !== p.id) return;
      if (msg.type === 'progress') { p.onProgress?.(msg.done, msg.total); return; }
      s.pending = null;
      if (msg.type === 'result') p.resolve({ bytes: msg.bytes, ms: msg.ms });
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
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      s.pending = { id, resolve, reject, onProgress };
      s.worker.postMessage({ id, kind, doc, options });
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
