import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, golden, input, studies, engine } from './helpers.mjs';
import { importFiles } from '../src/engine/exchange.js';
import { busesOf } from '../src/core/document.js';
import { ieee14 } from '../src/samples/ieee14.js';
import { riverside } from '../src/samples/riverside.js';

/** @param {import('../src/engine/reports.js').LoadFlowResult} r @param {{ bus: number[], vm: number[], va: number[] }} g */
function worstBusError(r, g) {
  let dv = 0, da = 0;
  g.bus.forEach((b, k) => {
    const x = r.buses.find(y => y.id === `B${b}`);
    assert.ok(x, `bus ${b} missing`);
    dv = Math.max(dv, Math.abs(x.vm - g.vm[k]));
    da = Math.max(da, Math.abs(x.va - g.va[k]));
  });
  return { dv, da };
}

for (const c of ['case14', 'case30', 'case118']) {
  test(`MATPOWER ${c}: imported network solves to the PYPOWER (MATPOWER) solution`, () => {
    const { doc } = importFiles(engine, [{ name: `${c}.m`, bytes: new TextEncoder().encode(read(`tests/fixtures/${c}.m`)) }]);
    const r = studies.loadflow(doc, { tolerance: 1e-8 });
    assert.ok(r.converged, r.message);
    const { dv, da } = worstBusError(r, golden(`matpower-${c}`));
    assert.ok(dv < 1e-9, `|ΔV| ${dv}`);
    assert.ok(da < 1e-7, `|Δθ| ${da}°`);
  });
}

test('IEEE 14 sample: engineering data reproduces MATPOWER case14 exactly', () => {
  const r = studies.loadflow(ieee14(), { tolerance: 1e-8 });
  assert.ok(r.converged);
  const { dv, da } = worstBusError(r, golden('matpower-case14'));
  assert.ok(dv < 1e-9 && da < 1e-7, `${dv} ${da}`);
  // The published IEEE solution, rounded to three decimals in the CDF file, as a sanity check of the reference.
  assert.ok(Math.abs(/** @type {any} */ (r.buses.find(b => b.id === 'B14')).vm - 1.036) < 0.001);
  assert.ok(Math.abs(r.totals.losses - 13.393) < 0.001, `losses ${r.totals.losses}`);
});

for (const [name, enforce] of [['ieee14', false], ['riverside', false], ['riverside', true], ['ieee14-qlim', true]]) {
  test(`${name}${enforce ? ' with reactive limits' : ''}: bus voltages, branch flows and machine outputs match pandapower`, () => {
    const doc = input(/** @type {string} */ (name));
    const ref = golden(/** @type {string} */ (name)).loadflow[enforce ? 'qlim' : 'base'];
    const r = studies.loadflow(doc, { tolerance: 1e-9, enforceQLimits: /** @type {boolean} */ (enforce) });
    assert.ok(r.converged, r.message);
    for (const b of r.buses) {
      assert.ok(Math.abs(b.vm - ref.bus[b.id][0]) < 1e-9, `${b.id} vm`);
      assert.ok(Math.abs(b.va - ref.bus[b.id][1]) < 1e-7, `${b.id} va`);
    }
    for (const br of r.branches) {
      const x = br.cls === 'line' ? ref.line[br.id] : ref.trafo[br.id];
      for (const [k, v] of [br.pFrom, br.qFrom, br.pTo, br.qTo].entries()) assert.ok(Math.abs(v - x[k]) < 1e-6, `${br.id} flow ${k}: ${v} vs ${x[k]}`);
      if (br.cls === 'line') assert.ok(Math.abs(Math.max(br.iFrom, br.iTo) - x[4]) < 1e-9, `${br.id} current`);
    }
    for (const g of r.gens) {
      assert.ok(Math.abs(g.p - ref.gen[g.id][0]) < 1e-6, `${g.id} P`);
      assert.ok(Math.abs(g.q - ref.gen[g.id][1]) < 1e-6, `${g.id} Q`);
    }
  });
}

