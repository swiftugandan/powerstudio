#!/usr/bin/env node
/** Writes the bundled samples to tests/oracle/inputs/ so scripts/oracle/oracle.py can rebuild them in pandapower.
 * tests/oracle.test.mjs fails when these files are out of date, so the goldens always describe the current samples. */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SAMPLES } from '../src/samples/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const inputsDir = join(root, 'tests', 'oracle', 'inputs');

/** @param {import('../src/core/document.js').PowerDocument} doc */
export const serialize = doc => JSON.stringify(doc, null, 1) + '\n';

/** Every oracle input: the samples, plus an IEEE 14 variant whose condensers hit their reactive power limits.
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
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(inputsDir, { recursive: true });
  for (const [id, doc] of oracleInputs()) {
    await writeFile(join(inputsDir, `${id}.json`), serialize(doc));
    console.log(`wrote tests/oracle/inputs/${id}.json`);
  }
}
