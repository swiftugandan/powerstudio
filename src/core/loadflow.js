/** AC load flow by the Newton-Raphson method in polar coordinates.
 *
 * Busbars are reference (slack), PV or PQ. Mismatches are the complex power S = V·conj(Y·V) minus the scheduled
 * injection; the Jacobian is built from ∂S/∂θ and ∂S/∂|V| as in MATPOWER's dSbus_dV, and solved densely. Reactive
 * power limits are enforced in an outer loop that fixes violating machines at their limit and solves again.
 * docs/ENGINE.md, "Load flow", states the equations and conventions. */

import { compileNetwork, buildYbus, nominalAngles } from './network.js';
import { luFactor, luSolve, SingularMatrixError } from './linalg.js';
import { dcAngles } from './dcflow.js';

/**
 * @typedef {import('./document.js').PowerDocument} PowerDocument
 * @typedef {import('./network.js').Network} Network
 * @typedef {{ vm: Float64Array, va: Float64Array }} VoltageState
 * @typedef {{ id: string, vm: number, va: number, kv: number, p: number, q: number, type: 'Ref' | 'PV' | 'PQ' }} BusResult
 * @typedef {{ id: string, cls: 'line' | 'trafo', pFrom: number, qFrom: number, pTo: number, qTo: number,
 *   iFrom: number, iTo: number, pLoss: number, qLoss: number, loading: number }} BranchResult
 * @typedef {{ id: string, p: number, q: number, atLimit?: 'min' | 'max' }} UnitResult
 * @typedef {{
 *   converged: boolean, iterations: number, mismatch: number, log: Array<{ iteration: number, mismatch: number }>,
 *   message: string, buses: BusResult[], branches: BranchResult[], gens: UnitResult[], grids: UnitResult[],
 *   loads: UnitResult[], shunts: UnitResult[], deenergized: string[], warnings: string[],
 *   totals: { generation: number, load: number, losses: number, generationQ: number, loadQ: number },
 *   state: VoltageState, busIds: string[],
 * }} LoadFlowResult
 * @typedef {{ tolerance?: number, maxIter?: number, enforceQLimits?: boolean, loadScale?: number, dcStart?: boolean,
 *   start?: { busIds: string[], vm: ArrayLike<number>, va: ArrayLike<number> }, outages?: Set<string> }} LoadFlowOptions
 */

const DEG = 180 / Math.PI;

/**
 * Runs a load flow on a document. Options default to the document's study case.
 * @param {PowerDocument} doc @param {LoadFlowOptions} [options] @returns {LoadFlowResult}
 */
export function runLoadFlow(doc, options = {}) {
  const lf = doc.study.loadflow;
  const opt = {
    tolerance: options.tolerance ?? lf.tolerance,
    maxIter: options.maxIter ?? lf.maxIter,
    enforceQLimits: options.enforceQLimits ?? lf.enforceQLimits,
    loadScale: options.loadScale ?? lf.loadScale / 100,
    dcStart: options.dcStart ?? lf.dcStart,
  };
  const net = compileNetwork(doc, { loadScale: opt.loadScale, outages: options.outages });
  return solveNetwork(net, { ...opt, start: options.start });
}

/**
 * Solves a compiled network.
 * @param {Network} net
 * @param {{ tolerance: number, maxIter: number, enforceQLimits: boolean, dcStart?: boolean, start?: LoadFlowOptions['start'] }} opt
 * @returns {LoadFlowResult}
 */
export function solveNetwork(net, opt) {
  const n = net.nb, sb = net.baseMVA;
  const Y = buildYbus(net);
  const fixedQ = new Map(); // gen id → { q, limit }
  const warnings = [...net.warnings];
  let { vm, va } = initialState(net, opt.start);
  if (opt.dcStart !== false && !opt.start && n > 0) {
    const dc = dcAngles(net, schedule(net, fixedQ));
    if (dc) va = dc;
  }
  /** @type {Array<{ iteration: number, mismatch: number }>} */
  const log = [];
  let converged = false, iterations = 0, mismatch = Infinity, message = '';

  if (n === 0) {
    return assemble(net, Y, { vm, va }, { converged: false, iterations: 0, mismatch: 0, log, message: 'No energised busbars: the network has no external grid or generator.', fixedQ, warnings });
  }

  for (let round = 0; round < 20; round++) {
    const spec = schedule(net, fixedQ);
    const out = newton(Y, n, spec, vm, va, opt.tolerance / sb, opt.maxIter, log, iterations);
    vm = out.vm; va = out.va; iterations = out.iterations; mismatch = out.mismatch * sb; converged = out.converged; message = out.message;
    if (!converged || !opt.enforceQLimits) break;
    const violations = qViolations(net, Y, vm, va, spec, fixedQ);
    if (!violations.length) break;
    for (const v of violations) {
      fixedQ.set(v.id, { q: v.limit === 'max' ? v.qmax : v.qmin, limit: v.limit });
      warnings.push(`${net.names.get(v.id) ?? v.id} reached its ${v.limit === 'max' ? 'upper' : 'lower'} reactive power limit and now holds ${((v.limit === 'max' ? v.qmax : v.qmin) * sb).toFixed(2)} Mvar.`);
    }
    if (round === 19) { converged = false; message = 'Reactive power limits did not settle after 20 rounds.'; }
  }
  return assemble(net, Y, { vm, va }, { converged, iterations, mismatch, log, message, fixedQ, warnings });
}

