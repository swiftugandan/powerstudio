#!/usr/bin/env node
/** Times the engine's load flow in WebAssembly (under Node's V8, the JavaScript engine of Chromium) on MATPOWER cases,
 * through the full path: MATPOWER → model → topology → per-unit network → Newton-Raphson.
 * Usage: node scripts/wasm-bench.mjs <engine.wasm> <case.m>... [--warm] [--repeat n] */
import { readFile } from 'node:fs/promises';
import { EngineHost } from '../src/engine/host.js';

const args = process.argv.slice(2);
const wasm = /** @type {string} */ (args.shift());
const warm = args.includes('--warm');
const ri = args.indexOf('--repeat');
const repeat = ri >= 0 ? Number(args[ri + 1]) : 3;
const cases = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--repeat');
const bytes = await readFile(wasm);
const t0 = performance.now();
const engine = await EngineHost.create(bytes);
console.log(JSON.stringify({ module_kb: +(bytes.length / 1024).toFixed(1), instantiate_ms: +(performance.now() - t0).toFixed(1), engine: engine.version() }));
for (const path of cases) {
  const loaded = engine.call({ op: 'load_matpower' }, await readFile(path)).header;
  /** @type {any} */
  let best = null;
  for (let k = 0; k < repeat; k++) {
    const r = engine.call({ op: 'solve_model', tolerance: 1e-6, warm_start: warm, dc_start: !warm }).header;
    if (!best || r.timing.totalMs < best.timing.totalMs) best = r;
  }
  console.log(JSON.stringify({ case: loaded.name, nodes: loaded.nodes, parse_ms: +loaded.parse_ms.toFixed(1), convert_ms: +loaded.convert_ms.toFixed(1),
    converged: best.converged, iterations: best.iterations, total_ms: +best.timing.totalMs.toFixed(1), analyse_ms: +best.timing.analyseMs.toFixed(1),
    factor_solve_ms: +best.timing.factorSolveMs.toFixed(1), memory_mb: +(engine.exports.memory.buffer.byteLength / 2 ** 20).toFixed(1) }));
}
