/** Result types of the engine's studies, and the adapter that turns its JSON reports into them.
 *
 * The engine reports in JSON, which has no NaN and no typed arrays. `adapt` restores both: a missing rating or value
 * (JSON null) becomes NaN, and voltage states and simulation traces become Float64Array and Float32Array, which the
 * plots and overlays read directly. engine/crates/ps-study defines the reports; docs/ENGINE.md describes them. */

/**
 * @typedef {'loadflow' | 'shortcircuit' | 'contingency' | 'rms' | 'emt'} CalcKind
 * @typedef {{ id: string, vm: number, va: number, kv: number, p: number, q: number, type: 'Ref' | 'PV' | 'PQ' }} BusResult
 * @typedef {{ id: string, cls: 'line' | 'trafo' | 'trafo3', winding?: number, pFrom: number, qFrom: number, pTo: number, qTo: number,
 *   iFrom: number, iTo: number, pLoss: number, qLoss: number, loading: number }} BranchResult
 * @typedef {{ id: string, p: number, q: number, atLimit?: 'min' | 'max' }} UnitResult
 * @typedef {{ buildMs: number, analyseMs: number, factorSolveMs: number, totalMs: number }} EngineTiming
 * @typedef {{ id: string, cls: 'trafo' | 'trafo3', winding: number, kind: 'ratio' | 'phase', position: number, start: number,
 *   low: number, high: number }} TapResult
 * @typedef {{ id: string, sections: number, start: number, max: number }} SectionResult
 * @typedef {{ id: string, stations: [string, string], p1: number, q1: number, p2: number, q2: number, losses: number }} HvdcResult
 * @typedef {{ control: 'slack' | 'interchange' | 'reactiveLimits' | 'phaseShifters' | 'taps' | 'shunts', changes: number }} ControlResult
 * @typedef {{ id: string, name: string, export: number, target: number, tolerance: number, controlled: boolean }} AreaResult
 * @typedef {{ id: string, p: number, q: number, vm: number }} MismatchResult
 * @typedef {{
 *   converged: boolean, iterations: number, mismatch: number, log: Array<{ iteration: number, mismatch: number }>,
 *   message: string, buses: BusResult[], branches: BranchResult[], gens: UnitResult[], grids: UnitResult[],
 *   svcs: UnitResult[], loads: UnitResult[], shunts: UnitResult[], deenergized: string[], warnings: string[],
 *   totals: { generation: number, load: number, losses: number, generationQ: number, loadQ: number },
 *   hvdc: HvdcResult[], taps: TapResult[], sections: SectionResult[], distributed: number, controls: ControlResult[], areas: AreaResult[],
 *   worst: MismatchResult[],
 *   state: { vm: Float64Array, va: Float64Array }, busIds: string[], timing: EngineTiming,
 * }} LoadFlowResult
 * @typedef {'3ph' | '2ph' | '1ph'} FaultType
 * @typedef {{ id: string, ikss: number, ip: number, ib: number, ith: number, skss: number, kappa: number, rx: number, c: number,
 *   r1: number, x1: number, r0: number, x0: number }} FaultResult Ib is the breaking current at the minimum time delay
 *   `tMin` (Ik″ for unbalanced faults), which IEC 60909 defines for maximum currents; Ith the thermal equivalent
 *   current for the duration `tK`.
 * @typedef {{ id: string, iFrom: number, iTo: number }} BranchContribution
 * @typedef {{ fault: FaultType, mode: 'max' | 'min', kappaMethod: 'B' | 'C', tMin: number, tK: number, faultR: number, faultX: number,
 *   buses: FaultResult[], location: string,
 *   contributions: BranchContribution[], deenergized: string[], warnings: string[] }} ShortCircuitResult
 * @typedef {{ kind: 'loading' | 'undervoltage' | 'overvoltage', id: string, value: number, limit: number, inBase: boolean }} Violation
 * @typedef {{ id: string, cls: string, elements: string[], converged: boolean, message: string, maxLoading: number,
 *   maxLoadingId: string, minV: number, minVBus: string, maxV: number, maxVBus: string, lostBuses: string[],
 *   violations: Violation[], screened: boolean, remedial: string[], violationsBefore: number }} ContingencyCase
 * @typedef {{ base: ContingencyCase, cases: ContingencyCase[], worstLoading: Record<string, { value: number, outage: string }>,
 *   worstVoltage: Record<string, { min: number, minOutage: string, max: number, maxOutage: string }>, limit: number,
 *   effort: { reused: number, rebuilt: number, screened: number, iterations: number },
 *   timing: { totalMs: number, buildMs: number, analyseMs: number, factorMs: number, analysesReused: number, analyses: number },
 *   notes: string[] }} ContingencyResult
 * @typedef {import('../core/document.js').SimEvent} SimEvent
 * @typedef {{ id: string, name: string, delta: Float32Array, speed: Float32Array, pe: Float32Array, q: Float32Array, efd: Float32Array,
 *   pm: Float32Array }} MachineTrace `delta` °, `speed` Hz, `pe` MW, `q` Mvar, `efd` field voltage p.u. and `pm` mechanical power MW
 *   (both empty for an external grid).
 * @typedef {{ t: Float32Array, machines: MachineTrace[], busIds: string[], voltages: Float32Array[], events: Array<SimEvent & { applied: boolean, note: string }>,
 *   stable: boolean, lossOfSynchronism: number | null, angleReference: 'grid' | 'coi', steps: number, notes: string[], message: string }} RmsResult
 *   `notes`: the models' limits widened to the operating point.
 * @typedef {[Float32Array, Float32Array, Float32Array]} Phases Traces of phases a, b and c.
 * @typedef {{ id: string, kv: number, v: Phases, peak: number, peakPu: number, peakAt: number, rmsMin: number, rmsMax: number }} EmtBus
 *   `v` phase-to-earth voltages, kV; `peak` the largest instantaneous one, kV, and `peakPu` as a share of the nominal crest
 *   √2·Un/√3; `rmsMin` and `rmsMax` the extremes of any phase's one-cycle RMS voltage after the first cycle, p.u.
 * @typedef {{ id: string, winding: number, model: 'travelling' | 'pi' | 'transformer', from: Phases, to: Phases, peak: number,
 *   peakAt: number }} EmtBranch Phase currents into the branch at each end, kA; `winding` 1 to 3 for a three-winding
 *   transformer's winding, 0 otherwise.
 * @typedef {{ id: string, name: string, i: Phases, peak: number, peakAt: number }} EmtSource Phase currents out of the
 *   source into the network, kA.
 * @typedef {{ target: string, fault: import('../core/document.js').EmtFaultType, tOn: number, tOff: number | null, i: Phases,
 *   peak: number, peakAt: number, rms: number }} EmtFault Phase currents into the fault, kA; `rms` the largest phase's
 *   RMS current over the fault's last full cycle (NaN for a fault shorter than a cycle).
 * @typedef {import('../core/document.js').EmtEvent & { applied: boolean, at: number, note: string }} EmtAppliedEvent
 * @typedef {{ t: Float32Array, dt: number, steps: number, buses: EmtBus[], branches: EmtBranch[], sources: EmtSource[],
 *   faults: EmtFault[], events: EmtAppliedEvent[], operations: Array<{ t: number, element: string, note: string }>,
 *   travelling: number, pi: number, initialMismatch: number, factorisations: number, notes: string[], message: string }} EmtResult
 *   `operations`: breaker poles and fault paths that opened at a current zero.
 * @typedef {{ loadflow: LoadFlowResult, shortcircuit: ShortCircuitResult, contingency: ContingencyResult, rms: RmsResult, emt: EmtResult }} ResultOf
 * @typedef {{ class: string, count: number, status: 'mapped' | 'used' | 'not used', detail: string }} ImportClass
 * @typedef {{ files: Array<{ name: string, profiles: string[] }>, classes: ImportClass[], notes: string[] }} ImportReport
 * @typedef {{ severity: 'warning' | 'error', class: string, id: string, message: string }} ModelIssue
 * @typedef {{ busIds: string[], vm: number[], va: number[], held?: Array<{ id: string, limit: 'min' | 'max' }> }} StartVoltages
 *   Where a load flow starts: busbar voltages, and the machines held at a reactive limit
 * @typedef {{ solved: boolean, maxDv: number, maxDa: number, worst: string, editorConverges: boolean, start: StartVoltages }} Fidelity
 * @typedef {{ nodes: number, branches: number, sources: number, loads: number, switches: number }} ImportSize
 * @typedef {{ format: 'cgmes' | 'psse' | 'matpower', report: ImportReport, validation: ModelIssue[], conversion: string[],
 *   study: string[], fidelity: Fidelity, size: ImportSize, ms: number }} ImportSummary
 */

