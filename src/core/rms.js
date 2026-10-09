/** RMS (electromechanical) simulation with the classical machine model.
 *
 * Every synchronous machine is a constant voltage E′ behind its transient reactance x′d whose angle follows the swing
 * equation; external grids are constant voltages behind their short-circuit impedance; loads become constant
 * admittances at their load-flow voltage. The network is solved algebraically at every stage of a fourth-order
 * Runge-Kutta step. Events (busbar faults, clearing, tripping, load steps) change the network between steps.
 * docs/ENGINE.md, "Stability", states the model and its limits. */

import { runLoadFlow } from './loadflow.js';
import { compileNetwork, buildYbus, nominalAngles } from './network.js';
import { cluFactor, cluSolve } from './linalg.js';

/**
 * @typedef {import('./document.js').PowerDocument} PowerDocument
 * @typedef {import('./document.js').SimEvent} SimEvent
 * @typedef {{ id: string, name: string, delta: Float32Array, speed: Float32Array, pe: Float32Array }} MachineTrace
 * @typedef {{ t: Float32Array, machines: MachineTrace[], busIds: string[], voltages: Float32Array[], events: Array<SimEvent & { applied: boolean, note: string }>,
 *   stable: boolean, lossOfSynchronism: number | null, angleReference: 'grid' | 'coi', steps: number, message: string }} RmsResult
 */

const FAULT_Y = 1e6;

/**
 * @param {PowerDocument} doc
 * @param {{ tEnd?: number, dt?: number, events?: SimEvent[], maxSamples?: number,
 *   onProgress?: (t: number, tEnd: number) => void, shouldStop?: () => boolean }} [opt]
 * @returns {RmsResult}
 */
