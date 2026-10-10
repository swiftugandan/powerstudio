import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, engine, wasmPath } from './helpers.mjs';
import { EngineHost, jsonPayload } from '../src/engine/host.js';
import { request, requestOpen, openDocument, editDocument, study } from '../src/engine/studies.js';
import { createHash } from 'node:crypto';
import { applyOp } from '../src/core/store.js';

/** The requests compared: every study on every oracle input, with the simulation shortened to keep the run quick. */
const REQUESTS = /** @type {Array<[string, Record<string, unknown>]>} */ ([
  ['loadflow', {}],
  ['loadflow', { enforceQLimits: true, tolerance: 1e-9 }],
  ['shortcircuit', { fault: '3ph' }],
  ['shortcircuit', { fault: '1ph', mode: 'min', kappa: 'B' }],
  ['contingency', {}],
  ['rms', { tEnd: 0.5 }],
]);
const INPUTS = ['ieee14', 'ieee14-qlim', 'riverside'];

/** Drops the timing fields, which measure the machine rather than the result. @param {any} v @returns {any} */
function withoutTiming(v) {
  if (Array.isArray(v)) return v.map(withoutTiming);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'timing').map(([k, x]) => [k, withoutTiming(x)]));
  return v;
}

/** Largest relative difference between two reports of the same shape; throws when their structure differs.
 * @param {any} a @param {any} b @param {string} path @returns {number} */
function difference(a, b, path) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, `${path}: lengths differ`);
    return a.reduce((m, x, i) => Math.max(m, difference(x, b[i], `${path}[${i}]`)), 0);
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: fields differ`);
    return Object.keys(a).reduce((m, k) => Math.max(m, difference(a[k], b[k], `${path}.${k}`)), 0);
  }
  assert.equal(a, b, path);
  return 0;
}

test('the browser engine (WebAssembly) and the native engine agree on every study', () => {
  execFileSync('cargo', ['build', '--release', '--locked', '-q', '-p', 'ps-cli'], { cwd: join(root, 'engine'), stdio: 'inherit' });
  const cli = join(root, 'engine', 'target', 'release', 'ps');
  let worst = 0;
  for (const name of INPUTS) {
    const file = join(root, 'tests', 'oracle', 'inputs', `${name}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    for (const [kind, options] of REQUESTS) {
      const native = JSON.parse(execFileSync(cli, ['study', kind, file, '--options', JSON.stringify(options)], { encoding: 'utf8', maxBuffer: 1 << 28 }));
      const wasm = jsonPayload(request(engine, kind, doc, options));
      worst = Math.max(worst, difference(withoutTiming(native), withoutTiming(wasm), `${name} ${kind}`));
    }
  }
  // Native builds may fuse multiply-adds that WebAssembly evaluates in two roundings; the reports agree to rounding.
  assert.ok(worst < 1e-9, `largest relative difference ${worst}`);
});

test('the engine is deterministic: the same request gives the same bytes, on one instance and on a fresh one', async () => {
  const fresh = await EngineHost.create(readFileSync(wasmPath));
  for (const name of INPUTS) {
    const doc = JSON.parse(readFileSync(join(root, 'tests', 'oracle', 'inputs', `${name}.json`), 'utf8'));
    for (const [kind, options] of REQUESTS) {
      const runs = [request(engine, kind, doc, options), request(engine, kind, doc, options), request(fresh, kind, doc, options)]
        .map(bytes => JSON.stringify(withoutTiming(jsonPayload(bytes))));
      assert.equal(runs[1], runs[0], `${name} ${kind} on one instance`);
      assert.equal(runs[2], runs[0], `${name} ${kind} on a fresh instance`);
    }
  }
});

