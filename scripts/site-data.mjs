/** Figures and pictures for the marketing page, computed by the engine at build time so the page states what the app
 * does: the IEEE 14-bus studies, the agreement with the oracle goldens, and the single-line diagram drawn from the
 * same display list the app renders. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ieee14 } from '../src/samples/ieee14.js';
import { importMatpower } from '../src/core/matpower.js';
import { EngineHost } from '../src/engine/host.js';
import { Studies } from '../src/engine/studies.js';
import { buildScene } from '../src/render/scene.js';
import { toSVG } from '../src/render/svg.js';
import { bounds } from '../src/render/geometry.js';
import { parseColor } from '../src/render/displaylist.js';
import { buildOverlay } from '../src/ui/overlay.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(root, p), 'utf8');
/** The engine the app ships, built by npm run build:engine. */
const engine = new Studies(await EngineHost.create(readFileSync(join(root, 'src/engine/powerstudio-engine.wasm'))));

/** The diagram palette of a theme, read from the app's own style sheet tokens. @param {'light' | 'dark'} theme */
export function palette(theme) {
  const css = read('style.css');
  const block = theme === 'light' ? /:root \{([\s\S]*?)\n\}/.exec(css) : /:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(css);
  if (!block) throw new Error(`No ${theme} token block in style.css`);
  /** @type {Record<string, string>} */
  const tokens = {};
  for (const m of block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  const c = (/** @type {string} */ n) => { if (!tokens[n]) throw new Error(`Missing ${n} in ${theme} tokens`); return parseColor(tokens[n]); };
  return {
    bg: c('--dg-bg'), grid: c('--dg-grid'), ink: c('--dg-ink'), muted: c('--dg-muted'), select: c('--dg-select'), hover: c('--dg-hover'),
    label: c('--dg-label'), labelMuted: c('--dg-label-muted'), boxBg: c('--dg-box-bg'), boxBorder: c('--dg-box-border'), boxText: c('--dg-box-text'),
    kv: { ehv: c('--kv-ehv'), hv: c('--kv-hv'), mv: c('--kv-mv'), lv: c('--kv-lv') }, fault: c('--dg-fault'), preview: c('--dg-preview'),
    res: { ok: c('--res-ok'), warn: c('--res-warn'), high: c('--res-high'), low: c('--res-low') },
  };
}

/** The IEEE 14-bus diagram after a load flow, as SVG, in a theme. @param {'light' | 'dark'} theme */
export function diagramSvg(theme) {
  const doc = ieee14();
  const lf = engine.loadflow(doc);
  const P = palette(theme);
  const { overlay } = buildOverlay('loadflow', lf, doc, P, { colouring: 'results' });
  const list = buildScene({ elements: doc.elements, palette: P, selection: new Set(), hover: '', overlay, preview: null,
    labels: { names: true, branchNames: false, boxes: true }, zoom: 0.6 });
  // At this level of detail the app shows busbar voltages and branch loadings but leaves out the end flows.
  const b = bounds(doc.elements);
  const box = { x0: b.x0 - 120, y0: b.y0 + 10, x1: b.x1 + 180, y1: b.y1 - 40 };
  return toSVG(list, box, P.bg, 'IEEE 14-bus system after a load flow')
    .replace(/<\?xml[^>]*>/, '')
    .replace(/<svg ([^>]*?) width="[\d.]+" height="[\d.]+">/, '<svg $1 role="img" aria-label="Single-line diagram of the IEEE 14-bus system after a load flow" preserveAspectRatio="xMidYMid meet">');
}

/** The four studies on the IEEE 14-bus sample, as the app runs them. */
export function studies() {
  const doc = ieee14();
  const name = (/** @type {string} */ id) => doc.elements.find(e => e.id === id)?.name ?? id;
  let t = performance.now();
  const lf = engine.loadflow(doc);
  const lfMs = performance.now() - t;
  t = performance.now();
  const sc = engine.shortcircuit(doc, { fault: '3ph', mode: 'max', location: '' });
  const scMs = performance.now() - t;
  const top = sc.buses.reduce((m, b) => (b.ikss > m.ikss ? b : m));
  t = performance.now();
  const n1 = engine.contingency(doc);
  const n1Ms = performance.now() - t;
  const bad = n1.cases.filter(c => c.converged && c.violations.some(v => !v.inBase));
  const worst = n1.cases.reduce((m, c) => (c.maxLoading > m.maxLoading ? c : m));
  t = performance.now();
  const rms = engine.rms(doc);
  const rmsMs = performance.now() - t;
  const fault = rms.events.find(e => e.kind === 'fault'), clear = rms.events.find(e => e.kind === 'clear');
  const trip = rms.events.find(e => e.kind === 'trip');
  return {
    loadflow: { iterations: lf.iterations, losses: lf.totals.losses, generation: lf.totals.generation, ms: lfMs },
    shortcircuit: { ikss: top.ikss, ip: top.ip, bus: name(top.id), buses: sc.buses.length, ms: scMs },
    contingency: { total: n1.cases.length, bad: bad.length, outage: name(worst.id), loaded: name(worst.maxLoadingId), loading: worst.maxLoading, ms: n1Ms },
    rms: { stable: rms.stable, machines: rms.machines.filter(m => doc.elements.find(e => e.id === m.id)?.cls === 'gen').length,
      faultBus: fault ? name(fault.target) : '', clearing: fault && clear ? clear.t - fault.t : NaN, tripped: trip ? name(trip.target) : '',
      seconds: rms.t[rms.t.length - 1], steps: rms.steps, ms: rmsMs },
  };
}

/** Largest differences from the oracle goldens, as the test report states them. */
export function agreement() {
  const golden = (/** @type {string} */ n) => JSON.parse(read(`tests/oracle/golden/${n}.json`));
  const input = (/** @type {string} */ n) => JSON.parse(read(`tests/oracle/inputs/${n}.json`));
  let mp = 0;
  for (const c of ['case14', 'case30', 'case118']) {
    const g = golden(`matpower-${c}`);
    const r = engine.loadflow(importMatpower(read(`tests/fixtures/${c}.m`)).doc, { tolerance: 1e-8 });
    g.bus.forEach((/** @type {number} */ b, /** @type {number} */ k) => { mp = Math.max(mp, Math.abs(/** @type {any} */ (r.buses.find(x => x.id === `B${b}`)).vm - g.vm[k])); });
  }
  let pp = 0;
  for (const [n, q] of /** @type {Array<[string, boolean]>} */ ([['ieee14', false], ['riverside', false], ['riverside', true], ['ieee14-qlim', true]])) {
    const ref = golden(n).loadflow[q ? 'qlim' : 'base'];
    for (const b of engine.loadflow(input(n), { tolerance: 1e-9, enforceQLimits: q }).buses) pp = Math.max(pp, Math.abs(b.vm - ref.bus[b.id][0]));
  }
  /** @param {readonly ('3ph' | '2ph' | '1ph')[]} faults */
  const scWorst = faults => {
    let w = 0;
    for (const n of ['ieee14', 'riverside']) for (const fault of faults) for (const mode of /** @type {const} */ (['max', 'min'])) {
      const ref = golden(n).shortcircuit[`${fault}-${mode}`];
      for (const b of engine.shortcircuit(input(n), { fault, mode, kappa: 'C', lvTolerance: '10', location: '' }).buses) {
        for (const k of /** @type {const} */ (['ikss', 'ip', 'ith'])) {
          const want = ref[b.id][k];
          if (want === null || Math.abs(want) < 1e-3) continue;
          w = Math.max(w, Math.abs(b[k] - want) / Math.abs(want));
        }
      }
    }
    return w;
  };
  return { matpower: mp, pandapowerLf: pp, scSymmetric: scWorst(['3ph', '2ph']), scEarth: scWorst(['1ph']) };
}
