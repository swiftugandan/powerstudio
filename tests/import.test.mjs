import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, golden, engine } from './helpers.mjs';
import { importFiles } from '../src/engine/exchange.js';
import { normalizeDocument } from '../src/core/document.js';
import { VECTOR_GROUPS } from '../src/core/catalog.js';
import { autoLayout } from '../src/core/layout.js';

/** @param {string} name */
const file = name => ({ name, bytes: new TextEncoder().encode(read(`tests/fixtures/${name}`)) });

test('a MATPOWER case opens through the engine as a document that reproduces it exactly', () => {
  const { summary, doc } = importFiles(engine, [file('case118.m')]);
  assert.equal(summary.format, 'matpower');
  assert.equal(summary.size.nodes, 118);
  assert.ok(summary.fidelity.solved && summary.fidelity.maxDv < 1e-9, JSON.stringify(summary.fidelity));
  // The engine's document passes the editor's import gate unchanged.
  assert.deepEqual(normalizeDocument(JSON.parse(JSON.stringify(doc))).issues, []);
  assert.equal(doc.elements.filter(e => e.cls === 'bus').length, 118);
});

test('a PSS/E RAW file opens through the engine and solves to the MATPOWER solution', () => {
  // tests/fixtures/case14.raw is MATPOWER case14 written by `ps export --raw 33`.
  const { summary, doc } = importFiles(engine, [file('case14.raw')]);
  assert.equal(summary.format, 'psse');
  assert.ok(summary.report.files[0].profiles[0].includes('33'));
  assert.ok(summary.fidelity.maxDv < 1e-9);
  const g = golden('matpower-case14');
  const start = summary.fidelity.start;
  assert.equal(start.busIds.length, 14);
  g.bus.forEach((/** @type {number} */ b, /** @type {number} */ k) => {
    const i = start.busIds.indexOf(`B${b}`);
    assert.ok(Math.abs(start.vm[i] - g.vm[k]) < 1e-8 && Math.abs(start.va[i] - g.va[k]) < 1e-6, `bus ${b}`);
  });
  assert.deepEqual(normalizeDocument(JSON.parse(JSON.stringify(doc))).issues, []);
});

test('the imported diagram is laid out on the grid without overlaps, the same way every time', () => {
  const lay = () => { const { doc } = importFiles(engine, [file('case118.m')]); autoLayout(doc); return doc; };
  const a = lay(), b = lay();
  assert.deepEqual(a, b);
  const buses = a.elements.filter(e => e.cls === 'bus');
  for (const x of buses) assert.ok(Number(x.x) % 20 === 0 && Number(x.y) % 20 === 0);
  for (let i = 0; i < buses.length; i++) for (let j = i + 1; j < buses.length; j++) {
    const p = buses[i], q = buses[j];
    const apart = Math.abs(Number(p.x) - Number(q.x)) >= (Number(p.len) + Number(q.len)) / 2 || Math.abs(Number(p.y) - Number(q.y)) >= 40;
    assert.ok(apart, `${p.id} overlaps ${q.id}`);
  }
});

test('files the engine cannot read are refused with a reason', () => {
  assert.throws(() => importFiles(engine, [{ name: 'notes.txt', bytes: new TextEncoder().encode('hello') }]), /CGMES|RAW|MATPOWER/);
  assert.throws(() => importFiles(engine, [{ name: 'bad.raw', bytes: new TextEncoder().encode('0, 100, 30, 0, 0, 50\n\n\n') }]), /version/);
});

test('the engine writes only vector groups the catalogue lists', () => {
  const rust = read('engine/crates/ps-io/src/powerstudio_write.rs');
  const list = /pub const VECTOR_GROUPS: \[&str; \d+\] = \[([^\]]*)\]/s.exec(rust);
  assert.ok(list, 'VECTOR_GROUPS in powerstudio_write.rs');
  assert.deepEqual([...list[1].matchAll(/"([^"]+)"/g)].map(m => m[1]), [...VECTOR_GROUPS]);
});

test('large networks are laid out without overlaps, with neighbours near each other', () => {
  // A 30 × 20 grid network: above the size where the layout turns multilevel and removes overlaps row by row.
  /** @type {import('../src/core/catalog.js').Element[]} */
  const elements = [];
  const id = (/** @type {number} */ r, /** @type {number} */ c) => `B${r}-${c}`;
  for (let r = 0; r < 20; r++) for (let c = 0; c < 30; c++) {
    elements.push({ id: id(r, c), cls: 'bus', name: '', vn: 110 });
    if (c) elements.push({ id: `L${r}-${c}`, cls: 'line', name: '', from: id(r, c - 1), to: id(r, c) });
    if (r) elements.push({ id: `V${r}-${c}`, cls: 'line', name: '', from: id(r - 1, c), to: id(r, c) });
  }
  const doc = /** @type {any} */ ({ format: 'powerstudio', version: 1, name: 'grid', elements });
  autoLayout(doc);
  const buses = doc.elements.filter((/** @type {any} */ e) => e.cls === 'bus');
  for (let i = 0; i < buses.length; i++) for (let j = i + 1; j < buses.length; j++) {
    const p = buses[i], q = buses[j];
    const apart = Math.abs(p.x - q.x) >= (p.len + q.len) / 2 + 60 || Math.abs(p.y - q.y) >= 120;
    assert.ok(apart, `${p.id} overlaps ${q.id}`);
  }
  // The grid keeps its shape: no branch crosses more than a tenth of the drawing, and most are about one spacing.
  const at = new Map(buses.map((/** @type {any} */ b) => [b.id, b]));
  const lengths = doc.elements.filter((/** @type {any} */ e) => e.cls === 'line')
    .map((/** @type {any} */ l) => Math.hypot(at.get(l.from).x - at.get(l.to).x, at.get(l.from).y - at.get(l.to).y)).sort((a, b) => a - b);
  const xs = buses.map((/** @type {any} */ b) => b.x), ys = buses.map((/** @type {any} */ b) => b.y);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  assert.ok(lengths[lengths.length - 1] < diagonal / 10, `longest branch ${lengths[lengths.length - 1]} of ${diagonal}`);
  assert.ok(lengths[lengths.length >> 1] <= 480, `median branch ${lengths[lengths.length >> 1]}`);
});
