#!/usr/bin/env node
/** Writes the bundled samples to tests/oracle/inputs/ so scripts/oracle/oracle.py can rebuild them in pandapower.
 * tests/oracle.test.mjs fails when these files are out of date, so the goldens always describe the current samples. */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SAMPLES } from '../src/samples/index.js';
import { makeElement } from '../src/core/catalog.js';
import { emptyDocument } from '../src/core/document.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const inputsDir = join(root, 'tests', 'oracle', 'inputs');
export const emtDir = join(root, 'tests', 'oracle', 'emt');

/** @param {import('../src/core/document.js').PowerDocument} doc */
export const serialize = doc => JSON.stringify(doc, null, 1) + '\n';

/** Every oracle input: the samples, an IEEE 14 variant whose condensers hit their reactive power limits, and a
 * Riverside variant with two converter-fed sources (a solar park and a battery) for short circuits.
 * @returns {Array<[string, import('../src/core/document.js').PowerDocument]>} */
export function oracleInputs() {
  /** @type {Array<[string, import('../src/core/document.js').PowerDocument]>} */
  const out = SAMPLES.map(s => [s.id, s.create()]);
  const tight = /** @type {import('../src/core/document.js').PowerDocument} */ (/** @type {[string, any]} */ (out[0])[1]);
  const variant = structuredClone(tight);
  variant.name = 'IEEE 14-bus system, tight reactive limits';
  for (const el of variant.elements) {
    if (el.id === 'G4') el.qmax = 8;   // needs about 12 Mvar
    if (el.id === 'G5') el.qmax = 10;  // needs about 17 Mvar
  }
  out.push(['ieee14-qlim', variant]);
  const riverside = /** @type {import('../src/core/document.js').PowerDocument} */ (/** @type {[string, any]} */ (out.find(([id]) => id === 'riverside'))[1]);
  const converters = structuredClone(riverside);
  converters.name = 'Riverside distribution with a solar park and a battery';
  converters.elements.push(
    makeElement('gen', 'PV1', { name: 'Brook Farm solar', bus: 'B7', mode: 'PQ', p: 8, q: 0, sn: 10, vn: 20, scSource: 'converter', kConverter: 1.2 }),
    makeElement('gen', 'BAT1', { name: 'Market Street battery', bus: 'B9', mode: 'PQ', p: 2, q: 1, sn: 5, vn: 20, scSource: 'converter', kConverter: 1.5 }));
  out.push(['riverside-converters', converters]);
  return out;
}

/** Networks the EMT oracle (scripts/oracle/emt_spice.py) needs beyond the samples. `emt-line`: two 220 kV grids, the
 * second with a load, apart until a 100 km line out of service joins them. Its travel time is exactly 400 µs, and its
 * sequences are equal, so its phases decouple into the single-phase lossless lines SPICE has.
 * @returns {Array<[string, import('../src/core/document.js').PowerDocument]>} */
export function emtInputs() {
  const doc = emptyDocument('EMT line energisation');
  doc.description = 'Two 220 kV grids joined by energising a 100 km line; a load behind a transformer at the receiving end.';
  const E = /** @type {(cls: import('../src/core/catalog.js').ElementClass, id: string, v: Record<string, unknown>) => void} */
    ((cls, id, v) => { doc.elements.push(makeElement(cls, id, v)); });
  const w = 2 * Math.PI * doc.frequency, x1 = 0.3, r1 = 0.03, len = 100, tau = 400e-6;
  // Susceptance per km that makes the travel time sqrt(L·C) exactly tau over len km.
  const b1 = (tau * w / len) ** 2 / x1 * 1e6;
  E('bus', 'A', { name: 'Sending 220 kV', vn: 220, x: 0, y: 0, len: 160 });
  E('bus', 'B', { name: 'Receiving 220 kV', vn: 220, x: 480, y: 0, len: 160 });
  E('extgrid', 'X1', { name: 'Sending grid', bus: 'A', vset: 1.0, angle: 0, skMax: 8000, skMin: 6000, rxMax: 0.1, rxMin: 0.1, x0x1: 1, r0x0: 0.1 });
  E('extgrid', 'X2', { name: 'Receiving grid', bus: 'B', vset: 1.0, angle: -10, skMax: 3000, skMin: 2000, rxMax: 0.1, rxMin: 0.1, x0x1: 1, r0x0: 0.1 });
  E('line', 'L2', { name: 'Long line', from: 'A', to: 'B', length: len, r1, x1, b1, r0: r1, x0: x1, b0: b1, ratedA: 1, inService: false });
  // The load sits behind a transformer, which also gives the network a branch in service: pandapower solves nothing,
  // and so ignores the second grid's angle, when no branch is in service.
  E('bus', 'C', { name: 'Load 33 kV', vn: 33, x: 480, y: 160, len: 120 });
  E('trafo', 'T1', { name: 'Load transformer', hv: 'B', lv: 'C', sn: 160, vnHV: 220, vnLV: 33, uk: 12, ur: 0.3, i0: 0.05, pfe: 60,
    vectorGroup: 'YNd11', shift: 0, uk0: 12, ur0: 0.3 });
  E('load', 'D1', { name: 'Load', bus: 'C', p: 120, q: 30 });
  return [['emt-line', doc]];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(inputsDir, { recursive: true });
  for (const [id, doc] of oracleInputs()) {
    await writeFile(join(inputsDir, `${id}.json`), serialize(doc));
    console.log(`wrote tests/oracle/inputs/${id}.json`);
  }
  await mkdir(emtDir, { recursive: true });
  for (const [id, doc] of emtInputs()) {
    await writeFile(join(emtDir, `${id}.json`), serialize(doc));
    console.log(`wrote tests/oracle/emt/${id}.json`);
  }
}