/**
 * Initial voltages: setpoints in magnitude and the nominal angles (every transformer phase shift applied from the
 * reference), so a flat start already sits near the solution.
 * @param {Network} net @param {LoadFlowOptions['start']} start @returns {VoltageState}
 */
function initialState(net, start) {
  const n = net.nb, vm = new Float64Array(n).fill(1), seed = new Float64Array(n);
  for (const g of net.grids) { vm[g.bus] = g.vset; seed[g.bus] = g.angle / DEG; }
  for (const g of net.gens) {
    if (g.mode === 'PQ') continue;
    vm[g.bus] = g.vset;
    if (g.mode === 'Reference') seed[g.bus] = g.angle / DEG;
  }
  for (const g of net.grids) vm[g.bus] = g.vset;
  const va = nominalAngles(net, seed);
  if (start) {
    const idx = new Map(start.busIds.map((id, i) => [id, i]));
    net.busIds.forEach((id, i) => {
      const k = idx.get(id);
      if (k === undefined) return;
      va[i] = start.va[k] / DEG;
      if (!isControlled(net, i)) vm[i] = start.vm[k];
    });
  }
  return { vm, va };
}

/** @param {Network} net @param {number} bus */
function isControlled(net, bus) {
  return net.grids.some(g => g.bus === bus) || net.gens.some(g => g.bus === bus && g.mode !== 'PQ');
}

/**
 * Bus types and scheduled injections, given the machines currently fixed at a reactive power limit.
 * @param {Network} net @param {Map<string, { q: number }>} fixedQ
 */
export function schedule(net, fixedQ) {
  const n = net.nb, type = new Uint8Array(n).fill(1), p = new Float64Array(n), q = new Float64Array(n);
  for (const l of net.loads) { p[l.bus] -= l.p; q[l.bus] -= l.q; }
  for (const g of net.gens) {
    if (g.mode === 'Reference') { type[g.bus] = 3; continue; }
    p[g.bus] += g.p;
    const fixed = fixedQ.get(g.id);
    if (g.mode === 'PQ') q[g.bus] += g.q;
    else if (fixed) q[g.bus] += fixed.q;
    else if (type[g.bus] === 1) type[g.bus] = 2;
  }
  for (const g of net.grids) type[g.bus] = 3;
  return { type, p, q };
}

/**
 * Newton-Raphson iterations. Returns the final state, whether it converged and the largest mismatch in per unit.
 * @param {{ re: Float64Array, im: Float64Array }} Y @param {number} n
 * @param {{ type: Uint8Array, p: Float64Array, q: Float64Array }} spec
 * @param {Float64Array} vm0 @param {Float64Array} va0 @param {number} tol @param {number} maxIter
 * @param {Array<{ iteration: number, mismatch: number }>} log @param {number} done iterations already spent
 */
