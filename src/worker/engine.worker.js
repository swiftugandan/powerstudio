/** Calculation worker: runs the solvers off the main thread so the diagram stays responsive.
 * Messages in: { id, kind, doc, options }. Messages out: { id, type: 'progress' | 'result' | 'error', ... }. */

import { runLoadFlow } from '../core/loadflow.js';
import { runShortCircuit } from '../core/shortcircuit.js';
import { runContingency } from '../core/contingency.js';
import { runRms } from '../core/rms.js';

/** @param {{ id: number, kind: string, doc: import('../core/document.js').PowerDocument, options?: Record<string, unknown> }} msg */
function handle(msg) {
  const { id, kind, doc, options = {} } = msg;
  const progress = (/** @type {number} */ done, /** @type {number} */ total) => postMessage({ id, type: 'progress', done, total });
  const t0 = performance.now();
  let result;
  if (kind === 'loadflow') result = runLoadFlow(doc, options);
  else if (kind === 'shortcircuit') result = runShortCircuit(doc, options);
  else if (kind === 'contingency') result = runContingency(doc, { onProgress: progress });
  else if (kind === 'rms') result = runRms(doc, { ...options, onProgress: progress });
  else throw new Error(`Unknown calculation ${kind}.`);
  postMessage({ id, type: 'result', result, ms: performance.now() - t0 });
}

self.onmessage = (/** @type {MessageEvent} */ event) => {
  try { handle(event.data); }
  catch (error) { postMessage({ id: event.data.id, type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
