/** Benchmark worker: loads the engine and MATPOWER cases over HTTP and times the load flow, as a page's worker would. */
import { EngineHost } from '../../src/engine/host.js';

self.onmessage = async (/** @type {MessageEvent} */ event) => {
  const { cases, repeat, warm, again } = event.data;
  try {
    const engine = await EngineHost.create(await (await fetch('/src/engine/powerstudio-engine.wasm')).arrayBuffer());
    for (const path of cases) {
      const text = new Uint8Array(await (await fetch(`/${path}`)).arrayBuffer());
      const loaded = engine.call({ op: 'load_matpower' }, text).header;
      /** @type {any} */
      let best = null;
      if (again) {
        // An editing session: solve from the case's voltages and keep the solution, then change the largest load by
        // 1 % up and down in turn, each time solving from the previous solution.
        engine.call({ op: 'solve_model', tolerance: 1e-6, warm_start: true, dc_start: false, keep: true });
        for (let k = 0; k < repeat; k++) {
          const r = engine.call({ op: 'solve_model', tolerance: 1e-6, warm_start: true, dc_start: false, keep: true, bump: k % 2 ? 1 / 1.01 : 1.01 }).header;
          if (!best || r.timing.totalMs < best.timing.totalMs) best = r;
        }
      } else {
        for (let k = 0; k < repeat; k++) {
          const r = engine.call({ op: 'solve_model', tolerance: 1e-6, warm_start: warm, dc_start: !warm }).header;
          if (!best || r.timing.totalMs < best.timing.totalMs) best = r;
        }
      }
      postMessage({ case: loaded.name, nodes: loaded.nodes, converged: best.converged, iterations: best.iterations,
        total_ms: +best.timing.totalMs.toFixed(1), memory_mb: +(engine.exports.memory.buffer.byteLength / 2 ** 20).toFixed(1) });
    }
    postMessage({ done: true });
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
