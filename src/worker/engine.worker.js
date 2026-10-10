/** Calculation worker: one engine instance, so the diagram stays responsive while it computes, and its own copy of the
 * document the page is editing.
 * Messages in: `{ type: 'init', module }` once; `{ type: 'doc', json, key }` (a document) and `{ type: 'ops', ops, key }`
 * (the store's edits, applied to the copy); `{ id, kind, key, options }` for a study on the copy (or `{ id, kind, doc,
 * options }` on a document sent with it); `{ id, type: 'import', files }` to open other tools' files. Messages out:
 * `{ id, type: 'progress', done, total }`, then `{ id, type: 'result', bytes, ms }` (the JSON report, transferred; an
 * import adds its `summary` and sends the laid-out document as `bytes`) or `{ id, type: 'error', message }`. */

import { EngineHost } from '../engine/host.js';
import { request } from '../engine/studies.js';
import { importFiles } from '../engine/exchange.js';
import { autoLayout } from '../core/layout.js';
import { applyOp } from '../core/store.js';

/** @type {Promise<EngineHost> | null} */
let engine = null;
/** The page's document as this worker holds it, its id index, and the state it is at. */
/** @type {import('../core/document.js').PowerDocument | null} */
let doc = null;
/** @type {Map<string, import('../core/catalog.js').Element>} */
let index = new Map();
let key = '';

self.onmessage = async (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    engine = EngineHost.create(msg.module);
    return;
  }
  if (msg.type === 'doc') {
    doc = JSON.parse(msg.json);
    index = new Map(doc?.elements.map(e => [e.id, e]));
    key = msg.key;
    return;
  }
  if (msg.type === 'ops') {
    if (doc) for (const op of msg.ops) applyOp(doc, index, op);
    key = msg.key;
    return;
  }
  const { id, kind, options = {} } = msg;
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
    const subject = 'doc' in msg ? msg.doc : msg.key === key ? doc : null;
    if ('key' in msg && !subject) throw new Error('The calculation worker does not hold the current document.');
    const bytes = request(host, kind, subject, options, (done, total) => postMessage({ id, type: 'progress', done, total }));
    postMessage({ id, type: 'result', bytes, ms: performance.now() - t0 }, [bytes.buffer]);
  } catch (error) {
    postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
