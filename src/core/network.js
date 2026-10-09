/** Compiles a document into the per-unit network the solvers work on.
 *
 * Per-unit bases: the document's base power (normally 100 MVA) and each busbar's nominal voltage. Every branch is
 * reduced to its two-port admittances (yff, yft, ytf, ytt) in the MATPOWER convention, so load flow, short circuit and
 * the dynamic simulation all assemble their matrices from the same numbers. docs/ENGINE.md derives each model. */

import { busesOf } from './document.js';

/**
 * @typedef {import('./catalog.js').Element} Element
 * @typedef {import('./document.js').PowerDocument} PowerDocument
 * @typedef {{ re: number, im: number }} Complex
 * @typedef {{ id: string, cls: 'line' | 'trafo', f: number, t: number, yff: Complex, yft: Complex, ytf: Complex, ytt: Complex,
 *   shift: number, ratedKA: number, ratedMVA: number, vbaseF: number, vbaseT: number }} Branch
 * @typedef {{ id: string, bus: number, mode: 'PV' | 'PQ' | 'Reference', p: number, q: number, vset: number, angle: number, qmin: number, qmax: number }} GenUnit
 * @typedef {{ id: string, bus: number, vset: number, angle: number }} GridUnit
 * @typedef {{ id: string, bus: number, p: number, q: number }} LoadUnit
 * @typedef {{ id: string, bus: number, y: Complex }} ShuntUnit
 * @typedef {{
 *   baseMVA: number, frequency: number, nb: number, busIds: string[], busIndex: Map<string, number>, vbase: Float64Array,
 *   branches: Branch[], gens: GenUnit[], grids: GridUnit[], loads: LoadUnit[], shunts: ShuntUnit[],
 *   islands: Int32Array, deenergized: string[], warnings: string[], names: Map<string, string>,
 * }} Network
 */

const DEG = Math.PI / 180;