export function runRms(doc, opt = {}) {
  const st = doc.study.rms;
  const tEnd = opt.tEnd ?? st.tEnd, dt = opt.dt ?? st.dt, maxSamples = opt.maxSamples ?? 4000;
  const events = [...(opt.events ?? st.events)].sort((a, b) => a.t - b.t);
  const lf = runLoadFlow(doc);
  if (!lf.converged) throw new Error(`The initial load flow does not converge: ${lf.message}`);
  const net = compileNetwork(doc, { loadScale: doc.study.loadflow.loadScale / 100 });
  const n = net.nb, sb = net.baseMVA, wb = 2 * Math.PI * net.frequency;
  const byId = new Map(doc.elements.map(e => [e.id, e]));
  const vr = Float64Array.from(lf.state.vm, (m, i) => m * Math.cos(lf.state.va[i] * Math.PI / 180));
  const vi = Float64Array.from(lf.state.vm, (m, i) => m * Math.sin(lf.state.va[i] * Math.PI / 180));

  // Sources: machines with inertia, grids without.
  /** @type {Array<{ id: string, name: string, bus: number, yr: number, yi: number, e: number, delta: number, w: number, pm: number, h: number, d: number, grid: boolean, on: boolean }>} */
  const src = [];
  const unitPQ = new Map([...lf.gens, ...lf.grids].map(u => [u.id, u]));
  for (const g of net.gens) {
    const el = /** @type {import('./catalog.js').Element} */ (byId.get(g.id));
    const u = /** @type {{ p: number, q: number }} */ (unitPQ.get(g.id));
    const xd = /** @type {number} */ (el.xdt) * (sb / /** @type {number} */ (el.sn)) * (/** @type {number} */ (el.vn) / net.vbase[g.bus]) ** 2;
    src.push(machineFrom(g.id, el.name || g.id, g.bus, 0, xd, u.p / sb, u.q / sb, vr[g.bus], vi[g.bus],
      /** @type {number} */ (el.h) * /** @type {number} */ (el.sn) / sb, /** @type {number} */ (el.damping) * /** @type {number} */ (el.sn) / sb, false));
  }
  for (const g of net.grids) {
    const el = /** @type {import('./catalog.js').Element} */ (byId.get(g.id));
    const u = /** @type {{ p: number, q: number }} */ (unitPQ.get(g.id));
    const rx = /** @type {number} */ (el.rxMax), z = sb / /** @type {number} */ (el.skMax), x = z / Math.sqrt(1 + rx * rx);
    src.push(machineFrom(g.id, el.name || g.id, g.bus, rx * x, x, u.p / sb, u.q / sb, vr[g.bus], vi[g.bus], Infinity, 0, true));
  }
  if (!src.some(s => !s.grid)) throw new Error('The network has no synchronous machine to simulate.');

  // Loads as constant admittances at their initial voltage: y = (P − jQ)/|V|².
  const loadY = new Map(net.loads.map(l => {
    const v2 = vr[l.bus] ** 2 + vi[l.bus] ** 2;
    return [l.id, { bus: l.bus, re: l.p / v2, im: -l.q / v2, scale: 1 }];
  }));

  const outaged = new Set(), faults = new Map();
  let factor = /** @type {import('./linalg.js').ComplexLU | null} */ (null);
  const refactor = () => {
    const branches = net.branches.filter(b => !outaged.has(b.id));
    const extra = [...net.shunts];
    for (const [id, l] of loadY) if (!outaged.has(id)) extra.push({ id, bus: l.bus, y: { re: l.re * l.scale, im: l.im * l.scale } });
    for (const s of src) if (s.on) extra.push({ id: s.id, bus: s.bus, y: { re: s.yr, im: s.yi } });
    for (const [bus, y] of faults) extra.push({ id: 'fault', bus, y: { re: 0, im: -y } });
    const Y = buildYbus(net, { branches, extra });
    factor = cluFactor(Y.re, Y.im, n);
  };
  refactor();

  /** Network solution and electrical power of each source for given rotor angles. @param {Float64Array} delta */
  const solve = delta => {
    const ir = new Float64Array(n), ii = new Float64Array(n);
    src.forEach((s, k) => {
      if (!s.on) return;
      const er = s.e * Math.cos(delta[k]), ei = s.e * Math.sin(delta[k]);
      ir[s.bus] += s.yr * er - s.yi * ei; ii[s.bus] += s.yr * ei + s.yi * er;
    });
    const v = cluSolve(/** @type {import('./linalg.js').ComplexLU} */ (factor), ir, ii);
    const pe = src.map((s, k) => {
      if (!s.on) return 0;
      const er = s.e * Math.cos(delta[k]), ei = s.e * Math.sin(delta[k]);
      const dr = er - v.re[s.bus], di = ei - v.im[s.bus];
      const cr = s.yr * dr - s.yi * di, ci = s.yr * di + s.yi * dr;
      return er * cr + ei * ci;
    });
    return { v, pe };
  };

  const m = src.length;
  let delta = Float64Array.from(src, s => s.delta), w = new Float64Array(m).fill(1);
  /** @param {Float64Array} d @param {Float64Array} om */
  const deriv = (d, om) => {
    const { pe } = solve(d);
    const dd = new Float64Array(m), dw = new Float64Array(m);
    src.forEach((s, k) => {
      if (s.grid || !s.on) return;
      dd[k] = wb * (om[k] - 1);
      dw[k] = (s.pm - pe[k] - s.d * (om[k] - 1)) / (2 * s.h);
    });
    return { dd, dw };
  };

  const steps = Math.ceil(tEnd / dt - 1e-9);
  const stride = Math.max(1, Math.ceil((steps + 1 + 2 * events.length) / maxSamples));
  /** @type {number[]} */
  const T = [];
  /** @type {number[][]} */
  const D = src.map(() => []), W = src.map(() => []), P = src.map(() => []);
  /** @type {number[][]} */
  const V = Array.from({ length: n }, () => []);
  const hasGrid = src.some(s => s.grid);
  const nominal = nominalAngles(net);
  const record = (/** @type {number} */ t) => {
    const { v, pe } = solve(delta);
    // Angles are shown against the grid when there is one, otherwise against the centre of inertia.
    let ref = 0;
    if (!hasGrid) {
      let hs = 0;
      src.forEach((s, k) => { if (s.on) { ref += s.h * (delta[k] - nominal[s.bus]); hs += s.h; } });
      ref /= hs || 1;
    }
    T.push(t);
    src.forEach((s, k) => { D[k].push((delta[k] - nominal[s.bus] - ref) * 180 / Math.PI); W[k].push(w[k] * net.frequency); P[k].push(pe[k] * sb); });
    for (let i = 0; i < n; i++) V[i].push(Math.hypot(v.re[i], v.im[i]));
  };

  /** @type {RmsResult['events']} */
  const applied = events.map(e => ({ ...e, applied: false, note: '' }));
  let next = 0, lossOfSynchronism = /** @type {number | null} */ (null);
  const applyDue = (/** @type {number} */ t) => {
    let changed = false;
    while (next < applied.length && applied[next].t <= t + dt * 1e-6) {
      const e = applied[next++];
      changed = applyEvent(e) || changed;
    }
    if (changed) { refactor(); return true; }
    return false;
  };
  /** @param {RmsResult['events'][number]} e */
  const applyEvent = e => {
    const el = byId.get(e.target);
    const name = el?.name || e.target;
    if (e.kind === 'fault') {
      const bus = net.busIndex.get(e.target);
      if (bus === undefined) { e.note = `${name} is not an energised busbar.`; return false; }
      faults.set(bus, FAULT_Y); e.applied = true; e.note = `Three-phase fault at ${name}.`; return true;
    }
    if (e.kind === 'clear') {
      const bus = net.busIndex.get(e.target);
      if (bus === undefined || !faults.has(bus)) { e.note = `No fault at ${name} to clear.`; return false; }
      faults.delete(bus); e.applied = true; e.note = `Fault at ${name} cleared.`; return true;
    }
    if (e.kind === 'trip') {
      const s = src.find(x => x.id === e.target);
      if (s) { s.on = false; e.applied = true; e.note = `${name} tripped.`; return true; }
      if (net.branches.some(b => b.id === e.target) || loadY.has(e.target)) { outaged.add(e.target); e.applied = true; e.note = `${name} switched out.`; return true; }
      e.note = `${name} is not in service.`; return false;
    }
    const l = loadY.get(e.target);
    if (!l) { e.note = `${name} is not a load in service.`; return false; }
    l.scale = (e.value ?? 100) / 100; e.applied = true; e.note = `${name} set to ${(l.scale * 100).toFixed(0)} % of its initial power.`;
    return true;
  };

  applyDue(0);
  record(0);
  let t = 0;
  for (let s = 0; s < steps; s++) {
    if (opt.shouldStop?.()) break;
    const h = Math.min(dt, tEnd - t);
    const k1 = deriv(delta, w);
    const add = (/** @type {Float64Array} */ a, /** @type {Float64Array} */ b, /** @type {number} */ f) => Float64Array.from(a, (x, i) => x + f * b[i]);
    const k2 = deriv(add(delta, k1.dd, h / 2), add(w, k1.dw, h / 2));
    const k3 = deriv(add(delta, k2.dd, h / 2), add(w, k2.dw, h / 2));
    const k4 = deriv(add(delta, k3.dd, h), add(w, k3.dw, h));
    delta = Float64Array.from(delta, (x, i) => x + h / 6 * (k1.dd[i] + 2 * k2.dd[i] + 2 * k3.dd[i] + k4.dd[i]));
    w = Float64Array.from(w, (x, i) => x + h / 6 * (k1.dw[i] + 2 * k2.dw[i] + 2 * k3.dw[i] + k4.dw[i]));
    t = (s + 1) * dt > tEnd ? tEnd : (s + 1) * dt;
    const switching = next < applied.length && applied[next].t <= t + dt * 1e-6;
    if (switching) record(t); // value just before the event
    const changed = applyDue(t);
    if (changed || (s + 1) % stride === 0 || s === steps - 1) record(t);
    if (lossOfSynchronism === null && separation(src, delta, nominal) > Math.PI) lossOfSynchronism = t;
    if ((s & 255) === 0) opt.onProgress?.(t, tEnd);
  }
  opt.onProgress?.(t, tEnd);
  const stable = lossOfSynchronism === null;
  return {
    t: Float32Array.from(T),
    machines: src.map((s, k) => ({ id: s.id, name: s.name, delta: Float32Array.from(D[k]), speed: Float32Array.from(W[k]), pe: Float32Array.from(P[k]) })),
    busIds: net.busIds, voltages: V.map(a => Float32Array.from(a)), events: applied, stable, lossOfSynchronism,
    angleReference: hasGrid ? 'grid' : 'coi', steps,
    message: stable ? 'All machines stay in synchronism.' : `Loss of synchronism at ${(/** @type {number} */ (lossOfSynchronism)).toFixed(3)} s.`,
  };
}

