/** Calculation worker: one engine instance, so the diagram stays responsive while it computes. The engine holds the
 * document the page is editing open and applies the page's edits to it, so a calculation sends neither.
 * Messages in: `{ type: 'init', module }` once; `{ type: 'doc', json, key }` (a document, as JSON text) and
 * `{ type: 'ops', ops, key }` (the store's edits); `{ id, kind, key, options, record }` for a study on the open document
 * (or `{ id, kind, doc, options, record }` on a document sent with it); `{ id, type: 'import', files }` to open other
 * tools' files; `{ id, type: 'layout', json }` to lay a document out; `{ id, type: 'call', header, payload }` for any
 * other engine operation. Messages out: `{ id, type: 'progress', done,
 * total }`, then `{ id, type: 'result', bytes, record, ms }` (the JSON report, transferred, and with `record` the run
 * record's hashes; an import adds its `summary` and sends the laid-out document as `bytes`) or `{ id, type: 'error',
 * message, stale }`, where `stale` says the engine does not hold the document state the study named. */

import { EngineHost } from '../engine/host.js';
import { study, openDocument, editDocument } from '../engine/studies.js';
import { importFiles } from '../engine/exchange.js';
import { autoLayout, laidOut, drawingOf } from '../core/layout.js';

/** @type {Promise<EngineHost> | null} */
let engine = null;
/** The state of the page's document the engine holds open ('' when it holds none), and why opening or editing it
 * last failed. */
let key = '';
let failure = '';

self.onmessage = async (/** @type {MessageEvent} */ event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    engine = EngineHost.create(msg.module);
    return;
  }
  if (msg.type === 'doc' || msg.type === 'ops') {
    // Messages run in order, so an edit never overtakes the document it applies to. One that fails leaves no document
    // open; the next study then reports it stale and the page sends the document again.
    try {
      if (!engine) throw new Error('The calculation engine was not started.');
      const host = await engine;
      key = '';
      if (msg.type === 'doc') openDocument(host, msg.json); else editDocument(host, msg.ops);
      key = msg.key;
      failure = '';
    } catch (error) {
      key = '';
      failure = error instanceof Error ? error.message : String(error);
    }
    return;
  }
  const { id, kind, options = {} } = msg;
  try {
    if (!engine) throw new Error('The calculation engine was not started.');
    const host = await engine;
    const t0 = performance.now();
    if (msg.type === 'call') {
      // Any other engine operation: the header and payload as given, the reply's header and payload back.
      const reply = host.call(msg.header, msg.payload);
      const bytes = reply.payload;
      postMessage({ id, type: 'result', bytes, header: reply.header, ms: performance.now() - t0 }, [bytes.buffer]);
      return;
    }
    if (msg.type === 'layout') {
      const bytes = new TextEncoder().encode(JSON.stringify(drawingOf(laidOut(msg.json))));
      postMessage({ id, type: 'result', bytes, ms: performance.now() - t0 }, [bytes.buffer]);
      return;
    }
    if (msg.type === 'import') {
      const { summary, doc: imported } = importFiles(host, msg.files);
      // Laid out here, so a large network does not hold up the page.
      autoLayout(imported);
      const bytes = new TextEncoder().encode(JSON.stringify(imported));
      postMessage({ id, type: 'result', bytes, summary, ms: performance.now() - t0 }, [bytes.buffer]);
      return;
    }
    const progress = (/** @type {number} */ done, /** @type {number} */ total) => postMessage({ id, type: 'progress', done, total });
    if ('key' in msg && msg.key !== key) {
      postMessage({ id, type: 'error', message: failure || 'The calculation worker does not hold the current document.', stale: true });
      return;
    }
    const reply = 'key' in msg
      ? study(host, kind, null, options, progress, { resident: true, record: !!msg.record })
      : study(host, kind, msg.doc, options, progress, { record: !!msg.record });
    const bytes = reply.payload;
    postMessage({ id, type: 'result', bytes, record: reply.header.record, ms: performance.now() - t0 }, [bytes.buffer]);
  } catch (error) {
    postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