test('reactive limits: violating machines are held at their limit, with the cascade pandapower finds', () => {
  const r = studies.loadflow(input('ieee14-qlim'), { enforceQLimits: true });
  const held = Object.fromEntries(r.gens.filter(g => g.atLimit).map(g => [g.id, g.q]));
  assert.deepEqual(Object.keys(held).sort(), ['G2', 'G4', 'G5']);
  assert.ok(Math.abs(held.G4 - 8) < 1e-9 && Math.abs(held.G5 - 10) < 1e-9 && Math.abs(held.G2 - 50) < 1e-9);
});

test('the solution satisfies power balance at every bus (independent of the solver)', () => {
  for (const doc of [ieee14(), riverside()]) {
    const r = studies.loadflow(doc, { tolerance: 1e-9 });
    // Branch flows leaving each bus plus its shunts' consumption must equal its generation minus its load.
    const byId = new Map(doc.elements.map(e => [e.id, e]));
    const out = new Map(r.buses.map(b => [b.id, { p: 0, q: 0 }]));
    const at = (/** @type {string} */ id) => /** @type {{ p: number, q: number }} */ (out.get(id));
    for (const br of r.branches) {
      const [a, b] = busesOf(/** @type {any} */ (byId.get(br.id)));
      at(a).p += br.pFrom; at(a).q += br.qFrom; at(b).p += br.pTo; at(b).q += br.qTo;
    }
    for (const s of r.shunts) { const bus = /** @type {string} */ (byId.get(s.id)?.bus); at(bus).p += s.p; at(bus).q -= s.q; }
    for (const u of [...r.gens, ...r.grids]) { const bus = /** @type {string} */ (byId.get(u.id)?.bus); at(bus).p -= u.p; at(bus).q -= u.q; }
    for (const l of r.loads) { const bus = /** @type {string} */ (byId.get(l.id)?.bus); at(bus).p += l.p; at(bus).q += l.q; }
    for (const [id, v] of out) {
      assert.ok(Math.abs(v.p) < 1e-6, `${doc.name} bus ${id} P ${v.p}`);
      assert.ok(Math.abs(v.q) < 1e-6, `${doc.name} bus ${id} Q ${v.q}`);
    }
    assert.ok(Math.abs(r.totals.generation - r.totals.load - r.totals.losses) < 1e-6);
  }
});

test('flat start and DC start reach the same solution on the IEEE 14 system', () => {
  const a = studies.loadflow(ieee14(), { tolerance: 1e-10, dcStart: false });
  const b = studies.loadflow(ieee14(), { tolerance: 1e-10, dcStart: true });
  a.buses.forEach((x, i) => assert.ok(Math.abs(x.vm - b.buses[i].vm) < 1e-10 && Math.abs(x.va - b.buses[i].va) < 1e-8));
});

test('a warm start from a previous result converges in fewer iterations', () => {
  const doc = riverside();
  const base = studies.loadflow(doc, { tolerance: 1e-8 });
  const warm = studies.loadflow(doc, { tolerance: 1e-8, start: { busIds: base.busIds, vm: base.state.vm, va: base.state.va } });
  assert.ok(warm.converged && warm.iterations <= 1, `iterations ${warm.iterations}`);
});

test('busbars cut off from every source are de-energised and excluded', () => {
  const doc = riverside();
  for (const el of doc.elements) if (el.id === 'L6') el.inService = false; // Brook Farm hangs off L6 only
  const r = studies.loadflow(doc);
  assert.ok(r.converged);
  assert.deepEqual(r.deenergized, ['B7']);
  assert.ok(!r.buses.some(b => b.id === 'B7'));
});

test('an island with machines but no reference gets its largest machine as reference', () => {
  const doc = riverside();
  for (const el of doc.elements) if (el.id === 'L5') el.inService = false; // Hilltop, the CHP and Brook Farm become an island
  const r = studies.loadflow(doc);
  assert.ok(r.converged, r.message);
  assert.ok(r.warnings.some(w => w.includes('Hilltop CHP')));
  assert.equal(r.deenergized.length, 0);
});

test('load scaling multiplies every load', () => {
  const r = studies.loadflow(ieee14(), { loadScale: 1.1 });
  assert.ok(Math.abs(r.totals.load - 259 * 1.1) < 1e-9);
});
