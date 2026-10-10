/** Result types of the engine's studies, and the adapter that turns its JSON reports into them.
 *
 * The engine reports in JSON, which has no NaN and no typed arrays. `adapt` restores both: a missing rating or value
 * (JSON null) becomes NaN, and voltage states and simulation traces become Float64Array and Float32Array, which the
 * plots and overlays read directly. engine/crates/ps-study defines the reports; docs/ENGINE.md describes them. */

/**
 * @typedef {'loadflow' | 'shortcircuit' | 'contingency' | 'rms'} CalcKind
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
 * @typedef {{ id: string, ikss: number, ip: number, ith: number, skss: number, kappa: number, rx: number, c: number,
 *   r1: number, x1: number, r0: number, x0: number }} FaultResult
 * @typedef {{ id: string, iFrom: number, iTo: number }} BranchContribution
 * @typedef {{ fault: FaultType, mode: 'max' | 'min', kappaMethod: 'B' | 'C', buses: FaultResult[], location: string,
 *   contributions: BranchContribution[], deenergized: string[], warnings: string[] }} ShortCircuitResult
 * @typedef {{ kind: 'loading' | 'undervoltage' | 'overvoltage', id: string, value: number, limit: number, inBase: boolean }} Violation
 * @typedef {{ id: string, cls: string, elements: string[], converged: boolean, message: string, maxLoading: number,
 *   maxLoadingId: string, minV: number, minVBus: string, maxV: number, maxVBus: string, lostBuses: string[],
 *   violations: Violation[], screened: boolean, remedial: string[], violationsBefore: number }} ContingencyCase
 * @typedef {{ base: ContingencyCase, cases: ContingencyCase[], worstLoading: Record<string, { value: number, outage: string }>,
 *   worstVoltage: Record<string, { min: number, minOutage: string, max: number, maxOutage: string }>, limit: number,
 *   effort: { reused: number, rebuilt: number, screened: number }, timing: { totalMs: number }, notes: string[] }} ContingencyResult
 * @typedef {import('../core/document.js').SimEvent} SimEvent
 * @typedef {{ id: string, name: string, delta: Float32Array, speed: Float32Array, pe: Float32Array }} MachineTrace
 * @typedef {{ t: Float32Array, machines: MachineTrace[], busIds: string[], voltages: Float32Array[], events: Array<SimEvent & { applied: boolean, note: string }>,
 *   stable: boolean, lossOfSynchronism: number | null, angleReference: 'grid' | 'coi', steps: number, message: string }} RmsResult
 * @typedef {{ loadflow: LoadFlowResult, shortcircuit: ShortCircuitResult, contingency: ContingencyResult, rms: RmsResult }} ResultOf
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
  } else {
    r = { ...raw, t: Float32Array.from(raw.t),
      machines: raw.machines.map((/** @type {any} */ m) => ({ ...m, delta: Float32Array.from(m.delta), speed: Float32Array.from(m.speed), pe: Float32Array.from(m.pe) })),
      voltages: raw.voltages.map((/** @type {number[]} */ v) => Float32Array.from(v)) };
  }
  return /** @type {ResultOf[K]} */ (r);
}
