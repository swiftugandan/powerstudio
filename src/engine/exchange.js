/** Opening other tools' files: the engine reads CGMES models, PSS/E RAW files and MATPOWER cases into its model,
 * checks it, and converts it into a PowerStudio document. The worker, the main-thread fallback and the Node tests all
 * go through here (engine/crates/ps-study/src/exchange.rs does the work; docs/ENGINE.md describes it). */

import { jsonPayload } from './host.js';

/**
 * @typedef {import('./host.js').EngineHost} EngineHost
 * @typedef {import('./reports.js').ImportSummary} ImportSummary
 * @typedef {{ name: string, bytes: Uint8Array }} NamedBytes
 */

/** File types the engine opens, for file pickers. */
export const IMPORT_TYPES = '.xml,.zip,.raw,.m';

/**
 * Imports files into a document. The engine receives them one after another in a single payload.
 * @param {EngineHost} engine @param {NamedBytes[]} files
 * @returns {{ summary: ImportSummary, doc: import('../core/document.js').PowerDocument }}
 */
export function importFiles(engine, files) {
  const size = files.reduce((n, f) => n + f.bytes.length, 0);
  const payload = new Uint8Array(size);
  let at = 0;
  for (const f of files) { payload.set(f.bytes, at); at += f.bytes.length; }
  const reply = engine.call({ op: 'import', files: files.map(f => ({ name: f.name, size: f.bytes.length })) }, payload);
  const { ok: _ok, ...summary } = /** @type {Record<string, unknown>} */ (reply.header);
  return { summary: /** @type {ImportSummary} */ (/** @type {unknown} */ (summary)), doc: jsonPayload(reply.payload) };
}
