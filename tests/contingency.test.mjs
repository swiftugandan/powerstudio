import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runContingency } from '../src/core/contingency.js';
import { runLoadFlow } from '../src/core/loadflow.js';
import { ieee14 } from '../src/samples/ieee14.js';
import { riverside } from '../src/samples/riverside.js';

test('every outage equals a load flow with that element switched out', () => {
  const doc = ieee14();
  const r = runContingency(doc);
  assert.equal(r.cases.length, 20, 'fifteen lines and five transformers');
  for (const c of r.cases) {
    const direct = runLoadFlow(doc, { outages: new Set([c.id]) });
    assert.equal(c.converged, direct.converged);
    const worst = direct.branches.reduce((m, b) => Number.isFinite(b.loading) && b.loading > m.loading ? b : m, { loading: -Infinity, id: '' });
    assert.ok(Math.abs(c.maxLoading - worst.loading) < 1e-3, `${c.id}`);
    assert.equal(c.maxLoadingId, worst.id);
  }
});

test('losing Line 1-2 overloads Line 1-5, the known weak spot of the IEEE 14 system', () => {
  const r = runContingency(ieee14());
  const c = /** @type {import('../src/core/contingency.js').ContingencyCase} */ (r.cases.find(x => x.id === 'L1'));
  assert.equal(c.maxLoadingId, 'L2');
  assert.ok(c.maxLoading > 150);
  assert.ok(c.violations.some(v => v.kind === 'loading' && v.id === 'L2' && !v.inBase));
  assert.ok(r.worstLoading.L2.value >= c.maxLoading);
});

test('cases are ranked with failures first, then by number of violations', () => {
  const r = runContingency(ieee14());
  for (let i = 1; i < r.cases.length; i++) {
    const a = r.cases[i - 1], b = r.cases[i];
    assert.ok(Number(a.converged) <= Number(b.converged));
    if (a.converged === b.converged) assert.ok(a.violations.length >= b.violations.length);
  }
});

test('a radial outage reports the busbars it cuts off', () => {
  const r = runContingency(riverside());
  const c = r.cases.find(x => x.id === 'L6');
  assert.deepEqual(c?.lostBuses, ['B7']);
});

test('the study case selects which elements fail', () => {
  const doc = riverside();
  doc.study.contingency = { lines: false, trafos: true, gens: true, maxLoading: 100 };
  const r = runContingency(doc);
  assert.deepEqual(r.cases.map(c => c.cls).sort(), ['gen', 'trafo', 'trafo', 'trafo', 'trafo']);
});
