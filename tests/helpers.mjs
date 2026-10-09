/** Shared test helpers: fixtures, goldens and the calculation engine. The engine is the WebAssembly module the app
 * ships (`npm test` builds it first), instantiated once for every test file that imports this. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EngineHost } from '../src/engine/host.js';
import { Studies } from '../src/engine/studies.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** @param {string} rel */
export const read = rel => readFileSync(join(root, rel), 'utf8');
/** @param {string} name */
export const golden = name => JSON.parse(read(`tests/oracle/golden/${name}.json`));
/** @param {string} name */
export const input = name => JSON.parse(read(`tests/oracle/inputs/${name}.json`));
export const wasmPath = join(root, 'src/engine/powerstudio-engine.wasm');
export const engine = await EngineHost.create(readFileSync(wasmPath));
export const studies = new Studies(engine);