test('engine errors arrive as messages and leave the instance usable', () => {
  assert.throws(() => engine.call({ op: 'study', kind: 'loadflow', options: { colour: 1 } }, new TextEncoder().encode(read('ieee14'))), /invalid options/);
  assert.throws(() => engine.call({ op: 'study', kind: 'loadflow' }, new TextEncoder().encode('{')), /not valid JSON/);
  assert.throws(() => engine.call({ op: 'nothing' }), /unknown op/);
  assert.ok(jsonPayload(request(engine, 'loadflow', JSON.parse(read('ieee14')), {})).converged);
});

test('a document held open and edited in the engine gives the same results as the edited document sent whole', async () => {
  const held = await EngineHost.create(readFileSync(wasmPath));
  for (const name of INPUTS) {
    const text = read(name);
    /** @type {import('../src/core/document.js').PowerDocument} */
    const doc = JSON.parse(text);
    const index = new Map(doc.elements.map(e => [e.id, e]));
    openDocument(held, text);
    const loads = doc.elements.filter(e => e.cls === 'load');
    const [first, second] = loads;
    /** @type {import('../src/core/store.js').Op[]} */
    const ops = [
      { type: 'set', id: first.id, key: 'p', before: first.p, after: Number(first.p) * 1.1 },
      { type: 'remove', el: second },
      { type: 'add', index: doc.elements.length - 1, el: { ...second, id: `${second.id}-new` } },
      { type: 'study', section: 'loadflow', key: 'tolerance', before: doc.study.loadflow.tolerance, after: 1e-4 },
    ];
    // The engine applies the operations as the editor does, so the two documents agree.
    for (const op of ops) applyOp(doc, index, op);
    editDocument(held, ops);
    for (const [kind, options] of REQUESTS) {
      const open = JSON.stringify(withoutTiming(jsonPayload(requestOpen(held, kind, options))));
      const whole = JSON.stringify(withoutTiming(jsonPayload(request(engine, kind, doc, options))));
      assert.equal(open, whole, `${name} ${kind}`);
    }
  }
  // An edit that does not apply leaves no document open, so a study on it fails until the document comes again.
  assert.throws(() => editDocument(held, [{ type: 'set', id: 'nowhere', key: 'p', before: 0, after: 1 }]), /unknown element/);
  assert.throws(() => requestOpen(held, 'loadflow', {}), /no document is open/);
  openDocument(held, read('ieee14'));
  assert.ok(jsonPayload(requestOpen(held, 'loadflow', {})).converged);
});

test('run records: the engine hashes the model, the study case and the report, the same way every time', () => {
  const doc = JSON.parse(read('ieee14'));
  const a = study(engine, 'loadflow', doc, {}, undefined, { record: true }), b = study(engine, 'loadflow', doc, {}, undefined, { record: true });
  assert.deepEqual(a.header.record, b.header.record);
  assert.match(a.header.record.results, /^[0-9a-f]{64}$/);
  assert.notEqual(a.header.record.results, createHash('sha256').update(a.payload).digest('hex'), 'the timings are left out');
  assert.match(a.header.record.model, /^[0-9a-f]{64}$/);
  assert.match(a.header.record.engine, /^\d+\.\d+\.\d+$/);
  // Moving a busbar on the diagram leaves the model's hash; changing a load does not.
  const moved = structuredClone(doc);
  moved.elements.find((/** @type {any} */ e) => e.cls === 'bus').x += 100;
  assert.equal(study(engine, 'loadflow', moved, {}, undefined, { record: true }).header.record.model, a.header.record.model);
  const loaded = structuredClone(doc);
  loaded.elements.find((/** @type {any} */ e) => e.cls === 'load').p += 1;
  assert.notEqual(study(engine, 'loadflow', loaded, {}, undefined, { record: true }).header.record.model, a.header.record.model);
  assert.equal(study(engine, 'loadflow', doc, {}).header.record, undefined, 'no record unless asked');
});

/** @param {string} name */
function read(name) { return readFileSync(join(root, 'tests', 'oracle', 'inputs', `${name}.json`), 'utf8'); }
