#!/usr/bin/env node
/** Times the engine's load flow in WebAssembly (under Node's V8, the engine Chromium uses) on MATPOWER cases.
 * Usage: node scripts/wasm-bench.mjs <engine.wasm> <case.m>... [--warm] [--repeat n] */
import { readFile } from 'node:fs/promises';
import { EngineHost } from '../src/engine/host.js';

const args = process.argv.slice(2);
const wasm = args.shift();
const warm = args.includes('--warm');
const ri = args.indexOf('--repeat');
const repeat = ri >= 0 ? Number(args[ri + 1]) : 3;
const cases = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--repeat');
const t0 = performance.now();
const engine = await EngineHost.create(await readFile(/** @type {string} */ (wasm)));
const instantiate = performance.now() - t0;
console.log(JSON.stringify({ instantiate_ms: instantiate, engine: engine.call({ op: 'version' }).header.engine }));
for (const path of cases) {
  const bytes = await readFile(path);
  const tl = performance.now();
  const loaded = engine.call({ op: 'load_matpower' }, bytes).header;
  const load = performance.now() - tl;
  const runs = [];
  let last;
  for (let k = 0; k < repeat; k++) {
    const t = performance.now();
    last = engine.call({ op: 'solve_lf', tolerance: 1e-8, warm_start: warm, dc_start: !warm }).header;
    runs.push(performance.now() - t);
  }
  console.log(JSON.stringify({ case: loaded.name, buses: loaded.buses, load_ms: +load.toFixed(1), converged: last?.converged, iterations: last?.iterations,
    memory_mb: +(engine.exports.memory.buffer.byteLength / 2 ** 20).toFixed(1), solve_ms_best: +Math.min(...runs).toFixed(1), analyse_ms: +last?.timing.analyse_ms.toFixed(1), factor_solve_ms: +last?.timing.factor_solve_ms.toFixed(1) }));
}
