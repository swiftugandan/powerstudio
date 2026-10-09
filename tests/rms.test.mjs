import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRms } from '../src/core/rms.js';
import { runLoadFlow } from '../src/core/loadflow.js';
import { makeElement } from '../src/core/catalog.js';
import { emptyDocument } from '../src/core/document.js';
import { ieee14 } from '../src/samples/ieee14.js';

/** Single machine against an infinite bus over a lossless line, the textbook equal-area case. */
function smib(pm = 80) {
  const doc = emptyDocument('SMIB');
  doc.elements.push(makeElement('bus', 'G', { vn: 110 }), makeElement('bus', 'I', { vn: 110 }));
  doc.elements.push(makeElement('line', 'L', { from: 'G', to: 'I', length: 50, r1: 0, x1: 0.4, b1: 0, ratedA: 1 }));
  doc.elements.push(makeElement('gen', 'M', { bus: 'G', mode: 'PV', p: pm, vset: 1.0, sn: 100, vn: 110, xdt: 0.3, h: 4, damping: 0 }));
  doc.elements.push(makeElement('extgrid', 'X', { bus: 'I', vset: 1.0, skMax: 1e12, rxMax: 0 }));
  return doc;
}

/** Critical clearing time from the equal-area criterion for a fault at the machine terminals (Pe = 0 while it lasts). */
function analyticCct(doc) {
  const lf = runLoadFlow(doc, { tolerance: 1e-10 });
  const g = /** @type {any} */ (lf.gens[0]);
  const pm = g.p / 100, q = g.q / 100, xd = 0.3, xl = 0.4 * 50 / (110 * 110 / 100);
  const v = lf.buses[0].vm, th = lf.buses[0].va * Math.PI / 180;
  // E′ = V + j·x′d·conj(S/V)
  const ir = (pm * Math.cos(th) + q * Math.sin(th)) / v, ii = (pm * Math.sin(th) - q * Math.cos(th)) / v;
  const er = v * Math.cos(th) - xd * ii, ei = v * Math.sin(th) + xd * ir;
  const E = Math.hypot(er, ei), d0 = Math.atan2(ei, er), pmax = E * 1 / (xd + xl);
  assert.ok(Math.abs(pmax * Math.sin(d0) - pm) < 1e-9, 'operating point lies on the power-angle curve');
  const dcr = Math.acos((Math.PI - 2 * d0) * Math.sin(d0) - Math.cos(d0));
  return Math.sqrt(4 * 4 * (dcr - d0) / (2 * Math.PI * 50 * pm));
}

test('stability: the equal-area critical clearing time separates stable from unstable', () => {
  const doc = smib();
  const tcr = analyticCct(doc);
  assert.ok(tcr > 0.1 && tcr < 0.5, `tcr ${tcr}`);
  /** @param {number} clear */
  const run = clear => runRms(doc, { tEnd: 2, dt: 0.0005, events: [{ t: 0, kind: 'fault', target: 'G' }, { t: clear, kind: 'clear', target: 'G' }] });
  assert.ok(run(tcr * 0.98).stable, 'clearing 2 % before the critical time stays in step');
  assert.ok(!run(tcr * 1.02).stable, 'clearing 2 % after it loses synchronism');
});

test('stability: undisturbed operation stays at its load-flow equilibrium', () => {
  const r = runRms(ieee14(), { tEnd: 1, dt: 0.002, events: [] });
  for (const m of r.machines) {
    const spread = Math.max(...m.delta) - Math.min(...m.delta);
    assert.ok(spread < 1e-4, `${m.id} drifts ${spread}°`);
  }
});

test('stability: small oscillations follow the linearised swing frequency', () => {
  const doc = smib(50);
  const r = runRms(doc, { tEnd: 3, dt: 0.001, events: [{ t: 0, kind: 'fault', target: 'G' }, { t: 0.01, kind: 'clear', target: 'G' }] });
  const d = r.machines.find(m => m.id === 'M')?.delta ?? new Float32Array();
  // Measure the period between successive maxima after the disturbance.
  const peaks = [];
  for (let i = 1; i < d.length - 1; i++) if (d[i] > d[i - 1] && d[i] >= d[i + 1] && r.t[i] > 0.05) peaks.push(r.t[i]);
  const fMeasured = (peaks.length - 1) / (peaks[peaks.length - 1] - peaks[0]);
  const lf = runLoadFlow(doc, { tolerance: 1e-10 });
  const pm = 0.5, q = /** @type {any} */ (lf.gens[0]).q / 100, v = lf.buses[0].vm, th = lf.buses[0].va * Math.PI / 180;
  const ir = (pm * Math.cos(th) + q * Math.sin(th)) / v, ii = (pm * Math.sin(th) - q * Math.cos(th)) / v;
  const E = Math.hypot(v * Math.cos(th) - 0.3 * ii, v * Math.sin(th) + 0.3 * ir);
  const x = 0.3 + 0.4 * 50 / 121, d0 = Math.asin(pm * x / E);
  const ks = E / x * Math.cos(d0); // synchronising power coefficient
  const fExpected = Math.sqrt(2 * Math.PI * 50 * ks / (2 * 4)) / (2 * Math.PI);
  assert.ok(Math.abs(fMeasured - fExpected) / fExpected < 0.01, `${fMeasured} Hz vs ${fExpected} Hz`);
});

test('the bundled IEEE 14 disturbance is applied in order and the system stays stable', () => {
  const r = runRms(ieee14());
  assert.deepEqual(r.events.map(e => e.applied), [true, true, true]);
  assert.ok(r.stable);
  assert.equal(r.angleReference, 'coi');
  assert.ok(r.t.length > 100 && r.t[r.t.length - 1] === 3);
});
