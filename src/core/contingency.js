/** N-1 contingency analysis: every selected branch or machine is taken out of service in turn and the load flow is
 * solved again from the base-case voltages. Each outage is judged against the loading limit of the study case and the
 * voltage band of every busbar. */

import { runLoadFlow } from './loadflow.js';

/**
 * @typedef {import('./document.js').PowerDocument} PowerDocument
 * @typedef {import('./loadflow.js').LoadFlowResult} LoadFlowResult
 * @typedef {{ kind: 'loading' | 'undervoltage' | 'overvoltage', id: string, value: number, limit: number, inBase: boolean }} Violation
 * @typedef {{ id: string, cls: string, converged: boolean, message: string, maxLoading: number, maxLoadingId: string,
 *   minV: number, minVBus: string, maxV: number, maxVBus: string, lostBuses: string[], violations: Violation[] }} ContingencyCase
 * @typedef {{ base: ContingencyCase, cases: ContingencyCase[], worstLoading: Record<string, { value: number, outage: string }>,
 *   worstVoltage: Record<string, { min: number, minOutage: string, max: number, maxOutage: string }>, limit: number }} ContingencyResult
 */

/**
 * @param {PowerDocument} doc
 * @param {{ onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean }} [hooks]
 * @returns {ContingencyResult}
 */
export function runContingency(doc, hooks = {}) {
  const st = doc.study.contingency, limit = st.maxLoading;
  const base = runLoadFlow(doc);
  if (!base.converged) throw new Error(`The base case does not converge: ${base.message}`);
  const buses = new Map(doc.elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
  const baseCase = judge('base', 'base', base, buses, limit, null, new Set(base.deenergized));
  const outages = doc.elements.filter(e => e.inService !== false && (
    (e.cls === 'line' && st.lines) || (e.cls === 'trafo' && st.trafos) || (e.cls === 'gen' && st.gens)));
  const start = { busIds: base.busIds, vm: base.state.vm, va: base.state.va };
  const baseDead = new Set(base.deenergized);
  /** @type {ContingencyCase[]} */
  const cases = [];
  /** @type {ContingencyResult['worstLoading']} */
  const worstLoading = {};
  /** @type {ContingencyResult['worstVoltage']} */
  const worstVoltage = {};
  outages.forEach((el, k) => {
    if (hooks.shouldStop?.()) return;
    const r = runLoadFlow(doc, { outages: new Set([el.id]), start });
    const c = judge(el.id, el.cls, r, buses, limit, baseCase, baseDead);
    cases.push(c);
    if (r.converged) {
      for (const b of r.branches) {
        if (!Number.isFinite(b.loading)) continue;
        const w = worstLoading[b.id];
        if (!w || b.loading > w.value) worstLoading[b.id] = { value: b.loading, outage: el.id };
      }
      for (const b of r.buses) {
        const w = worstVoltage[b.id] ??= { min: Infinity, minOutage: '', max: -Infinity, maxOutage: '' };
        if (b.vm < w.min) { w.min = b.vm; w.minOutage = el.id; }
        if (b.vm > w.max) { w.max = b.vm; w.maxOutage = el.id; }
      }
    }
    hooks.onProgress?.(k + 1, outages.length);
  });
  cases.sort((a, b) => Number(a.converged) - Number(b.converged) || b.violations.length - a.violations.length || b.maxLoading - a.maxLoading);
  return { base: baseCase, cases, worstLoading, worstVoltage, limit };
}

/**
 * Summarises one solved case and lists its violations.
 * @param {string} id @param {string} cls @param {LoadFlowResult} r @param {Map<string, import('./catalog.js').Element>} buses
 * @param {number} limit @param {ContingencyCase | null} base @param {Set<string>} baseDead
 * @returns {ContingencyCase}
 */
function judge(id, cls, r, buses, limit, base, baseDead) {
  const lostBuses = r.deenergized.filter(b => !baseDead.has(b));
  /** @type {ContingencyCase} */
  const c = { id, cls, converged: r.converged, message: r.message, maxLoading: NaN, maxLoadingId: '', minV: NaN, minVBus: '',
    maxV: NaN, maxVBus: '', lostBuses, violations: [] };
  if (!r.converged) return c;
  const inBase = (/** @type {string} */ kind, /** @type {string} */ elId) => !!base?.violations.some(v => v.kind === kind && v.id === elId);
  let ml = -Infinity;
  for (const b of r.branches) {
    if (!Number.isFinite(b.loading)) continue;
    if (b.loading > ml) { ml = b.loading; c.maxLoading = b.loading; c.maxLoadingId = b.id; }
    if (b.loading > limit) c.violations.push({ kind: 'loading', id: b.id, value: b.loading, limit, inBase: inBase('loading', b.id) });
  }
  let lo = Infinity, hi = -Infinity;
  for (const b of r.buses) {
    if (b.vm < lo) { lo = b.vm; c.minV = b.vm; c.minVBus = b.id; }
    if (b.vm > hi) { hi = b.vm; c.maxV = b.vm; c.maxVBus = b.id; }
    const bus = buses.get(b.id);
    if (!bus) continue;
    const vmin = /** @type {number} */ (bus.vmin), vmax = /** @type {number} */ (bus.vmax);
    if (b.vm < vmin - 1e-9) c.violations.push({ kind: 'undervoltage', id: b.id, value: b.vm, limit: vmin, inBase: inBase('undervoltage', b.id) });
    if (b.vm > vmax + 1e-9) c.violations.push({ kind: 'overvoltage', id: b.id, value: b.vm, limit: vmax, inBase: inBase('overvoltage', b.id) });
  }
  return c;
}
