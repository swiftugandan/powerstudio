/** Exchanging files with other tools: the engine reads CGMES models, PSS/E RAW files and MATPOWER cases into its
 * model, checks it, and converts it into a PowerStudio document; and it writes a document as a PSS/E RAW file. The worker, the main-thread fallback and the Node tests all
 * go through here (engine/crates/ps-study/src/exchange.rs does the work; docs/ENGINE.md describes it). */

import { jsonPayload, textPayload } from './host.js';

/**
 * @typedef {import('./host.js').EngineHost} EngineHost
 * @typedef {import('./reports.js').ImportSummary} ImportSummary
 * @typedef {import('./reports.js').RawExportSummary} RawExportSummary
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

/** The PSS/E RAW versions the engine writes, newest last. */
export const RAW_VERSIONS = /** @type {const} */ ([33, 35]);

/**
 * The engine request that writes a document as a PSS/E RAW file. The document is its JSON text, as the active study
 * case composes it.
 * @param {string} docJson @param {33 | 35} rev
 * @returns {{ header: Record<string, unknown>, payload: Uint8Array }}
 */
export function rawExportRequest(docJson, rev) {
  return { header: { op: 'export_raw', rev }, payload: textPayload(docJson) };
}

/**
 * The engine's reply to {@link rawExportRequest}: what it wrote and checked, and the file.
 * @param {{ header: Record<string, unknown>, payload: Uint8Array }} reply
 * @returns {{ summary: RawExportSummary, text: string }}
 */
export function rawExportReply(reply) {
  const { ok: _ok, ...rest } = reply.header;
  const summary = /** @type {RawExportSummary} */ (/** @type {unknown} */ (rest));
  // JSON has no infinity: a difference the engine could not express arrives as null, and must not read as zero.
  const finite = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : Infinity);
  summary.check = { ...summary.check, maxDv: finite(summary.check.maxDv), maxDa: finite(summary.check.maxDa) };
  return { summary, text: new TextDecoder().decode(reply.payload) };
}

/**
 * Writes a document as a PSS/E RAW file on this thread (the app sends the same request to a worker).
 * @param {EngineHost} engine @param {string} docJson @param {33 | 35} rev
 */
export function exportRaw(engine, docJson, rev) {
  const { header, payload } = rawExportRequest(docJson, rev);
  return rawExportReply(engine.call(header, payload));
}