/** A source from its load-flow operating point: E′ = V + Z·I with I = conj(S/V).
 * @param {string} id @param {string} name @param {number} bus @param {number} r @param {number} x @param {number} p @param {number} q
 * @param {number} vr @param {number} vi @param {number} h @param {number} d @param {boolean} grid */
function machineFrom(id, name, bus, r, x, p, q, vr, vi, h, d, grid) {
  const v2 = vr * vr + vi * vi;
  const ir = (p * vr + q * vi) / v2, ii = (p * vi - q * vr) / v2; // conj(S/V)
  const er = vr + r * ir - x * ii, ei = vi + r * ii + x * ir;
  const den = r * r + x * x;
  return { id, name, bus, yr: r / den, yi: -x / den, e: Math.hypot(er, ei), delta: Math.atan2(ei, er), w: 1, pm: p, h, d, grid, on: true };
}

/** Largest rotor angle difference between machines in service, grids included, net of transformer phase shifts.
 * @param {Array<{ on: boolean, bus: number }>} src @param {Float64Array} delta @param {Float64Array} nominal */
function separation(src, delta, nominal) {
  let lo = Infinity, hi = -Infinity;
  src.forEach((s, k) => { if (s.on) { const a = delta[k] - nominal[s.bus]; lo = Math.min(lo, a); hi = Math.max(hi, a); } });
  return hi - lo;
}
