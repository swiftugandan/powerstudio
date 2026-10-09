/** Benchmark worker: loads the engine and MATPOWER cases over HTTP and times the load flow, as a page's worker would. */
import { EngineHost } from '../../src/engine/host.js';

self.onmessage = async (/** @type {MessageEvent} */ event) => {
  const { cases, repeat, warm } = event.data;
  try {
    const engine = await EngineHost.create(await (await fetch('/src/engine/powerstudio-engine.wasm')).arrayBuffer());
    for (const path of cases) {
      const text = new Uint8Array(await (await fetch(`/${path}`)).arrayBuffer());
      const loaded = engine.call({ op: 'load_matpower' }, text).header;
      /** @type {any} */
      let best = null;
      for (let k = 0; k < repeat; k++) {
        const r = engine.call({ op: 'solve_model', tolerance: 1e-6, warm_start: warm, dc_start: !warm }).header;
        if (!best || r.timing.totalMs < best.timing.totalMs) best = r;
      }
      postMessage({ case: loaded.name, nodes: loaded.nodes, converged: best.converged, iterations: best.iterations,
        total_ms: +best.timing.totalMs.toFixed(1), memory_mb: +(engine.exports.memory.buffer.byteLength / 2 ** 20).toFixed(1) });
    }
    postMessage({ done: true });
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