function newton(Y, n, spec, vm0, va0, tol, maxIter, log, done) {
  const vm = Float64Array.from(vm0), va = Float64Array.from(va0);
  /** @type {number[]} */
  const pvpq = [];
  /** @type {number[]} */
  const pq = [];
  for (let i = 0; i < n; i++) { if (spec.type[i] !== 3) pvpq.push(i); if (spec.type[i] === 1) pq.push(i); }
  const np = pvpq.length, nq = pq.length, dim = np + nq;
  const colA = new Int32Array(n).fill(-1), colM = new Int32Array(n).fill(-1);
  pvpq.forEach((b, k) => { colA[b] = k; });
  pq.forEach((b, k) => { colM[b] = np + k; });
  const vr = new Float64Array(n), vi = new Float64Array(n), ir = new Float64Array(n), ii = new Float64Array(n);
  const sr = new Float64Array(n), si = new Float64Array(n);

  const evaluate = () => {
    for (let i = 0; i < n; i++) { vr[i] = vm[i] * Math.cos(va[i]); vi[i] = vm[i] * Math.sin(va[i]); }
    for (let i = 0; i < n; i++) {
      let ar = 0, ai = 0;
      const row = i * n;
      for (let k = 0; k < n; k++) {
        const yr = Y.re[row + k], yi = Y.im[row + k];
        if (yr === 0 && yi === 0) continue;
        ar += yr * vr[k] - yi * vi[k];
        ai += yr * vi[k] + yi * vr[k];
      }
      ir[i] = ar; ii[i] = ai;
      sr[i] = vr[i] * ar + vi[i] * ai;
      si[i] = vi[i] * ar - vr[i] * ai;
    }
    const F = new Float64Array(dim);
    let worst = 0;
    for (let k = 0; k < np; k++) { const b = pvpq[k]; F[k] = sr[b] - spec.p[b]; worst = Math.max(worst, Math.abs(F[k])); }
    for (let k = 0; k < nq; k++) { const b = pq[k]; F[np + k] = si[b] - spec.q[b]; worst = Math.max(worst, Math.abs(F[np + k])); }
    return { F, worst };
  };

  let { F, worst } = evaluate();
  let it = 0;
  log.push({ iteration: done, mismatch: worst });
  if (dim === 0 || worst < tol) return { vm, va, iterations: done, mismatch: worst, converged: true, message: 'Converged.' };
  while (it < maxIter) {
    const J = new Float64Array(dim * dim);
    for (let i = 0; i < n; i++) {
      const ra = colA[i], rm = colM[i];
      if (ra < 0 && rm < 0) continue; // reference bus: no equations
      const row = i * n;
      for (let k = 0; k < n; k++) {
        const yr = Y.re[row + k], yi = Y.im[row + k];
        const diag = i === k;
        if (yr === 0 && yi === 0 && !diag) continue;
        // dS/dθk = j·Vi·conj(δik·Ii − Yik·Vk)
        let ar = -(yr * vr[k] - yi * vi[k]), ai = -(yr * vi[k] + yi * vr[k]);
        if (diag) { ar += ir[i]; ai += ii[i]; }
        // conj(a) = (ar, -ai); Vi·conj(a) = (vr·ar + vi·ai, vi·ar − vr·ai); times j → (−(vi·ar − vr·ai), vr·ar + vi·ai)
        const dAr = -(vi[i] * ar - vr[i] * ai), dAi = vr[i] * ar + vi[i] * ai;
        // dS/d|Vk| = Vi·conj(Yik·Vk/|Vk|) + δik·conj(Ii)·Vi/|Vi|
        const ur = vr[k] / vm[k], ui = vi[k] / vm[k];
        const br = yr * ur - yi * ui, bi = yr * ui + yi * ur;
        let dMr = vr[i] * br + vi[i] * bi, dMi = vi[i] * br - vr[i] * bi;
        if (diag) { dMr += ir[i] * ur + ii[i] * ui; dMi += ir[i] * ui - ii[i] * ur; }
        const ca = colA[k], cm = colM[k];
        if (ra >= 0) {
          if (ca >= 0) J[ra * dim + ca] = dAr;
          if (cm >= 0) J[ra * dim + cm] = dMr;
        }
        if (rm >= 0) {
          if (ca >= 0) J[rm * dim + ca] = dAi;
          if (cm >= 0) J[rm * dim + cm] = dMi;
        }
      }
    }
    let dx;
    try { dx = luSolve(luFactor(J, dim), F); }
    catch (error) {
      if (error instanceof SingularMatrixError) return { vm, va, iterations: done + it, mismatch: worst, converged: false, message: 'The Jacobian is singular: check for isolated machines or zero impedances.' };
      throw error;
    }
    for (let k = 0; k < np; k++) va[pvpq[k]] -= dx[k];
    for (let k = 0; k < nq; k++) vm[pq[k]] -= dx[np + k];
    it++;
    ({ F, worst } = evaluate());
    log.push({ iteration: done + it, mismatch: worst });
    if (!Number.isFinite(worst) || worst > 1e8) return { vm, va, iterations: done + it, mismatch: worst, converged: false, message: 'The load flow diverged.' };
    if (worst < tol) return { vm, va, iterations: done + it, mismatch: worst, converged: true, message: 'Converged.' };
  }
  return { vm, va, iterations: done + it, mismatch: worst, converged: false, message: `No convergence after ${maxIter} iterations.` };
}