/** @param {number} re @param {number} im @returns {Complex} */
const c = (re, im) => ({ re, im });
/** @param {Complex} a @param {Complex} b */
const cdiv = (a, b) => { const d = b.re * b.re + b.im * b.im; return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
/** @param {Complex} a @param {number} k */
const cscale = (a, k) => c(a.re * k, a.im * k);

/** The phase shift of a vector group in degrees: clock number × 30°, LV lagging HV. @param {string} group */
export function vectorShift(group) {
  const m = /(\d+)$/.exec(group);
  return m ? (Number(m[1]) % 12) * 30 : 0;
}

/** Transformer tap ratio on the HV side, as a multiple of rated HV voltage. @param {Element} el */
export function tapRatio(el) {
  const n = /** @type {number} */ (el.tapPos) - /** @type {number} */ (el.tapNeutral);
  return 1 + n * /** @type {number} */ (el.tapStep) / 100;
}

/**
 * Series impedance and shunt admittance of a line in per unit of the system base.
 * @param {Element} el @param {number} vb base kV @param {number} sb base MVA @param {0 | 1} [seq]
 */
export function linePu(el, vb, sb, seq = 1) {
  const len = /** @type {number} */ (el.length), par = /** @type {number} */ (el.parallel), zb = vb * vb / sb;
  const r = /** @type {number} */ (seq ? el.r1 : el.r0), x = /** @type {number} */ (seq ? el.x1 : el.x0), b = /** @type {number} */ (seq ? el.b1 : el.b0);
  return { z: c(r * len / par / zb, x * len / par / zb), b: b * 1e-6 * len * par * zb };
}

/**
 * Two-port model of a transformer in per unit: series impedance referred to the LV busbar, magnetising admittance,
 * off-nominal ratio and phase shift. `correction` scales the series impedance (the IEC 60909 factor KT).
 * @param {Element} el @param {number} vh HV base kV @param {number} vl LV base kV @param {number} sb base MVA
 * @param {{ tap?: boolean, correction?: number, seq?: 0 | 1 }} [opt]
 */
export function trafoPu(el, vh, vl, sb, opt = {}) {
  const { tap = true, correction = 1, seq = 1 } = opt;
  const sn = /** @type {number} */ (el.sn), vnh = /** @type {number} */ (el.vnHV), vnl = /** @type {number} */ (el.vnLV);
  const uk = /** @type {number} */ (seq ? el.uk : el.uk0) / 100, ur = /** @type {number} */ (seq ? el.ur : el.ur0) / 100;
  const k = (sb / sn) * (vnl / vl) ** 2 * correction;
  const z = c(ur * k, Math.sqrt(Math.max(uk * uk - ur * ur, 0)) * k);
  const g = /** @type {number} */ (el.pfe) / 1000 / sn, ym = /** @type {number} */ (el.i0) / 100;
  const bm = -Math.sqrt(Math.max(ym * ym - g * g, 0));
  const ky = (sn / sb) * (vl / vnl) ** 2;
  const ratio = ((vnh * (tap ? tapRatio(el) : 1)) / vnl) / (vh / vl);
  return { z, ym: c(g * ky, bm * ky), ratio, shift: vectorShift(/** @type {string} */ (el.vectorGroup)) };
}

/**
 * Admittances of a two-port with series impedance z, total shunt admittance ysh split between both ends, and an ideal
 * transformer t = ratio·e^{jθ} at the from end (MATPOWER convention).
 * @param {Complex} z @param {Complex} ysh @param {number} ratio @param {number} shiftDeg
 */
export function twoPort(z, ysh, ratio, shiftDeg) {
  const ys = cdiv(c(1, 0), z), half = cscale(ysh, 0.5);
  const tr = ratio * Math.cos(shiftDeg * DEG), ti = ratio * Math.sin(shiftDeg * DEG);
  const ytt = c(ys.re + half.re, ys.im + half.im);
  const yff = cscale(ytt, 1 / (ratio * ratio));
  const yft = cscale(cdiv(ys, c(tr, -ti)), -1);
  const ytf = cscale(cdiv(ys, c(tr, ti)), -1);
  return { yff, yft, ytf, ytt };
}

/** Elements that are switched in and whose busbars exist. @param {PowerDocument} doc */
function activeElements(doc) {
  return doc.elements.filter(e => e.cls === 'bus' || e.inService !== false);
}

/**
 * Builds the per-unit network. Busbars that cannot reach a source (external grid or reference machine) through
 * switched-in branches are de-energised. An island that has generators but no reference gets its largest machine as
 * reference, as a warning.
 * @param {PowerDocument} doc @param {{ loadScale?: number, outages?: Set<string> }} [opt]
 * @returns {Network}
 */
export function compileNetwork(doc, opt = {}) {
  const { loadScale = 1, outages } = opt;
  const sb = doc.baseMVA;
  /** @type {string[]} */
  const warnings = [];
  const elements = activeElements(doc).filter(e => !outages?.has(e.id));
  const allBuses = elements.filter(e => e.cls === 'bus');
  const branchesEl = elements.filter(e => e.cls === 'line' || e.cls === 'trafo');
  const byBus = new Map(allBuses.map((b, i) => [b.id, i]));

  // Connected components over switched-in branches.
  const parent = allBuses.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const br of branchesEl) {
    const [a, b] = busesOf(br).map(id => byBus.get(id));
    if (a === undefined || b === undefined) continue;
    parent[find(a)] = find(b);
  }
  const sources = new Set();
  for (const el of elements) {
    if (el.cls === 'extgrid' || (el.cls === 'gen' && el.mode === 'Reference')) {
      const i = byBus.get(/** @type {string} */ (el.bus));
      if (i !== undefined) sources.add(find(i));
    }
  }
  /** @type {Set<string>} */
  const promoted = new Set();
  const gensByRoot = new Map();
  for (const el of elements) {
    if (el.cls !== 'gen') continue;
    const i = byBus.get(/** @type {string} */ (el.bus));
    if (i === undefined) continue;
    const root = find(i);
    if (sources.has(root)) continue;
    const best = gensByRoot.get(root);
    if (!best || /** @type {number} */ (el.sn) > /** @type {number} */ (best.sn)) gensByRoot.set(root, el);
  }
  for (const [root, el] of gensByRoot) {
    sources.add(root);
    promoted.add(el.id);
    warnings.push(`${el.name || el.id} is the reference machine for its island, which has no external grid or reference machine.`);
  }

  const live = allBuses.filter((_, i) => sources.has(find(i)));
  const deenergized = allBuses.filter((_, i) => !sources.has(find(i))).map(b => b.id);
  const busIndex = new Map(live.map((b, i) => [b.id, i]));
  const vbase = Float64Array.from(live, b => /** @type {number} */ (b.vn));
  const rootIds = new Map();
  const islands = Int32Array.from(live, b => {
    const r = find(/** @type {number} */ (byBus.get(b.id)));
    if (!rootIds.has(r)) rootIds.set(r, rootIds.size);
    return rootIds.get(r);
  });

  /** @type {Branch[]} */
  const branches = [];
  for (const el of branchesEl) {
    const [fId, tId] = busesOf(el);
    const f = busIndex.get(fId), t = busIndex.get(tId);
    if (f === undefined || t === undefined) continue;
    if (el.cls === 'line') {
      const { z, b } = linePu(el, vbase[f], sb);
      branches.push({ id: el.id, cls: 'line', f, t, ...twoPort(z, c(0, b), 1, 0), shift: 0,
        ratedKA: /** @type {number} */ (el.ratedA) * /** @type {number} */ (el.parallel), ratedMVA: 0, vbaseF: vbase[f], vbaseT: vbase[t] });
    } else {
      const { z, ym, ratio, shift } = trafoPu(el, vbase[f], vbase[t], sb);
      branches.push({ id: el.id, cls: 'trafo', f, t, ...twoPort(z, ym, ratio, shift), shift,
        ratedKA: 0, ratedMVA: /** @type {number} */ (el.sn), vbaseF: vbase[f], vbaseT: vbase[t] });
    }
  }

  /** @type {GenUnit[]} */
  const gens = [];
  /** @type {GridUnit[]} */
  const grids = [];
  /** @type {LoadUnit[]} */
  const loads = [];
  /** @type {ShuntUnit[]} */
  const shunts = [];
  for (const el of elements) {
    const i = busIndex.get(/** @type {string} */ (el.bus));
    if (i === undefined) continue;
    if (el.cls === 'gen') {
      gens.push({ id: el.id, bus: i, mode: promoted.has(el.id) ? 'Reference' : /** @type {GenUnit['mode']} */ (el.mode),
        p: /** @type {number} */ (el.p) / sb, q: /** @type {number} */ (el.q) / sb, vset: /** @type {number} */ (el.vset), angle: /** @type {number} */ (el.angle),
        qmin: /** @type {number} */ (el.qmin) / sb, qmax: /** @type {number} */ (el.qmax) / sb });
    } else if (el.cls === 'extgrid') {
      grids.push({ id: el.id, bus: i, vset: /** @type {number} */ (el.vset), angle: /** @type {number} */ (el.angle) });
    } else if (el.cls === 'load') {
      loads.push({ id: el.id, bus: i, p: /** @type {number} */ (el.p) * loadScale / sb, q: /** @type {number} */ (el.q) * loadScale / sb });
    } else if (el.cls === 'shunt') {
      const k = (vbase[i] / /** @type {number} */ (el.vn)) ** 2 / sb;
      shunts.push({ id: el.id, bus: i, y: c(/** @type {number} */ (el.p) * k, /** @type {number} */ (el.q) * k) });
    }
  }
  const names = new Map(doc.elements.map(e => [e.id, e.name || e.id]));
  return { baseMVA: sb, frequency: doc.frequency, nb: live.length, busIds: live.map(b => b.id), busIndex, vbase,
    branches, gens, grids, loads, shunts, islands, deenergized, warnings, names };
}

