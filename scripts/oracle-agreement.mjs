#!/usr/bin/env node
/** Prints, as Markdown, how closely PowerStudio's results agree with the committed oracle goldens: the largest
 * differences per comparison. docs/TEST-REPORT.md quotes this output. */
import { readFileSync } from 'node:fs';
import { EngineHost } from '../src/engine/host.js';
import { Studies } from '../src/engine/studies.js';
import { importMatpower } from '../src/core/matpower.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** The engine the app ships, built by npm run build:engine. */
const engine = new Studies(await EngineHost.create(readFileSync(new URL('../src/engine/powerstudio-engine.wasm', import.meta.url))));
const golden = (/** @type {string} */ n) => JSON.parse(read(`tests/oracle/golden/${n}.json`));
const input = (/** @type {string} */ n) => JSON.parse(read(`tests/oracle/inputs/${n}.json`));
const e = (/** @type {number} */ v) => v.toExponential(1);

console.log('| Comparison | Reference | Largest difference |');
console.log('| --- | --- | --- |');
for (const c of ['case14', 'case30', 'case118']) {
  const g = golden(`matpower-${c}`);
  const t0 = performance.now();
  const r = engine.loadflow(importMatpower(read(`tests/fixtures/${c}.m`)).doc, { tolerance: 1e-8 });
  const ms = performance.now() - t0;
  let dv = 0, da = 0;
  g.bus.forEach((/** @type {number} */ b, /** @type {number} */ k) => { const x = /** @type {any} */ (r.buses.find(y => y.id === `B${b}`)); dv = Math.max(dv, Math.abs(x.vm - g.vm[k])); da = Math.max(da, Math.abs(x.va - g.va[k])); });
  console.log(`| Load flow, MATPOWER ${c} (${g.bus.length} buses, import and solve ${ms.toFixed(1)} ms) | PYPOWER 5.1.21 | ${e(dv)} p.u., ${e(da)}° |`);
}
for (const [name, q] of /** @type {Array<[string, boolean]>} */ ([['ieee14', false], ['riverside', false], ['riverside', true], ['ieee14-qlim', true]])) {
  const ref = golden(name).loadflow[q ? 'qlim' : 'base'];
  const r = engine.loadflow(input(name), { tolerance: 1e-9, enforceQLimits: q });
  let dv = 0, dp = 0;
  for (const b of r.buses) dv = Math.max(dv, Math.abs(b.vm - ref.bus[b.id][0]));
  for (const br of r.branches) { const x = br.cls === 'line' ? ref.line[br.id] : ref.trafo[br.id]; dp = Math.max(dp, ...[br.pFrom, br.qFrom, br.pTo, br.qTo].map((v, k) => Math.abs(v - x[k]))); }
  console.log(`| Load flow, ${name}${q ? ', reactive limits' : ''} | pandapower 3.5.6 | ${e(dv)} p.u., ${e(dp)} MW or Mvar |`);
}
for (const name of ['ieee14', 'riverside']) {
  for (const fault of /** @type {const} */ (['3ph', '2ph', '1ph'])) {
    let worst = 0;
    for (const mode of /** @type {const} */ (['max', 'min'])) {
      const ref = golden(name).shortcircuit[`${fault}-${mode}`];
      for (const b of engine.shortcircuit(input(name), { fault, mode, kappa: 'C', lvTolerance: '10', location: '' }).buses) {
        for (const k of /** @type {const} */ (['ikss', 'ip', 'ith'])) {
          const want = ref[b.id][k];
          if (want === null || Math.abs(want) < 1e-3) continue;
          worst = Math.max(worst, Math.abs(b[k] - want) / Math.abs(want));
        }
      }
    }
    const what = fault === '1ph' ? 'Ik″' : 'Ik″, ip, Ith';
    console.log(`| Short circuit, ${name}, ${fault}, max and min: ${what} | pandapower 3.5.6 | ${e(worst)} relative |`);
  }
}
