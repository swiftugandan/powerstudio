/** The four studies on a PowerStudio document, run by an engine instance. The worker, the main-thread fallback and
 * the Node tests all go through here, so they send the engine the same requests.
 *
 * Options follow the study case (src/core/document.js) and may override any of its settings for one run. */

import { jsonPayload, textPayload } from './host.js';
import { adapt } from './reports.js';

/**
 * @typedef {import('./host.js').EngineHost} EngineHost
 * @typedef {import('../core/document.js').PowerDocument} PowerDocument
 * @typedef {import('./reports.js').CalcKind} CalcKind
 * @typedef {(done: number, total: number) => void} OnProgress
 * @typedef {{ tolerance?: number, maxIter?: number, enforceQLimits?: boolean, loadScale?: number, dcStart?: boolean,
 *   start?: { busIds: string[], vm: ArrayLike<number>, va: ArrayLike<number>, held?: Array<{ id: string, limit: 'min' | 'max' }> },
 *   outages?: Iterable<string> }} LoadFlowOptions
 */

/**
 * Translates app options into engine options. Load scaling is a fraction in the app's call options and a percentage
 * in the study case and the engine.
 * @param {string} kind @param {Record<string, any>} options
 */
export function engineOptions(kind, options) {
  if (kind !== 'loadflow') return options;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of ['tolerance', 'maxIter', 'enforceQLimits', 'dcStart']) if (options[key] !== undefined) out[key] = options[key];
  if (options.loadScale !== undefined) out.loadScale = options.loadScale * 100;
  if (options.outages) out.outages = [...options.outages];
  if (options.start) {
    const { busIds, vm, va, held } = options.start;
    out.start = { busIds, vm: Array.from(vm), va: Array.from(va), ...(held?.length ? { held } : {}) };
  }
  return out;
}

/**
 * Runs one engine request and returns the raw JSON report.
 * @param {EngineHost} engine @param {string} kind @param {PowerDocument | null} doc @param {Record<string, any>} options
 * @param {OnProgress} [onProgress]
 */
export function request(engine, kind, doc, options, onProgress) {
  const payload = doc ? textPayload(JSON.stringify(doc)) : undefined;
  return engine.call({ op: 'study', kind, options: engineOptions(kind, options) }, payload, onProgress).payload;
}

/**
 * Runs one engine request on the document the engine holds open (`openDocument`), and returns the raw JSON report.
 * @param {EngineHost} engine @param {string} kind @param {Record<string, any>} options @param {OnProgress} [onProgress]
 */
export function requestOpen(engine, kind, options, onProgress) {
  return engine.call({ op: 'study', kind, options: engineOptions(kind, options), resident: true }, undefined, onProgress).payload;
}

/** Gives the engine a document to hold open, as JSON text. @param {EngineHost} engine @param {string} json */
export function openDocument(engine, json) { engine.call({ op: 'doc_open' }, textPayload(json)); }

/** Applies the editor's operations to the engine's open document. Throws when they do not apply (the engine then
 * holds no document). @param {EngineHost} engine @param {unknown[]} ops */
export function editDocument(engine, ops) { engine.call({ op: 'doc_edit', ops }); }

/** Studies bound to one engine instance. */
export class Studies {
  /** @param {EngineHost} engine */
  constructor(engine) { this.engine = engine; }

  /**
   * @template {CalcKind} K @param {K} kind @param {PowerDocument} doc @param {Record<string, any>} [options] @param {OnProgress} [onProgress]
   * @returns {import('./reports.js').ResultOf[K]}
   */
  run(kind, doc, options = {}, onProgress) {
    return adapt(kind, jsonPayload(request(this.engine, kind, doc, options, onProgress)));
  }

  /** @param {PowerDocument} doc @param {LoadFlowOptions} [options] @returns {import('./reports.js').LoadFlowResult} */
  loadflow(doc, options = {}) { return this.run('loadflow', doc, options); }

  /** @param {PowerDocument} doc @param {Record<string, any>} [options] @returns {import('./reports.js').ShortCircuitResult} */
  shortcircuit(doc, options = {}) { return this.run('shortcircuit', doc, options); }

  /** @param {PowerDocument} doc @param {OnProgress} [onProgress] @returns {import('./reports.js').ContingencyResult} */
  contingency(doc, onProgress) { return this.run('contingency', doc, {}, onProgress); }

  /** @param {PowerDocument} doc @param {Record<string, any>} [options] @param {OnProgress} [onProgress] @returns {import('./reports.js').RmsResult} */
  rms(doc, options = {}, onProgress) { return this.run('rms', doc, options, onProgress); }
}