/** @param {number | null | undefined} v */
const num = v => (typeof v === 'number' ? v : NaN);

/** @param {any} c @returns {ContingencyCase} */
const adaptCase = c => ({ ...c, maxLoading: num(c.maxLoading), minV: num(c.minV), maxV: num(c.maxV) });

/**
 * Turns an engine report into the app's result type.
 * @template {CalcKind} K @param {K} kind @param {any} raw @returns {ResultOf[K]}
 */
export function adapt(kind, raw) {
  /** @type {ResultOf[CalcKind]} */
  let r;
  if (kind === 'loadflow') {
    r = { ...raw, branches: raw.branches.map((/** @type {any} */ b) => ({ ...b, loading: num(b.loading) })),
      state: { vm: Float64Array.from(raw.state.vm), va: Float64Array.from(raw.state.va) } };
  } else if (kind === 'shortcircuit') {
    r = { ...raw, buses: raw.buses.map((/** @type {any} */ b) => ({ ...b, r0: num(b.r0), x0: num(b.x0) })) };
  } else if (kind === 'contingency') {
    r = { ...raw, base: adaptCase(raw.base), cases: raw.cases.map(adaptCase) };
  } else if (kind === 'emt') {
    const phases = (/** @type {number[][]} */ p) => /** @type {Phases} */ (p.map(x => Float32Array.from(x)));
    r = { ...raw, t: Float32Array.from(raw.t),
      buses: raw.buses.map((/** @type {any} */ b) => ({ ...b, v: phases(b.v) })),
      branches: raw.branches.map((/** @type {any} */ b) => ({ ...b, from: phases(b.from), to: phases(b.to) })),
      sources: raw.sources.map((/** @type {any} */ s) => ({ ...s, i: phases(s.i) })),
      faults: raw.faults.map((/** @type {any} */ f) => ({ ...f, i: phases(f.i), rms: num(f.rms) })) };
  } else {
    r = { ...raw, t: Float32Array.from(raw.t),
      machines: raw.machines.map((/** @type {any} */ m) => ({ ...m, delta: Float32Array.from(m.delta), speed: Float32Array.from(m.speed), pe: Float32Array.from(m.pe),
        q: Float32Array.from(m.q), efd: Float32Array.from(m.efd), pm: Float32Array.from(m.pm) })),
      voltages: raw.voltages.map((/** @type {number[]} */ v) => Float32Array.from(v)) };
  }
  return /** @type {ResultOf[K]} */ (r);
}