/**
 * Nominal angle of every busbar in radians: the sum of the transformer phase shifts on a path from its island's
 * reference, found breadth-first. The load flow starts from these angles; the stability results subtract them so a
 * rotor angle reads the same on either side of a Dyn5 transformer.
 * @param {Network} net @param {Float64Array} [seed] fixed angles of reference busbars (radians)
 */
export function nominalAngles(net, seed) {
  const n = net.nb, va = seed ? Float64Array.from(seed) : new Float64Array(n), visited = new Uint8Array(n);
  /** @type {number[]} */
  const queue = [];
  for (const g of net.grids) if (!visited[g.bus]) { visited[g.bus] = 1; queue.push(g.bus); }
  for (const g of net.gens) if (g.mode === 'Reference' && !visited[g.bus]) { visited[g.bus] = 1; queue.push(g.bus); }
  /** @type {Array<Array<{ to: number, shift: number }>>} */
  const adj = Array.from({ length: n }, () => []);
  for (const br of net.branches) {
    // The to end lags the from end by the phase shift.
    adj[br.f].push({ to: br.t, shift: -br.shift * Math.PI / 180 });
    adj[br.t].push({ to: br.f, shift: br.shift * Math.PI / 180 });
  }
  while (queue.length) {
    const i = /** @type {number} */ (queue.shift());
    for (const { to, shift } of adj[i]) {
      if (visited[to]) continue;
      visited[to] = 1;
      va[to] = va[i] + shift;
      queue.push(to);
    }
  }
  return va;
}

/**
 * Dense bus admittance matrix. `extra` adds per-bus shunt admittances (used by short circuit and the dynamic model).
 * @param {Network} net @param {{ branches?: Branch[], extra?: Array<{ bus: number, y: Complex }> }} [opt]
 */
export function buildYbus(net, opt = {}) {
  const n = net.nb, re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (const br of opt.branches ?? net.branches) {
    const { f, t } = br;
    re[f * n + f] += br.yff.re; im[f * n + f] += br.yff.im;
    re[f * n + t] += br.yft.re; im[f * n + t] += br.yft.im;
    re[t * n + f] += br.ytf.re; im[t * n + f] += br.ytf.im;
    re[t * n + t] += br.ytt.re; im[t * n + t] += br.ytt.im;
  }
  for (const s of opt.extra ?? net.shunts) { re[s.bus * n + s.bus] += s.y.re; im[s.bus * n + s.bus] += s.y.im; }
  return { re, im };
}
