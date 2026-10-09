/** Turns calculation results into diagram annotations (colours and result boxes) and a legend. */

import { mix } from '../render/displaylist.js';
import { fixed } from './format.js';

/**
 * @typedef {import('../render/scene.js').Annotation} Annotation
 * @typedef {import('../render/scene.js').Overlay} Overlay
 * @typedef {import('../render/displaylist.js').RGBA} RGBA
 * @typedef {ReturnType<typeof import('./theme.js').readPalette>} Palette
 * @typedef {{ kind: 'swatches', title: string, items: Array<{ label: string, color: RGBA }> } | { kind: 'ramp', title: string, stops: RGBA[], from: string, to: string, extra?: Array<{ label: string, color: RGBA }> }} Legend
 */

/** Loading colour: green to 60 %, amber at 90 %, red from 100 %. @param {Palette} P @param {number} pct @returns {RGBA} */
export function loadingColor(P, pct) {
  if (!Number.isFinite(pct)) return P.muted;
  if (pct <= 60) return P.res.ok;
  if (pct <= 90) return mix(P.res.ok, P.res.warn, (pct - 60) / 30);
  if (pct <= 100) return mix(P.res.warn, P.res.high, (pct - 90) / 10);
  return P.res.high;
}

/** @param {Palette} P @param {number} vm @param {number} vmin @param {number} vmax @returns {RGBA | undefined} */
export function voltageColor(P, vm, vmin, vmax) {
  if (vm < vmin) return P.res.low;
  if (vm > vmax) return P.res.high;
  return undefined;
}

/**
 * @param {'loadflow' | 'shortcircuit' | 'contingency' | 'rms'} kind @param {any} result
 * @param {import('../core/document.js').PowerDocument} doc @param {Palette} P
 * @param {{ colouring: 'results' | 'voltage', rmsIndex?: number }} opt
 * @returns {{ overlay: Overlay, legend: Legend | null }}
 */
export function buildOverlay(kind, result, doc, P, opt) {
  /** @type {Map<string, Annotation>} */
  const elements = new Map();
  const byId = new Map(doc.elements.map(e => [e.id, e]));
  const colour = opt.colouring === 'results';
  let faultAt = '';
  /** @type {Legend | null} */
  let legend = null;
  const deenergized = new Set(/** @type {string[]} */ (result?.deenergized ?? []));

  if (kind === 'loadflow') {
    /** @type {import('../core/loadflow.js').LoadFlowResult} */
    const r = result;
    for (const b of r.buses) {
      const bus = byId.get(b.id);
      elements.set(b.id, { box: [`${fixed(b.vm, 3)} p.u.  ${fixed(b.va, 2)}°`],
        color: colour && bus ? voltageColor(P, b.vm, /** @type {number} */ (bus.vmin), /** @type {number} */ (bus.vmax)) : undefined });
    }
    for (const br of r.branches) {
      elements.set(br.id, {
        color: colour ? loadingColor(P, br.loading) : undefined,
        ends: [`${fixed(br.pFrom, 1)} MW\n${fixed(br.qFrom, 1)} Mvar`, `${fixed(br.pTo, 1)} MW\n${fixed(br.qTo, 1)} Mvar`],
        mid: Number.isFinite(br.loading) ? `${fixed(br.loading, 1)} %` : undefined,
      });
    }
    for (const u of [...r.gens, ...r.grids]) elements.set(u.id, { box: [`P ${fixed(u.p, 1)} MW`, `Q ${fixed(u.q, 1)} Mvar`] });
    for (const s of r.shunts) elements.set(s.id, { box: [`Q ${fixed(s.q, 2)} Mvar`] });
    if (colour) legend = { kind: 'ramp', title: 'Loading', stops: [P.res.ok, P.res.ok, P.res.warn, P.res.high], from: '0 %', to: '≥ 100 %',
      extra: [{ label: 'Below band', color: P.res.low }, { label: 'Above band', color: P.res.high }] };
  } else if (kind === 'shortcircuit') {
    /** @type {import('../core/shortcircuit.js').ShortCircuitResult} */
    const r = result;
    faultAt = r.location;
    const maxI = Math.max(1e-9, ...r.buses.map(b => b.ikss));
    for (const b of r.buses) {
      elements.set(b.id, { box: [`Ik″ ${fixed(b.ikss, 2)} kA`, `ip  ${fixed(b.ip, 2)} kA`],
        color: colour ? mix(P.res.ok, P.res.high, Math.min(1, b.ikss / maxI)) : undefined });
    }
    const maxC = Math.max(1e-9, ...r.contributions.map(c => Math.max(c.iFrom, c.iTo)));
    for (const c of r.contributions) {
      const i = Math.max(c.iFrom, c.iTo);
      elements.set(c.id, { mid: `${fixed(i, 2)} kA`, color: colour ? mix(P.muted, P.res.high, Math.min(1, i / maxC)) : undefined });
    }
    if (colour) legend = { kind: 'ramp', title: r.location ? 'Fault current share' : 'Initial short-circuit current', stops: [P.res.ok, P.res.high], from: 'low', to: 'high' };
  } else if (kind === 'contingency') {
    /** @type {import('../core/contingency.js').ContingencyResult} */
    const r = result;
    for (const [id, w] of Object.entries(r.worstLoading)) {
      const out = byId.get(w.outage);
      elements.set(id, { mid: `${fixed(w.value, 0)} % (${out?.name || w.outage})`, color: colour ? loadingColor(P, w.value) : undefined });
    }
    for (const [id, w] of Object.entries(r.worstVoltage)) {
      const bus = byId.get(id);
      const low = bus && w.min < /** @type {number} */ (bus.vmin), high = bus && w.max > /** @type {number} */ (bus.vmax);
      elements.set(id, { box: [`min ${fixed(w.min, 3)} p.u.`, `max ${fixed(w.max, 3)} p.u.`], color: colour ? (low ? P.res.low : high ? P.res.high : undefined) : undefined });
    }
    if (colour) legend = { kind: 'ramp', title: 'Worst N-1 loading', stops: [P.res.ok, P.res.ok, P.res.warn, P.res.high], from: '0 %', to: '≥ 100 %' };
  } else if (kind === 'rms') {
    /** @type {import('../core/rms.js').RmsResult} */
    const r = result;
    const i = Math.max(0, Math.min(r.t.length - 1, opt.rmsIndex ?? r.t.length - 1));
    r.busIds.forEach((id, k) => {
      const v = r.voltages[k][i], bus = byId.get(id);
      elements.set(id, { box: [`${fixed(v, 3)} p.u.`], color: colour ? (v < 0.8 ? P.res.high : v < /** @type {number} */ (bus?.vmin ?? 0.9) ? P.res.warn : undefined) : undefined });
    });
    for (const m of r.machines) elements.set(m.id, { box: [`δ ${fixed(m.delta[i], 1)}°`, `P ${fixed(m.pe[i], 1)} MW`] });
    if (colour) legend = { kind: 'swatches', title: `t = ${fixed(r.t[i], 3)} s`, items: [{ label: 'Voltage below 0.8 p.u.', color: P.res.high }, { label: 'Below band', color: P.res.warn }] };
  }
  return { overlay: { elements, faultAt, deenergized }, legend };
}
