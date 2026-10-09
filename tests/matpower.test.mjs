import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers.mjs';
import { parseMatpower, importMatpower } from '../src/core/matpower.js';
import { normalizeDocument } from '../src/core/document.js';

test('parses the matrices, base power and bus names of a version 2 case', () => {
  const m = parseMatpower(read('tests/fixtures/case14.m'));
  assert.equal(m.name, 'case14');
  assert.equal(m.baseMVA, 100);
  assert.equal(m.bus.length, 14);
  assert.equal(m.gen.length, 5);
  assert.equal(m.branch.length, 20);
  assert.equal(m.busNames[0], 'Bus 1 HV');
});

test('imports into a valid document with a drawn diagram', () => {
  const { doc, issues } = importMatpower(read('tests/fixtures/case118.m'));
  assert.ok(issues.some(i => i.includes('two shunts')), 'transformer charging is kept as shunts');
  const { issues: problems } = normalizeDocument(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(problems, []);
  const buses = doc.elements.filter(e => e.cls === 'bus');
  assert.equal(buses.length, 118);
  // Auto layout puts every bar on the grid without overlaps.
  for (const b of buses) assert.ok(Number(b.x) % 20 === 0 && Number(b.y) % 20 === 0);
  for (let i = 0; i < buses.length; i++) for (let j = i + 1; j < buses.length; j++) {
    const a = buses[i], c = buses[j];
    const apart = Math.abs(Number(a.x) - Number(c.x)) >= (Number(a.len) + Number(c.len)) / 2 || Math.abs(Number(a.y) - Number(c.y)) >= 40;
    assert.ok(apart, `${a.id} overlaps ${c.id}`);
  }
});

test('the layout is deterministic', () => {
  const a = importMatpower(read('tests/fixtures/case30.m')).doc, b = importMatpower(read('tests/fixtures/case30.m')).doc;
  assert.deepEqual(a, b);
});

test('rejects files that are not MATPOWER cases', () => {
  assert.throws(() => parseMatpower('function x = y\n'), /No mpc.bus/);
  assert.throws(() => parseMatpower('mpc.bus = [1 2 3;];'), /fewer columns/);
});
