import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studies } from './helpers.mjs';
import { ieee14 } from '../src/samples/ieee14.js';
import { riverside } from '../src/samples/riverside.js';

test('every outage equals a load flow with that element switched out', () => {
  const doc = ieee14();
  // Both sides solve tightly, so they agree whatever path each takes to the solution.
  doc.study.loadflow.tolerance = 1e-8;
  const r = studies.contingency(doc);
  assert.equal(r.cases.length, 20, 'fifteen lines and five transformers');
  for (const c of r.cases) {
    const direct = studies.loadflow(doc, { outages: new Set([c.id]) });
    assert.equal(c.converged, direct.converged);
    const worst = direct.branches.reduce((m, b) => Number.isFinite(b.loading) && b.loading > m.loading ? b : m, { loading: -Infinity, id: '' });
    assert.ok(Math.abs(c.maxLoading - worst.loading) < 1e-3, `${c.id}`);
    assert.equal(c.maxLoadingId, worst.id);
  }
});

test('losing Line 1-2 overloads Line 1-5, the known weak spot of the IEEE 14 system', () => {
  const r = studies.contingency(ieee14());
  const c = /** @type {import('../src/engine/reports.js').ContingencyCase} */ (r.cases.find(x => x.id === 'L1'));
  assert.equal(c.maxLoadingId, 'L2');
  assert.ok(c.maxLoading > 150);
  assert.ok(c.violations.some(v => v.kind === 'loading' && v.id === 'L2' && !v.inBase));
  assert.ok(r.worstLoading.L2.value >= c.maxLoading);
});

test('cases are ranked with failures first, then by number of violations', () => {
  const r = studies.contingency(ieee14());
  for (let i = 1; i < r.cases.length; i++) {
    const a = r.cases[i - 1], b = r.cases[i];
    assert.ok(Number(a.converged) <= Number(b.converged));
    if (a.converged === b.converged) assert.ok(a.violations.length >= b.violations.length);
  }
});

test('a radial outage reports the busbars it cuts off', () => {
  const r = studies.contingency(riverside());
  const c = r.cases.find(x => x.id === 'L6');
  assert.deepEqual(c?.lostBuses, ['B7']);
});

test('the study case selects which elements fail', () => {
  const doc = riverside();
  doc.study.contingency = { lines: false, trafos: true, gens: true, maxLoading: 100 };
  const r = studies.contingency(doc);
  assert.deepEqual(r.cases.map(c => c.cls).sort(), ['gen', 'trafo', 'trafo', 'trafo', 'trafo']);
});

test('a document\'s own contingencies and remedial actions run through the engine', () => {
  const doc = ieee14();
  doc.study.contingency.list = [{ id: 'C1', name: 'Both lines from bus 1', elements: ['L1', 'L2'] }];
  doc.study.contingency.remedial = [{ id: 'R1', name: 'Shed east', contingencies: ['L1'], conditions: [{ kind: 'loading', element: 'L2', above: 100 }],
    actions: ['D2', 'D3', 'D4'].map(element => ({ kind: /** @type {const} */ ('loadShed'), element, percent: 60 })) }];
  const r = studies.contingency(doc);
  const own = /** @type {import('../src/engine/reports.js').ContingencyCase} */ (r.cases.find(c => c.id === 'C1'));
  assert.equal(own.cls, 'multiple');
  assert.deepEqual(own.elements, ['L1', 'L2']);
  // Both lines are out together: neither carries flow, and the rest of the network solves without bus 1's machine.
  assert.ok(own.converged);
  assert.ok(!['L1', 'L2'].includes(own.maxLoadingId));
  const acted = /** @type {import('../src/engine/reports.js').ContingencyCase} */ (r.cases.find(c => c.id === 'L1'));
  assert.deepEqual(acted.remedial, ['R1']);
  assert.ok(acted.violationsBefore > 0);
  assert.ok(!acted.violations.some(v => v.id === 'L2' && !v.inBase), 'the action relieves Line 1-5');
  assert.ok(r.cases.filter(c => c.id !== 'L1').every(c => c.remedial.length === 0));
});

test('screening clears outages without hiding any that full AC flags', () => {
  const doc = ieee14();
  const full = studies.contingency(doc);
  doc.study.contingency.screening = true;
  const screened = studies.contingency(doc);
  assert.ok(screened.effort.screened > 0);
  for (const c of full.cases.filter(x => !x.converged || x.violations.some(v => !v.inBase))) {
    const s = /** @type {import('../src/engine/reports.js').ContingencyCase} */ (screened.cases.find(x => x.id === c.id));
    assert.equal(s.screened, false, c.id);
    assert.deepEqual(s.violations, c.violations, c.id);
  }
});
