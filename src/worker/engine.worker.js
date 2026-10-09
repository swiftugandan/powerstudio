/** Calculation worker: one engine instance, so the diagram stays responsive while it computes.
 * Messages in: `{ type: 'init', module }` once, then `{ id, kind, doc, options }`. Messages out: `{ id, type: 'progress',
 * done, total }`, then `{ id, type: 'result', bytes, ms }` (the JSON report, transferred) or `{ id, type: 'error', message }`. */

import { EngineHost } from '../engine/host.js';
import { request } from '../engine/studies.js';

/** @type {Promise<EngineHost> | null} */
let engine = null;

self.onmessage = async (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    engine = EngineHost.create(msg.module);
    return;
  }
  const { id, kind, doc, options = {} } = msg;
  try {
    if (!engine) throw new Error('The calculation engine was not started.');
    const host = await engine;
    const t0 = performance.now();
    const bytes = request(host, kind, doc, options, (done, total) => postMessage({ id, type: 'progress', done, total }));
    postMessage({ id, type: 'result', bytes, ms: performance.now() - t0 }, [bytes.buffer]);
  } catch (error) {
    postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