/** Bus power injections S = V·conj(Y·V). @param {{ re: Float64Array, im: Float64Array }} Y @param {number} n
 * @param {Float64Array} vm @param {Float64Array} va */
export function injections(Y, n, vm, va) {
  const vr = Float64Array.from(vm, (m, i) => m * Math.cos(va[i])), vi = Float64Array.from(vm, (m, i) => m * Math.sin(va[i]));
  const p = new Float64Array(n), q = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let ar = 0, ai = 0;
    for (let k = 0; k < n; k++) {
      const yr = Y.re[i * n + k], yi = Y.im[i * n + k];
      ar += yr * vr[k] - yi * vi[k]; ai += yr * vi[k] + yi * vr[k];
    }
    p[i] = vr[i] * ar + vi[i] * ai; q[i] = vi[i] * ar - vr[i] * ai;
  }
  return { p, q };
}

/**
 * Reactive power of every unit: references and grids take the bus's balance, PV machines share the remaining
 * reactive balance in proportion to their reactive range, as MATPOWER does.
 * @param {Network} net @param {{ p: Float64Array, q: Float64Array }} S @param {Map<string, { q: number }>} fixedQ
 */
function dispatch(net, S, fixedQ) {
  const n = net.nb;
  const pBal = Float64Array.from(S.p), qBal = Float64Array.from(S.q);
  for (const l of net.loads) { pBal[l.bus] += l.p; qBal[l.bus] += l.q; }
  /** @type {Map<string, { p: number, q: number }>} */
  const out = new Map();
  for (const g of net.gens) {
    if (g.mode === 'Reference') continue;
    pBal[g.bus] -= g.p;
    const fixed = fixedQ.get(g.id);
    if (g.mode === 'PQ' || fixed) { const q = g.mode === 'PQ' ? g.q : /** @type {{ q: number }} */ (fixed).q; qBal[g.bus] -= q; out.set(g.id, { p: g.p, q }); }
  }
  for (let b = 0; b < n; b++) {
    const slackUnits = [...net.grids.filter(g => g.bus === b).map(g => g.id), ...net.gens.filter(g => g.bus === b && g.mode === 'Reference').map(g => g.id)];
    const pv = net.gens.filter(g => g.bus === b && g.mode === 'PV' && !fixedQ.has(g.id));
    for (const g of pv) out.set(g.id, { p: g.p, q: 0 });
    if (slackUnits.length) {
      for (const id of slackUnits) out.set(id, { p: pBal[b] / slackUnits.length, q: qBal[b] / slackUnits.length });
    } else if (pv.length) {
      const ranges = pv.map(g => Math.max(g.qmax - g.qmin, 0));
      const total = ranges.reduce((s, r) => s + r, 0);
      pv.forEach((g, k) => {
        const share = total > 0 ? ranges[k] / total : 1 / pv.length;
        /** @type {{ p: number, q: number }} */ (out.get(g.id)).q = qBal[b] * share;
      });
    }
  }
  return out;
}

/**
 * PV machines outside their reactive power range at the current solution.
 * @param {Network} net @param {{ re: Float64Array, im: Float64Array }} Y @param {Float64Array} vm @param {Float64Array} va
 * @param {{ type: Uint8Array }} spec @param {Map<string, { q: number }>} fixedQ
 */
function qViolations(net, Y, vm, va, spec, fixedQ) {
  const units = dispatch(net, injections(Y, net.nb, vm, va), fixedQ);
  const out = [];
  for (const g of net.gens) {
    if (g.mode !== 'PV' || fixedQ.has(g.id) || spec.type[g.bus] === 3) continue;
    const q = /** @type {{ q: number }} */ (units.get(g.id)).q, eps = 1e-9;
    if (q > g.qmax + eps) out.push({ id: g.id, limit: /** @type {const} */ ('max'), qmax: g.qmax, qmin: g.qmin });
    else if (q < g.qmin - eps) out.push({ id: g.id, limit: /** @type {const} */ ('min'), qmax: g.qmax, qmin: g.qmin });
  }
  return out;
}

