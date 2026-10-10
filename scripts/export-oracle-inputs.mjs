#!/usr/bin/env node
/** Writes the bundled samples to tests/oracle/inputs/ so scripts/oracle/oracle.py can rebuild them in pandapower.
 * tests/oracle.test.mjs fails when these files are out of date, so the goldens always describe the current samples. */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SAMPLES } from '../src/samples/index.js';
import { makeElement } from '../src/core/catalog.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const inputsDir = join(root, 'tests', 'oracle', 'inputs');

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(inputsDir, { recursive: true });
  for (const [id, doc] of oracleInputs()) {
    await writeFile(join(inputsDir, `${id}.json`), serialize(doc));
    console.log(`wrote tests/oracle/inputs/${id}.json`);
  }
}
