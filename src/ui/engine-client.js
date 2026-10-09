/** Runs calculations in the engine worker, one at a time, with progress and cancellation. When a worker cannot be
 * started (some file:// contexts), the same solvers run on the main thread instead. */

import { runLoadFlow } from '../core/loadflow.js';
import { runShortCircuit } from '../core/shortcircuit.js';
import { runContingency } from '../core/contingency.js';
import { runRms } from '../core/rms.js';

/** @typedef {'loadflow' | 'shortcircuit' | 'contingency' | 'rms'} CalcKind */

export class CancelledError extends Error {
  constructor() { super('The calculation was cancelled.'); this.name = 'CancelledError'; }
}

export class EngineClient {
  /** @param {() => Worker} factory */
  constructor(factory) {
    this.factory = factory;
    /** @type {Worker | null} */
    this.worker = null;
    this.seq = 0;
    /** @type {{ id: number, resolve: (v: any) => void, reject: (e: Error) => void, onProgress?: (d: number, t: number) => void } | null} */
    this.pending = null;
    this.inThread = false;
  }

  ensure() {
    if (this.worker || this.inThread) return;
    try {
      this.worker = this.factory();
      this.worker.onmessage = e => this.receive(e.data);
      this.worker.onerror = e => { e.preventDefault(); this.fail(new Error(e.message || 'The calculation worker failed.')); this.worker?.terminate(); this.worker = null; };
    } catch {
      this.inThread = true;
    }
  }

  /** @param {any} msg */
  receive(msg) {
    const p = this.pending;
    if (!p || msg.id !== p.id) return;
    if (msg.type === 'progress') { p.onProgress?.(msg.done, msg.total); return; }
    this.pending = null;
    if (msg.type === 'result') p.resolve({ result: msg.result, ms: msg.ms });
    else p.reject(new Error(msg.message));
  }

  /** @param {Error} error */
  fail(error) { const p = this.pending; this.pending = null; p?.reject(error); }

  get busy() { return this.pending !== null; }

  /**
   * @param {CalcKind} kind @param {import('../core/document.js').PowerDocument} doc @param {Record<string, unknown>} [options]
   * @param {(done: number, total: number) => void} [onProgress] @returns {Promise<{ result: any, ms: number }>}
   */
  run(kind, doc, options = {}, onProgress) {
    if (this.pending) this.cancel();
    this.ensure();
    const id = ++this.seq;
    if (this.inThread) {
      const t0 = performance.now();
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            const result = kind === 'loadflow' ? runLoadFlow(doc, options) : kind === 'shortcircuit' ? runShortCircuit(doc, options)
              : kind === 'contingency' ? runContingency(doc, { onProgress }) : runRms(doc, { ...options, onProgress });
            resolve({ result, ms: performance.now() - t0 });
          } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
        }, 0);
      });
    }
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, onProgress };
      /** @type {Worker} */ (this.worker).postMessage({ id, kind, doc, options });
    });
  }

  /** Stops the running calculation by restarting the worker. */
  cancel() {
    if (!this.pending) return;
    this.worker?.terminate();
    this.worker = null;
    this.fail(new CancelledError());
  }
}