/**
 * Converts the solved state into engineering results.
 * @param {Network} net @param {{ re: Float64Array, im: Float64Array }} Y @param {VoltageState} state
 * @param {{ converged: boolean, iterations: number, mismatch: number, log: Array<{ iteration: number, mismatch: number }>,
 *   message: string, fixedQ: Map<string, { q: number, limit: 'min' | 'max' }>, warnings: string[] }} info
 * @returns {LoadFlowResult}
 */
function assemble(net, Y, state, info) {
  const sb = net.baseMVA, n = net.nb, { vm, va } = state;
  const S = injections(Y, n, vm, va);
  const spec = schedule(net, info.fixedQ);
  const typeName = /** @type {const} */ (['PQ', 'PQ', 'PV', 'Ref']);
  const buses = net.busIds.map((id, i) => ({ id, vm: vm[i], va: va[i] * DEG, kv: vm[i] * net.vbase[i], p: S.p[i] * sb, q: S.q[i] * sb, type: typeName[spec.type[i]] }));
  const vr = Float64Array.from(vm, (m, i) => m * Math.cos(va[i])), vi = Float64Array.from(vm, (m, i) => m * Math.sin(va[i]));
  let losses = 0;
  const branches = net.branches.map(br => {
    const { f, t } = br;
    const ifr = br.yff.re * vr[f] - br.yff.im * vi[f] + br.yft.re * vr[t] - br.yft.im * vi[t];
    const ifi = br.yff.re * vi[f] + br.yff.im * vr[f] + br.yft.re * vi[t] + br.yft.im * vr[t];
    const itr = br.ytf.re * vr[f] - br.ytf.im * vi[f] + br.ytt.re * vr[t] - br.ytt.im * vi[t];
    const iti = br.ytf.re * vi[f] + br.ytf.im * vr[f] + br.ytt.re * vi[t] + br.ytt.im * vr[t];
    const pFrom = (vr[f] * ifr + vi[f] * ifi) * sb, qFrom = (vi[f] * ifr - vr[f] * ifi) * sb;
    const pTo = (vr[t] * itr + vi[t] * iti) * sb, qTo = (vi[t] * itr - vr[t] * iti) * sb;
    // |I| in kA = |I pu| · S_base / (√3 · U_base)
    const iFrom = Math.hypot(ifr, ifi) * sb / (Math.sqrt(3) * br.vbaseF), iTo = Math.hypot(itr, iti) * sb / (Math.sqrt(3) * br.vbaseT);
    const loading = br.cls === 'line'
      ? (br.ratedKA > 0 ? Math.max(iFrom, iTo) / br.ratedKA * 100 : NaN)
      : Math.max(Math.hypot(pFrom, qFrom), Math.hypot(pTo, qTo)) / br.ratedMVA * 100;
    losses += pFrom + pTo;
    return { id: br.id, cls: br.cls, pFrom, qFrom, pTo, qTo, iFrom, iTo, pLoss: pFrom + pTo, qLoss: qFrom + qTo, loading };
  });
  const units = dispatch(net, S, info.fixedQ);
  const gens = net.gens.map(g => {
    const u = units.get(g.id) ?? { p: 0, q: 0 };
    /** @type {UnitResult} */
    const r = { id: g.id, p: u.p * sb, q: u.q * sb };
    const fixed = info.fixedQ.get(g.id);
    if (fixed) r.atLimit = fixed.limit;
    return r;
  });
  const grids = net.grids.map(g => { const u = units.get(g.id) ?? { p: 0, q: 0 }; return { id: g.id, p: u.p * sb, q: u.q * sb }; });
  const loads = net.loads.map(l => ({ id: l.id, p: l.p * sb, q: l.q * sb }));
  const shunts = net.shunts.map(s => ({ id: s.id, p: s.y.re * vm[s.bus] ** 2 * sb, q: s.y.im * vm[s.bus] ** 2 * sb }));
  const generation = [...gens, ...grids].reduce((s, u) => s + u.p, 0);
  const generationQ = [...gens, ...grids].reduce((s, u) => s + u.q, 0);
  return {
    converged: info.converged, iterations: info.iterations, mismatch: info.mismatch, log: info.log.map(e => ({ iteration: e.iteration, mismatch: e.mismatch * sb })),
    message: info.message, buses, branches, gens, grids, loads, shunts, deenergized: net.deenergized, warnings: info.warnings,
    totals: { generation, load: loads.reduce((s, l) => s + l.p, 0), losses, generationQ, loadQ: loads.reduce((s, l) => s + l.q, 0) },
    state: { vm, va: Float64Array.from(va, a => a * DEG) }, busIds: net.busIds,
  };
}
