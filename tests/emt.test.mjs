import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, studies, read } from './helpers.mjs';
import { jsonPayload } from '../src/engine/host.js';
import { request } from '../src/engine/studies.js';
import { normalizeDocument, completeStudy, defaultStudy } from '../src/core/document.js';
import { riverside } from '../src/samples/riverside.js';
import { ieee14 } from '../src/samples/ieee14.js';

const cases = JSON.parse(read('tests/oracle/emt-cases.json'));

/** The same tolerances as engine/crates/ps-study/tests/emt.rs: shares of the nominal crest and of each kind of
 * current's largest value in the case. */
const V_TOL = 5e-3, I_TOL = 5e-3;

/** @param {number[][]} phases */
const peak = phases => phases.reduce((m, p) => p.reduce((n, x) => Math.max(n, Math.abs(x)), m), 0);

for (const c of cases.cases) {
  test(`EMT: the WebAssembly engine agrees with ngspice on ${c.name}`, () => {
    const g = JSON.parse(read(`tests/oracle/golden/emt-${c.name}.json`));
    const k = g.case;
    const doc = JSON.parse(read(`tests/oracle/${k.input}`));
    const r = jsonPayload(request(engine, 'emt', doc, { tEnd: k.tEnd, dtUs: k.dtUs, lineModel: k.lineModel, events: k.events,
      instantSwitching: true, maxSamples: 1_000_000 }));
    const every = r.t[1] - r.t[0];
    const at = g.t.map((/** @type {number} */ t) => Math.round(t / every));
    /** @param {number[]} e @param {number[]} want @param {number} scale */
    const worst = (e, want, scale) => want.reduce((m, w, i) => Math.max(m, Math.abs(e[at[i]] - w) / scale), 0);
    let wv = 0, wi = 0;
    for (const [id, phases] of Object.entries(g.buses)) {
      const b = r.buses.find((/** @type {any} */ x) => x.id === id);
      const crest = b.kv / Math.sqrt(3) * Math.SQRT2;
      for (let p = 0; p < 3; p++) wv = Math.max(wv, worst(b.v[p], /** @type {number[][]} */ (phases)[p], crest));
    }
    const scale = Math.max(...Object.values(g.branches).map(p => peak(/** @type {number[][]} */ (p))));
    for (const [id, phases] of Object.entries(g.branches)) {
      const b = r.branches.find((/** @type {any} */ x) => x.id === id);
      for (let p = 0; p < 3; p++) wi = Math.max(wi, worst(b.from[p], /** @type {number[][]} */ (phases)[p], scale));
    }
    for (const [id, phases] of Object.entries(g.faults)) {
      const f = r.faults.find((/** @type {any} */ x) => x.target === id);
      const fs = peak(/** @type {number[][]} */ (phases));
      for (let p = 0; p < 3; p++) wi = Math.max(wi, worst(f.i[p], /** @type {number[][]} */ (phases)[p], fs));
    }
    assert.ok(wv < V_TOL, `voltages differ by ${wv.toExponential(2)} of crest`);
    assert.ok(wi < I_TOL, `currents differ by ${wi.toExponential(2)}`);
  });
}

test('EMT: the samples simulate their own events, and the result arrives as typed arrays', () => {
  for (const doc of [riverside(), ieee14()]) {
    const r = studies.emt(doc, {});
    assert.ok(r.t instanceof Float32Array && r.t.length > 1000);
    assert.ok(r.buses.every(b => b.v.every(p => p instanceof Float32Array && p.length === r.t.length)));
    assert.ok(r.branches.every(b => b.from[0].length === r.t.length && b.to[2].length === r.t.length));
    assert.ok(r.events.every(e => e.applied), JSON.stringify(r.events.filter(e => !e.applied)));
    assert.equal(r.faults.length, 1);
    const f = r.faults[0];
    assert.ok(f.peak > 1 && Number.isFinite(f.rms) && f.tOff !== null && f.tOff > f.tOn, JSON.stringify({ ...f, i: undefined }));
    // Every pole of a trip opened at a current zero.
    assert.ok(r.operations.length >= 3);
    assert.ok(r.initialMismatch < 1e-3, `${r.initialMismatch}`);
  }
});

test('EMT: an undisturbed network keeps its load-flow voltages', () => {
  const doc = riverside();
  doc.study.emt.events = [];
  const r = studies.emt(doc, { tEnd: 0.06, lineModel: 'pi' });
  const lf = studies.loadflow(doc);
  for (const b of r.buses) {
    const vm = lf.buses.find(x => x.id === b.id)?.vm ?? NaN;
    assert.ok(Math.abs(b.rmsMin - vm) < 1e-4 && Math.abs(b.rmsMax - vm) < 1e-4, `${b.id}: ${b.rmsMin}…${b.rmsMax} vs ${vm}`);
  }
});

test('EMT: study case events pass the import gate, and older study cases gain the EMT settings', () => {
  const doc = riverside();
  const raw = JSON.parse(JSON.stringify(doc));
  raw.study.emt.events.push({ t: 0.03, kind: 'fault', target: 'B3', fault: '2phg', r: 1.5 }, { t: -1, kind: 'trip', target: 'L1' },
    { t: 0.04, kind: 'explode', target: 'L1' }, { t: 0.05, kind: 'trip', target: 'nowhere' }, { t: 0.06, kind: 'fault', target: 'B3', fault: 'zigzag', r: -2 });
  const { doc: back, issues } = normalizeDocument(raw);
  assert.equal(issues.filter(i => /invalid EMT event/.test(i)).length, 3);
  assert.deepEqual(back.study.emt.events.find(e => e.t === 0.03), { t: 0.03, kind: 'fault', target: 'B3', fault: '2phg', r: 1.5 });
  // A fault of an unknown kind and a negative resistance keep the event as a three-phase bolted fault.
  assert.deepEqual(back.study.emt.events.find(e => e.t === 0.06), { t: 0.06, kind: 'fault', target: 'B3' });
  assert.deepEqual(back.study.emt.events.map(e => e.t), [...back.study.emt.events.map(e => e.t)].sort((a, b) => a - b));
  const old = /** @type {any} */ (JSON.parse(JSON.stringify(defaultStudy())));
  delete old.emt;
  old.rms.tEnd = 7;
  const done = completeStudy(old);
  assert.equal(done.rms.tEnd, 7);
  assert.deepEqual(done.emt, defaultStudy().emt);
});

test('EMT: deleting an element drops its events', async () => {
  const { DocumentStore } = await import('../src/core/store.js');
  const store = new DocumentStore(riverside());
  assert.ok(store.doc.study.emt.events.some(e => e.target === 'S1'));
  store.transact('Delete', tx => tx.remove('S1'));
  assert.ok(!store.doc.study.emt.events.some(e => e.target === 'S1'));
  store.undo();
  assert.ok(store.doc.study.emt.events.some(e => e.target === 'S1'));
});
