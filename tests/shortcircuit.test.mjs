import { test } from 'node:test';
import assert from 'node:assert/strict';
import { golden, input } from './helpers.mjs';
import { runShortCircuit, kappaOf, trafoCorrection, genCorrection, voltageFactor } from '../src/core/shortcircuit.js';
import { makeElement } from '../src/core/catalog.js';
import { emptyDocument } from '../src/core/document.js';
import { riverside } from '../src/samples/riverside.js';

for (const name of ['ieee14', 'riverside']) {
  for (const fault of /** @type {const} */ (['3ph', '2ph', '1ph'])) {
    for (const mode of /** @type {const} */ (['max', 'min'])) {
      test(`${name} ${fault} ${mode}: Ik″, ip and Ith match pandapower at every busbar`, () => {
        const ref = golden(name).shortcircuit[`${fault}-${mode}`];
        const r = runShortCircuit(input(name), { fault, mode, kappa: 'C', lvTolerance: '10', location: '' });
        assert.equal(r.buses.length, Object.keys(ref).length);
        for (const b of r.buses) {
          for (const k of /** @type {const} */ (['ikss', 'ip', 'ith'])) {
            const want = ref[b.id][k];
            // pandapower reports no ip and Ith for earth faults; those values are checked through κ elsewhere.
            if (want === null) { assert.ok(k !== 'ikss' || b.ikss < 1e-6, `${b.id}: pandapower finds no fault current`); continue; }
            // Relative agreement, with an absolute floor for buses that have no zero-sequence path (≈ 0 kA).
            assert.ok(Math.abs(b[k] - want) <= 1e-9 * Math.abs(want) + 1e-7, `${b.id} ${k}: ${b[k]} vs ${want}`);
          }
        }
      });
    }
  }
}

test('IEC 60909 factors: κ, KT, KG and c follow their formulas', () => {
  assert.ok(Math.abs(kappaOf(0) - 2.0) < 1e-12);
  assert.ok(Math.abs(kappaOf(0.1) - (1.02 + 0.98 * Math.exp(-0.3))) < 1e-12);
  const t = makeElement('trafo', 'T', { uk: 10, ur: 0.6 });
  assert.ok(Math.abs(trafoCorrection(t, 1.1) - 0.95 * 1.1 / (1 + 0.6 * Math.sqrt(0.01 - 0.000036))) < 1e-12);
  const g = makeElement('gen', 'G', { vn: 10.5, xdss: 0.2, cosphi: 0.8 });
  assert.ok(Math.abs(genCorrection(g, 10, 1.1) - 10 / 10.5 * 1.1 / (1 + 0.2 * 0.6)) < 1e-12);
  assert.deepEqual(voltageFactor(20, '10'), { cmax: 1.1, cmin: 1.0 });
  assert.deepEqual(voltageFactor(0.4, '6'), { cmax: 1.05, cmin: 0.95 });
});

test('a single infeed reproduces the hand calculation Ik″ = c·Un/(√3·|ZQ|)', () => {
  const doc = emptyDocument();
  doc.elements.push(makeElement('bus', 'B1', { vn: 20 }));
  doc.elements.push(makeElement('extgrid', 'X1', { bus: 'B1', skMax: 500, rxMax: 0.1 }));
  const r = runShortCircuit(doc, { fault: '3ph', mode: 'max', location: '' });
  // ZQ = c·Un²/Sk″, so Ik″ = Sk″/(√3·Un) whatever c is.
  assert.ok(Math.abs(r.buses[0].ikss - 500 / (Math.sqrt(3) * 20)) < 1e-12);
  assert.ok(Math.abs(r.buses[0].kappa - kappaOf(0.1)) < 1e-12, 'method C on a single source equals κ(R/X)');
});

test('branch contributions add up to the fault current at the faulted busbar (Kirchhoff)', () => {
  const doc = riverside();
  const r = runShortCircuit(doc, { fault: '3ph', mode: 'max', location: 'B3' });
  assert.equal(r.buses.length, 1);
  // Mill Lane has no machine of its own, so the two cables bring the whole fault current.
  const into = r.contributions.filter(c => c.id === 'L1' || c.id === 'L2');
  const sum = into.reduce((s, c) => s + (c.id === 'L1' ? c.iTo : c.iFrom), 0);
  assert.ok(sum >= r.buses[0].ikss * (1 - 1e-9), 'magnitudes add to at least |If|');
  assert.ok(sum < r.buses[0].ikss * 1.02, `${sum} vs ${r.buses[0].ikss}: currents are nearly in phase`);
});

test('method B applies the 1.15 factor when a branch has R/X ≥ 0.3 and caps κ at 2.0', () => {
  const r = runShortCircuit(riverside(), { fault: '3ph', mode: 'max', kappa: 'B', location: 'B2' });
  const b = r.buses[0];
  assert.ok(Math.abs(b.kappa - Math.min(1.15 * kappaOf(b.rx), 2)) < 1e-12);
});
