import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeElement } from '../src/core/catalog.js';
import { normalizeDocument, validateForCalculation, nextId, emptyDocument } from '../src/core/document.js';
import { ieee14 } from '../src/samples/ieee14.js';
import { riverside } from '../src/samples/riverside.js';

test('the samples survive a JSON round trip through the import gate unchanged', () => {
  for (const doc of [ieee14(), riverside()]) {
    const { doc: back, issues } = normalizeDocument(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(issues, []);
    assert.deepEqual(back, doc);
  }
});

test('imports repair what they can and report every change', () => {
  const raw = JSON.parse(JSON.stringify(riverside()));
  raw.elements.push({ id: 'Z1', cls: 'spaceship' });
  raw.elements.push({ id: 'L99', cls: 'line', from: 'B2', to: 'NOPE' });
  raw.elements.find((/** @type {any} */ e) => e.id === 'D1').p = 'lots';
  raw.elements.find((/** @type {any} */ e) => e.id === 'L1').length = -3;
  raw.study.loadflow.maxIter = 0;
  const { doc, issues } = normalizeDocument(raw);
  assert.equal(doc.elements.find(e => e.id === 'D1')?.p, 10, 'invalid value replaced by the default');
  assert.equal(doc.elements.find(e => e.id === 'L1')?.length, 10);
  assert.ok(!doc.elements.some(e => e.id === 'Z1' || e.id === 'L99'));
  assert.equal(doc.study.loadflow.maxIter, 30);
  assert.equal(issues.length, 5, issues.join('\n'));
});

test('refuses files that are not PowerStudio documents or come from a newer version', () => {
  assert.throws(() => normalizeDocument({ hello: 1 }), /not a PowerStudio document/);
  assert.throws(() => normalizeDocument({ format: 'powerstudio', version: 99 }), /newer/);
});

test('a line between voltage levels is reported before any calculation', () => {
  const doc = riverside();
  const line = /** @type {any} */ (doc.elements.find(e => e.id === 'L5'));
  line.to = 'B1';
  assert.match(validateForCalculation(doc)[0], /different nominal voltages/);
});

test('new ids continue after the highest one in use', () => {
  assert.equal(nextId(['B1', 'B9', 'L3', 'B10x'], 'bus'), 'B10');
  assert.equal(nextId([], 'trafo'), 'T1');
});

test('a simulation needs consistent round-rotor data; other calculations do not', () => {
  const doc = emptyDocument('Rotor');
  doc.elements.push(makeElement('bus', 'B', { vn: 10 }), makeElement('gen', 'G', { bus: 'B', machineModel: 'roundRotor', xdss: 0.12, xl: 0.15 }));
  assert.deepEqual(validateForCalculation(doc, 'loadflow'), []);
  assert.match(validateForCalculation(doc, 'rms')[0], /leakage reactance Xl \(0.15 p.u.\) must be below X″d \(0.12 p.u.\)/);
  doc.elements[1].xl = 0.1;
  assert.deepEqual(validateForCalculation(doc, 'rms'), []);
});
