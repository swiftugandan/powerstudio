/** Short-circuit currents by the method of the equivalent voltage source at the fault location, following
 * IEC 60909-0. This is an IEC 60909-style calculation, not a certified one: docs/ENGINE.md, "Short circuit", lists the
 * clauses it implements, the simplifications it makes and the reference it is checked against.
 *
 * For each faulted busbar k the only source is c·Un/√3 at k; machines and grids become impedances. The Thevenin
 * impedance Zkk is read from the solution of Y·z = e_k for the positive (and, for earth faults, zero) sequence network.
 * The negative-sequence network equals the positive one. */

import { compileNetwork, linePu, trafoPu, twoPort } from './network.js';
import { cluFactor, cluSolve, SingularMatrixError } from './linalg.js';
import { busesOf } from './document.js';

/**
 * @typedef {import('./document.js').PowerDocument} PowerDocument
 * @typedef {import('./catalog.js').Element} Element
 * @typedef {import('./network.js').Complex} Complex
 * @typedef {'3ph' | '2ph' | '1ph'} FaultType
 * @typedef {{ id: string, ikss: number, ip: number, ith: number, skss: number, kappa: number, rx: number, c: number,
 *   r1: number, x1: number, r0: number, x0: number }} FaultResult
 * @typedef {{ id: string, iFrom: number, iTo: number }} BranchContribution
 * @typedef {{ fault: FaultType, mode: 'max' | 'min', kappaMethod: 'B' | 'C', buses: FaultResult[],
 *   location: string, contributions: BranchContribution[], deenergized: string[], warnings: string[] }} ShortCircuitResult
 * @typedef {{ fault?: FaultType, mode?: 'max' | 'min', kappa?: 'B' | 'C', lvTolerance?: '6' | '10', location?: string, tk?: number }} ShortCircuitOptions
 */

const SQRT3 = Math.sqrt(3);
/** @param {number} re @param {number} im @returns {Complex} */
const c = (re, im) => ({ re, im });
/** @param {Complex} z @returns {Complex} */
const inv = z => { const d = z.re * z.re + z.im * z.im; return c(z.re / d, -z.im / d); };

/** Voltage factors cmax and cmin for a nominal voltage (IEC 60909-0 Table 1, as implemented by pandapower).
 * @param {number} vn kV @param {'6' | '10'} lvTolerance */
export function voltageFactor(vn, lvTolerance) {
  if (vn < 1) return lvTolerance === '6' ? { cmax: 1.05, cmin: 0.95 } : { cmax: 1.1, cmin: 0.9 };
  return { cmax: 1.1, cmin: 1.0 };
}

/** Transformer impedance correction factor KT = 0.95·cmax / (1 + 0.6·xT) (IEC 60909-0, 6.3.3).
 * @param {Element} el @param {number} cmax */
export function trafoCorrection(el, cmax) {
  const uk = /** @type {number} */ (el.uk) / 100, ur = /** @type {number} */ (el.ur) / 100;
  return 0.95 * cmax / (1 + 0.6 * Math.sqrt(Math.max(uk * uk - ur * ur, 0)));
}

/** Generator impedance correction factor KG = Un/UrG · cmax / (1 + x″d·sin φrG) (IEC 60909-0, 6.6.1).
 * @param {Element} el @param {number} un @param {number} cmax */
export function genCorrection(el, un, cmax) {
  const cos = /** @type {number} */ (el.cosphi), sin = Math.sqrt(Math.max(1 - cos * cos, 0));
  return un / /** @type {number} */ (el.vn) * cmax / (1 + /** @type {number} */ (el.xdss) * sin);
}

/** Fictitious generator resistance for the peak current, as a fraction of X″d (IEC 60909-0, 6.6.1).
 * @param {Element} el */
export function fictitiousResistanceRatio(el) {
  if (/** @type {number} */ (el.vn) <= 1) return 0.15;
  return /** @type {number} */ (el.sn) >= 100 ? 0.05 : 0.07;
}

