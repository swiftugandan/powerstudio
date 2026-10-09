/** Calculation worker: one engine instance, so the diagram stays responsive while it computes.
 * Messages in: `{ type: 'init', module }` once, then `{ id, kind, doc, options }` for a study or `{ id, type: 'import',
 * files }` to open other tools' files. Messages out: `{ id, type: 'progress', done, total }`, then `{ id, type: 'result',
 * bytes, ms }` (the JSON report, transferred; an import adds its `summary` and sends the laid-out document as `bytes`) or
 * `{ id, type: 'error', message }`. */

import { EngineHost } from '../engine/host.js';
import { request } from '../engine/studies.js';
import { importFiles } from '../engine/exchange.js';
import { autoLayout } from '../core/layout.js';

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
    if (msg.type === 'import') {
      const { summary, doc: imported } = importFiles(host, msg.files);
      // Laid out here, so a large network does not hold up the page.
      autoLayout(imported);
      const bytes = new TextEncoder().encode(JSON.stringify(imported));
      postMessage({ id, type: 'result', bytes, summary, ms: performance.now() - t0 }, [bytes.buffer]);
      return;
    }
    const bytes = request(host, kind, doc, options, (done, total) => postMessage({ id, type: 'progress', done, total }));
    postMessage({ id, type: 'result', bytes, ms: performance.now() - t0 }, [bytes.buffer]);
  } catch (error) {
    postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