/** κ = 1.02 + 0.98·e^(−3R/X) (IEC 60909-0, 8.1). @param {number} rx */
export const kappaOf = rx => 1.02 + 0.98 * Math.exp(-3 * rx);

/**
 * Runs the short-circuit calculation at every busbar or at one location.
 * @param {PowerDocument} doc @param {ShortCircuitOptions} [options] @returns {ShortCircuitResult}
 */
export function runShortCircuit(doc, options = {}) {
  const st = doc.study.shortcircuit;
  const fault = options.fault ?? st.fault, mode = options.mode ?? st.mode, kappaMethod = options.kappa ?? st.kappa;
  const lvTol = options.lvTolerance ?? st.lvTolerance, location = options.location ?? st.location, tk = options.tk ?? 1;
  const net = compileNetwork(doc);
  const n = net.nb, sb = doc.baseMVA, f = doc.frequency;
  const warnings = net.warnings.filter(w => !w.includes('reference machine'));
  const cBus = Array.from(net.vbase, v => voltageFactor(v, lvTol)[mode === 'max' ? 'cmax' : 'cmin']);
  const cmaxBus = Array.from(net.vbase, v => voltageFactor(v, lvTol).cmax);
  const active = doc.elements.filter(e => e.inService !== false);

  /** Assembles a sequence network. @param {0 | 1} seq @param {number} freqScale X multiplier for the equivalent-frequency method */
  const assemble = (seq, freqScale = 1, peak = false) => {
    const re = new Float64Array(n * n), im = new Float64Array(n * n);
    /** @param {number} i @param {number} j @param {Complex} y */
    const add = (i, j, y) => { re[i * n + j] += y.re; im[i * n + j] += y.im; };
    /** @param {Complex} z */
    const scaleX = z => c(z.re, z.im * freqScale);
    /** @param {number} i @param {number} j @param {{ yff: Complex, yft: Complex, ytf: Complex, ytt: Complex }} p */
    const stamp = (i, j, p) => { add(i, i, p.yff); add(i, j, p.yft); add(j, i, p.ytf); add(j, j, p.ytt); };
    for (const el of active) {
      if (el.cls !== 'line' && el.cls !== 'trafo') continue;
      const [a, b] = busesOf(el).map(id => net.busIndex.get(id));
      if (a === undefined || b === undefined) continue;
      if (el.cls === 'line') {
        const { z, b: bsh } = linePu(el, net.vbase[a], sb, seq);
        // Line capacitances are neglected in the positive sequence (IEC 60909-0, 6.4) and kept in the zero sequence.
        stamp(a, b, twoPort(scaleX(z), c(0, seq === 0 ? bsh * freqScale : 0), 1, 0));
        continue;
      }
      const kt = mode === 'max' ? trafoCorrection(el, cmaxBus[b]) : 1;
      if (seq === 1) {
        const { z, ratio, shift } = trafoPu(el, net.vbase[a], net.vbase[b], sb, { correction: kt });
        stamp(a, b, twoPort(scaleX(z), c(0, 0), ratio, shift));
        continue;
      }
      const group = /** @type {string} */ (el.vectorGroup).replace(/\d+$/, '');
      if (group === 'Dyn' || group === 'YNyn') {
        const { z, ratio } = trafoPu(el, net.vbase[a], net.vbase[b], sb, { correction: kt, seq: 0 });
        if (group === 'Dyn') add(b, b, inv(scaleX(z)));
        else stamp(a, b, twoPort(scaleX(z), c(0, 0), ratio, 0));
      } else if (group === 'YNd') {
        // Zero-sequence impedance seen from the earthed HV winding, on the HV busbar's base.
        const vnh = /** @type {number} */ (el.vnHV) * (1 + (/** @type {number} */ (el.tapPos) - /** @type {number} */ (el.tapNeutral)) * /** @type {number} */ (el.tapStep) / 100);
        const k = (sb / /** @type {number} */ (el.sn)) * (vnh / net.vbase[a]) ** 2 * kt;
        const uk0 = /** @type {number} */ (el.uk0) / 100, ur0 = /** @type {number} */ (el.ur0) / 100;
        add(a, a, inv(scaleX(c(ur0 * k, Math.sqrt(Math.max(uk0 * uk0 - ur0 * ur0, 0)) * k))));
      }
    }
    for (const el of active) {
      const i = net.busIndex.get(/** @type {string} */ (el.bus));
      if (i === undefined) continue;
      if (el.cls === 'extgrid') {
        const sk = /** @type {number} */ (mode === 'max' ? el.skMax : el.skMin), rx = /** @type {number} */ (mode === 'max' ? el.rxMax : el.rxMin);
        const zq = cBus[i] * sb / sk, xq = zq / Math.sqrt(1 + rx * rx);
        if (seq === 1) add(i, i, inv(scaleX(c(rx * xq, xq))));
        else {
          const x0 = /** @type {number} */ (el.x0x1) * xq;
          add(i, i, inv(scaleX(c(/** @type {number} */ (el.r0x0) * x0, x0))));
        }
      } else if (el.cls === 'gen' && seq === 1) {
        const zb = net.vbase[i] ** 2 / sb, zr = /** @type {number} */ (el.vn) ** 2 / /** @type {number} */ (el.sn);
        const x = /** @type {number} */ (el.xdss) * zr / zb;
        const r = peak ? fictitiousResistanceRatio(el) * x : /** @type {number} */ (el.rs) * zr / zb;
        const kg = genCorrection(el, net.vbase[i], cmaxBus[i]);
        add(i, i, inv(scaleX(c(r * kg, x * kg))));
      }
    }
    if (seq === 0) for (let i = 0; i < n; i++) re[i * n + i] += 1e-10; // keeps unearthed parts of the zero sequence solvable
    return { re, im };
  };

  /** @param {{ re: Float64Array, im: Float64Array }} Y */
  const factor = Y => { try { return cluFactor(Y.re, Y.im, n); } catch (e) { if (e instanceof SingularMatrixError) return null; throw e; } };
  const targets = location ? [net.busIndex.get(location)].filter(i => i !== undefined) : [...Array(n).keys()];
  if (location && !targets.length) warnings.push(`The fault location ${location} is not an energised busbar.`);
  const Y1 = assemble(1), F1 = n ? factor(Y1) : null;
  const F0 = fault === '1ph' && n ? factor(assemble(0)) : null;
  const Fc = kappaMethod === 'C' && n ? factor(assemble(1, (f === 60 ? 24 : 20) / f, true)) : null;
  const meshedRX = kappaMethod === 'B' ? branchRatios(doc) : 0;
  if (!F1) warnings.push('The positive-sequence network is singular; check for busbars without any impedance path.');

  /** @param {import('./linalg.js').ComplexLU | null} F @param {number} k */
  const zkk = (F, k) => {
    if (!F) return c(NaN, NaN);
    const br = new Float64Array(n), bi = new Float64Array(n);
    br[k] = 1;
    const z = cluSolve(F, br, bi);
    return { re: z.re[k], im: z.im[k], col: z };
  };

  /** @type {FaultResult[]} */
  const buses = [];
  for (const k of targets) {
    const z1 = zkk(F1, k), z0 = fault === '1ph' ? zkk(F0, k) : c(NaN, NaN);
    const vb = net.vbase[k], cc = cBus[k], zb = vb * vb / sb;
    // In ohms, with Un in kV the currents come out in kA:
    // three-phase c·Un/(√3·|Z1|), line-to-line c·Un/|Z1 + Z2|, line-to-earth √3·c·Un/|Z1 + Z2 + Z0|, with Z2 = Z1.
    const ikss = fault === '3ph' ? cc * vb / (SQRT3 * Math.hypot(z1.re, z1.im) * zb)
      : fault === '2ph' ? cc * vb / (2 * Math.hypot(z1.re, z1.im) * zb)
      : SQRT3 * cc * vb / (Math.hypot(2 * z1.re + z0.re, 2 * z1.im + z0.im) * zb);
    let kappa;
    if (kappaMethod === 'C') {
      const zc = zkk(Fc, k);
      kappa = kappaOf(zc.re / zc.im * ((f === 60 ? 24 : 20) / f));
    } else {
      const limit = vb < 1 ? 1.8 : 2.0;
      kappa = Math.min(Math.max((meshedRX >= 0.3 ? 1.15 : 1) * kappaOf(z1.re / z1.im), 1), limit);
    }
    const ip = kappa * Math.SQRT2 * ikss;
    const lk = Math.log(kappa - 1);
    const m = kappa > 1.99 ? 0 : (Math.exp(4 * f * tk * lk) - 1) / (2 * f * tk * lk);
    const ith = ikss * Math.sqrt(m + 1);
    buses.push({ id: net.busIds[k], ikss, ip, ith, skss: SQRT3 * vb * ikss, kappa, rx: z1.re / z1.im, c: cc,
      r1: z1.re * zb, x1: z1.im * zb, r0: z0.re * zb, x0: z0.im * zb });
  }

  /** @type {BranchContribution[]} */
  const contributions = [];
  if (location && targets.length === 1 && F1 && fault === '3ph') {
    const k = /** @type {number} */ (targets[0]);
    const z = /** @type {{ col: { re: Float64Array, im: Float64Array } }} */ (/** @type {unknown} */ (zkk(F1, k))).col;
    const zk = c(z.re[k], z.im[k]);
    // Fault current If = c / Zkk; voltage change at every node ΔV = −Z(:,k)·If.
    const d = zk.re * zk.re + zk.im * zk.im, cc = cBus[k];
    const ifr = cc * zk.re / d, ifi = -cc * zk.im / d;
    const dvr = Float64Array.from(z.re, (zr, i) => -(zr * ifr - z.im[i] * ifi));
    const dvi = Float64Array.from(z.re, (zr, i) => -(zr * ifi + z.im[i] * ifr));
    for (const el of active) {
      if (el.cls !== 'line' && el.cls !== 'trafo') continue;
      const [a, b] = busesOf(el).map(id => net.busIndex.get(id));
      if (a === undefined || b === undefined) continue;
      const p = el.cls === 'line'
        ? twoPort(linePu(el, net.vbase[a], sb).z, c(0, 0), 1, 0)
        : (() => { const t = trafoPu(el, net.vbase[a], net.vbase[b], sb, { correction: mode === 'max' ? trafoCorrection(el, cmaxBus[b]) : 1 }); return twoPort(t.z, c(0, 0), t.ratio, t.shift); })();
      const iFr = p.yff.re * dvr[a] - p.yff.im * dvi[a] + p.yft.re * dvr[b] - p.yft.im * dvi[b];
      const iFi = p.yff.re * dvi[a] + p.yff.im * dvr[a] + p.yft.re * dvi[b] + p.yft.im * dvr[b];
      const iTr = p.ytf.re * dvr[a] - p.ytf.im * dvi[a] + p.ytt.re * dvr[b] - p.ytt.im * dvi[b];
      const iTi = p.ytf.re * dvi[a] + p.ytf.im * dvr[a] + p.ytt.re * dvi[b] + p.ytt.im * dvr[b];
      contributions.push({ id: el.id, iFrom: Math.hypot(iFr, iFi) * sb / (SQRT3 * net.vbase[a]), iTo: Math.hypot(iTr, iTi) * sb / (SQRT3 * net.vbase[b]) });
    }
  }
  return { fault, mode, kappaMethod, buses, location: location || '', contributions, deenergized: net.deenergized, warnings };
}

/** Largest R/X ratio over all series branches, used by method B to decide on the 1.15 safety factor.
 * @param {PowerDocument} doc */
function branchRatios(doc) {
  let worst = 0;
  for (const el of doc.elements) {
    if (el.inService === false) continue;
    if (el.cls === 'line') worst = Math.max(worst, /** @type {number} */ (el.r1) / /** @type {number} */ (el.x1));
    if (el.cls === 'trafo') {
      const uk = /** @type {number} */ (el.uk), ur = /** @type {number} */ (el.ur);
      worst = Math.max(worst, ur / Math.sqrt(Math.max(uk * uk - ur * ur, 1e-12)));
    }
  }
  return worst;
}
