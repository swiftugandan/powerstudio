/** The element catalogue: every class a PowerStudio network can hold, with the fields each one carries.
 *
 * The field specs are the single source of truth for the inspector, for validation of imported files and for the
 * documentation tables in docs/ENGINE.md. Values are stored in engineering units (kV, MW, Ω/km, %) as a network
 * engineer enters them; the engine converts them to its model on import (engine/crates/ps-io/src/powerstudio.rs). */

/**
 * @typedef {'number' | 'integer' | 'string' | 'bool' | 'enum' | 'bus' | 'trafo' | 'controller'} FieldType
 * @typedef {'basic' | 'loadflow' | 'shortcircuit' | 'rms' | 'graphic'} FieldGroup
 * @typedef {{
 *   key: string, label: string, type: FieldType, group: FieldGroup, default: unknown,
 *   unit?: string, min?: number, max?: number, exclusiveMin?: boolean, options?: readonly string[], help?: string,
 *   symbol?: string, optional?: string, when?: (el: Record<string, unknown>) => boolean, operating?: boolean,
 *   slot?: Slot,
 * }} FieldSpec
 * A `controller` field holds a machine's control of one `slot`: `null`, or an object naming its `model` (a
 * [`CONTROLLERS`] entry) with each parameter under its PSS/E name.
 * A `trafo` field names a transformer with an end at the element's busbar, or is empty.
 * `optional` lets a busbar or transformer field be empty and names that choice ("Own busbar"); `when` shows a field only when it
 * applies to the element's other values (a control's target only while the control is on). `operating` marks a value
 * of the operating point (switching state, setpoints, loads, generation, taps), which a scenario may set; every other
 * field describes the equipment as built.
 * @typedef {'bus' | 'line' | 'trafo' | 'gen' | 'extgrid' | 'load' | 'shunt'} ElementClass
 * @typedef {{ cls: ElementClass, label: string, plural: string, prefix: string, kind: 'node' | 'branch' | 'shunt',
 *   ends: readonly string[], fields: readonly FieldSpec[] }} ClassSpec
 * @typedef {{ id: string, cls: ElementClass, name: string, [key: string]: unknown }} Element
 */

/** @param {string} key @param {string} label @param {number} def @param {Partial<FieldSpec>} [extra] @returns {FieldSpec} */
const num = (key, label, def, extra = {}) => ({ key, label, type: 'number', group: 'basic', default: def, ...extra });
/** @param {string} key @param {string} label @param {number} def @param {Partial<FieldSpec>} [extra] @returns {FieldSpec} */
const int = (key, label, def, extra = {}) => ({ key, label, type: 'integer', group: 'basic', default: def, ...extra });
/** @param {string} key @param {string} label @returns {FieldSpec} */
const bus = (key, label) => ({ key, label, type: 'bus', group: 'basic', default: '' });
/** A busbar field that may be empty. @param {string} key @param {string} label @param {string} empty @param {Partial<FieldSpec>} [extra] @returns {FieldSpec} */
const optionalBus = (key, label, empty, extra = {}) => ({ key, label, type: 'bus', group: 'loadflow', default: '', optional: empty, ...extra });
const inService = /** @type {FieldSpec} */ ({ key: 'inService', label: 'In service', type: 'bool', group: 'basic', default: true, operating: true });
const name = /** @type {FieldSpec} */ ({ key: 'name', label: 'Name', type: 'string', group: 'basic', default: '' });
/** Position of a connection along its bus bar, from -0.5 (start) to 0.5 (end). @param {string} key @param {string} label */
const attach = (key, label) => num(key, label, 0, { group: 'graphic', min: -0.5, max: 0.5, help: 'Position along the bus bar, from -0.5 (start) to 0.5 (end).' });

export const VECTOR_GROUPS = /** @type {const} */ (['YNyn0', 'YNd1', 'YNd5', 'YNd11', 'Dyn1', 'Dyn5', 'Dyn11', 'Yd1', 'Yd5', 'Yd11', 'Dy1', 'Dy5', 'Dy11', 'Yy0', 'YNy0', 'Yyn0', 'Dd0']);
export const GEN_MODES = /** @type {const} */ (['PV', 'PQ', 'Reference']);
export const SIDES = /** @type {const} */ (['below', 'above']);
export const MAGNETISING = /** @type {const} */ (['both', 'hv', 'lv']);
export const TAP_KINDS = /** @type {const} */ (['ratio', 'phase']);
export const ROTOR_MODELS = /** @type {const} */ (['classical', 'roundRotor']);

/**
 * @typedef {'exciter' | 'governor' | 'stabiliser'} Slot
 * @typedef {{ key: string, label: string, default: number, unit?: string, integer?: boolean,
 *   choices?: ReadonlyArray<readonly [number, string]>, help?: string }} ParamSpec
 * @typedef {{ model: string, slot: Slot, label: string, params: readonly ParamSpec[] }} ControllerSpec
 */

/** @param {string} key @param {string} label @param {number} def @param {string} [unit] @param {Partial<ParamSpec>} [extra]
 * @returns {ParamSpec} */
const par = (key, label, def, unit, extra = {}) => ({ key, label, default: def, ...(unit ? { unit } : {}), ...extra });
const S = 's', PU = 'p.u.';
/** Saturation of a DC or AC exciter, from two points. */
const SATURATION = [par('E1', 'Saturation point E1', 0, PU), par('SE1', 'Saturation at E1', 0), par('E2', 'Saturation point E2', 1, PU), par('SE2', 'Saturation at E2', 1)];
/** A stabiliser's input signals (PSS/E ICS); 2 and 6 are not modelled yet. */
const SIGNALS = /** @type {const} */ ([[0, 'None'], [1, 'Speed deviation'], [3, 'Electrical power'], [4, 'Mechanical power deviation'], [5, 'Terminal voltage']]);
const REMOTE = { integer: true, help: 'A remote busbar\u2019s number; only 0, the machine\u2019s own busbar, is modelled.' };

/** The control models of the dynamic library, with their parameters in PSS/E DYR order (ICONs first) and typical values.
 * The engine holds the same lists (ControllerKind in engine/crates/ps-model/src/dynamics.rs); a test keeps them equal.
 * @type {readonly ControllerSpec[]} */
export const CONTROLLERS = [
  { model: 'SEXS', slot: 'exciter', label: 'Simplified excitation system', params: [
    par('TA/TB', 'Lead-lag ratio TA/TB', 0.4), par('TB', 'Lag time constant TB', 5, S), par('K', 'Gain K', 20),
    par('TE', 'Exciter time constant TE', 0.83, S), par('EMIN', 'Minimum field voltage', 0, PU), par('EMAX', 'Maximum field voltage', 5, PU)] },
  { model: 'IEEET1', slot: 'exciter', label: 'IEEE type 1', params: [
    par('TR', 'Transducer time constant TR', 0.02, S), par('KA', 'Regulator gain KA', 5), par('TA', 'Regulator time constant TA', 0.04, S),
    par('VRMAX', 'Regulator maximum VRMAX', 7.3, PU, { help: 'Zero means no upper limit.' }), par('VRMIN', 'Regulator minimum VRMIN', -7.3, PU),
    par('KE', 'Exciter constant KE', 1), par('TE', 'Exciter time constant TE', 0.8, S), par('KF', 'Rate feedback gain KF', 0.1),
    par('TF', 'Rate feedback time constant TF', 1, S), par('SWITCH', 'Switch', 0, undefined, { help: 'Not used by the model.' }), ...SATURATION] },
  { model: 'EXDC2', slot: 'exciter', label: 'IEEE type DC2, 1981', params: [
    par('TR', 'Transducer time constant TR', 0.02, S), par('KA', 'Regulator gain KA', 20), par('TA', 'Regulator time constant TA', 0.02, S),
    par('TB', 'Lead-lag lag TB', 1, S), par('TC', 'Lead-lag lead TC', 1, S), par('VRMAX', 'Regulator maximum VRMAX', 5.2, PU),
    par('VRMIN', 'Regulator minimum VRMIN', -4.16, PU), par('KE', 'Exciter constant KE', 1), par('TE', 'Exciter time constant TE', 0.83, S),
    par('KF', 'Rate feedback gain KF', 0.0754), par('TF1', 'Rate feedback time constant TF1', 1.246, S),
    par('SWITCH', 'Switch', 0, undefined, { help: 'Not used by the model.' }), ...SATURATION] },
  { model: 'ESDC2A', slot: 'exciter', label: 'IEEE 421.5 type DC2A', params: [
    par('TR', 'Transducer time constant TR', 0.02, S), par('KA', 'Regulator gain KA', 50), par('TA', 'Regulator time constant TA', 0.05, S),
    par('TB', 'Lead-lag lag TB', 0.02, S), par('TC', 'Lead-lag lead TC', 0, S),
    par('VRMAX', 'Regulator maximum VRMAX', 0, PU, { help: 'Times the terminal voltage; zero means no upper limit.' }),
    par('VRMIN', 'Regulator minimum VRMIN', -3, PU, { help: 'Times the terminal voltage.' }), par('KE', 'Exciter constant KE', 0),
    par('TE', 'Exciter time constant TE', 0.512, S), par('KF', 'Rate feedback gain KF', 0.07), par('TF1', 'Rate feedback time constant TF1', 1.3, S),
    par('SWITCH', 'Switch', 0, undefined, { help: 'Not used by the model.' }),
    par('E1', 'Saturation point E1', 3.9825, PU), par('SE1', 'Saturation at E1', 0.5), par('E2', 'Saturation point E2', 5.31, PU), par('SE2', 'Saturation at E2', 1.049)] },
  { model: 'EXST1', slot: 'exciter', label: 'IEEE type ST1, 1981', params: [
    par('TR', 'Transducer time constant TR', 0.02, S), par('VIMAX', 'Input maximum VIMAX', 99, PU), par('VIMIN', 'Input minimum VIMIN', -99, PU),
    par('TC', 'Lead-lag lead TC', 0, S), par('TB', 'Lead-lag lag TB', 0.02, S), par('KA', 'Regulator gain KA', 50), par('TA', 'Regulator time constant TA', 0.02, S),
    par('VRMAX', 'Output maximum VRMAX', 9999, PU), par('VRMIN', 'Output minimum VRMIN', -9999, PU), par('KC', 'Rectifier loading factor KC', 0),
    par('KF', 'Rate feedback gain KF', 0.01), par('TF', 'Rate feedback time constant TF', 1, S)] },
  { model: 'ESST1A', slot: 'exciter', label: 'IEEE 421.5 type ST1A', params: [
    par('UEL', 'Under-excitation limiter input', 1, undefined, { integer: true, help: 'Where an under-excitation limiter would act; none is modelled, so it changes nothing.' }),
    par('VOS', 'Stabiliser input point', 1, undefined, { integer: true, help: 'The stabiliser\u2019s signal enters at the input whatever its value.' }),
    par('TR', 'Transducer time constant TR', 0.01, S), par('VIMAX', 'Input maximum VIMAX', 0.8, PU), par('VIMIN', 'Input minimum VIMIN', -0.1, PU),
    par('TC', 'First lead TC', 1, S), par('TB', 'First lag TB', 1, S), par('TC1', 'Second lead TC1', 1, S), par('TB1', 'Second lag TB1', 1, S),
    par('KA', 'Regulator gain KA', 80), par('TA', 'Regulator time constant TA', 0.04, S),
    par('VAMAX', 'Regulator maximum VAMAX', 999, PU), par('VAMIN', 'Regulator minimum VAMIN', -999, PU),
    par('VRMAX', 'Output maximum VRMAX', 7.3, PU, { help: 'Times the terminal voltage, less KC times the field current.' }),
    par('VRMIN', 'Output minimum VRMIN', -7.3, PU, { help: 'Times the terminal voltage.' }), par('KC', 'Rectifier loading factor KC', 0.1),
    par('KF', 'Rate feedback gain KF', 0.1), par('TF', 'Rate feedback time constant TF', 1, S),
    par('KLR', 'Field current limiter gain KLR', 1), par('ILR', 'Field current limit ILR', 1, PU)] },
  { model: 'ESST3A', slot: 'exciter', label: 'IEEE 421.5 type ST3A', params: [
    par('TR', 'Transducer time constant TR', 0.02, S), par('VIMAX', 'Input maximum VIMAX', 0.2, PU), par('VIMIN', 'Input minimum VIMIN', -0.2, PU),
    par('KM', 'Inner regulator gain KM', 8), par('TC', 'Lead-lag lead TC', 1, S), par('TB', 'Lead-lag lag TB', 5, S), par('KA', 'Regulator gain KA', 20),
    par('TA', 'Regulator time constant TA', 0, S), par('VRMAX', 'Regulator maximum VRMAX', 99, PU), par('VRMIN', 'Regulator minimum VRMIN', -99, PU),
    par('KG', 'Field voltage feedback gain KG', 1), par('KP', 'Potential circuit gain KP', 3.67), par('KI', 'Current circuit gain KI', 0.435),
    par('VBMAX', 'Source voltage maximum VBMAX', 5.48, PU), par('KC', 'Rectifier loading factor KC', 0.01), par('XL', 'Potential source reactance XL', 0.0098, PU),
    par('VGMAX', 'Feedback maximum VGMAX', 3.86, PU), par('THETAP', 'Potential circuit angle θP', 3.33, '°'),
    par('TM', 'Inner regulator time constant TM', 0.4, S), par('VMMAX', 'Inner regulator maximum VMMAX', 99, PU), par('VMMIN', 'Inner regulator minimum VMMIN', 0, PU)] },
  { model: 'TGOV1', slot: 'governor', label: 'Steam turbine governor', params: [
    par('R', 'Droop R', 0.05, PU), par('T1', 'Valve time constant T1', 0.49, S), par('VMAX', 'Valve maximum VMAX', 33, PU), par('VMIN', 'Valve minimum VMIN', 0.4, PU),
    par('T2', 'Reheater lead T2', 2.1, S), par('T3', 'Reheater lag T3', 7, S), par('DT', 'Turbine damping Dt', 0, PU)] },
  { model: 'IEEEG1', slot: 'governor', label: 'IEEE type 1 speed governor', params: [
    par('IBUS', 'Low-pressure machine\u2019s busbar', 0, undefined, { integer: true, help: 'A cross-compound unit\u2019s second machine; only 0, none, is modelled.' }),
    par('IM', 'Low-pressure machine', 0, undefined, { integer: true, help: 'Only 0, none, is modelled.' }),
    par('K', 'Governor gain K', 20), par('T1', 'Governor lag T1', 0.1, S), par('T2', 'Governor lead T2', 0, S), par('T3', 'Servo time constant T3', 0.2, S),
    par('UO', 'Valve opening rate UO', 1, 'p.u./s'), par('UC', 'Valve closing rate UC', -1, 'p.u./s'), par('PMAX', 'Maximum power PMAX', 0.95, PU),
    par('PMIN', 'Minimum power PMIN', 0, PU), par('T4', 'Steam chest time constant T4', 0.1, S),
    par('K1', 'High-pressure fraction K1', 0), par('K2', 'Low-pressure fraction K2', 0), par('T5', 'Reheater time constant T5', 0, S),
    par('K3', 'High-pressure fraction K3', 0), par('K4', 'Low-pressure fraction K4', 0), par('T6', 'Crossover time constant T6', 0, S),
    par('K5', 'High-pressure fraction K5', 0.3), par('K6', 'Low-pressure fraction K6', 0), par('T7', 'Second reheater time constant T7', 8.72, S),
    par('K7', 'High-pressure fraction K7', 0.7), par('K8', 'Low-pressure fraction K8', 0)] },
  { model: 'HYGOV', slot: 'governor', label: 'Hydro turbine governor', params: [
    par('R', 'Permanent droop R', 0.05, PU), par('r', 'Temporary droop r', 1, PU), par('TR', 'Governor time constant Tr', 1, S),
    par('TF', 'Filter time constant Tf', 0.05, S), par('TG', 'Servo time constant Tg', 0.05, S), par('VELM', 'Gate velocity limit VELM', 0.3, 'p.u./s'),
    par('GMAX', 'Maximum gate GMAX', 0.45001, PU), par('GMIN', 'Minimum gate GMIN', 0, PU), par('TW', 'Water time constant Tw', 1, S),
    par('AT', 'Turbine gain At', 1), par('DTURB', 'Turbine damping Dturb', 0, PU), par('QNL', 'No-load flow qNL', 0.1, PU)] },
  { model: 'IEEEST', slot: 'stabiliser', label: 'IEEE stabiliser', params: [
    par('MODE', 'Input signal', 3, undefined, { integer: true, choices: SIGNALS }), par('BUSR', 'Remote busbar', 0, undefined, REMOTE),
    par('A1', 'Filter coefficient A1', 0, S), par('A2', 'Filter coefficient A2', 0, 's²'), par('A3', 'Filter coefficient A3', 0, S),
    par('A4', 'Filter coefficient A4', 0, 's²'), par('A5', 'Filter coefficient A5', 0, S), par('A6', 'Filter coefficient A6', 0, 's²'),
    par('T1', 'First lead T1', 0, S), par('T2', 'First lag T2', 0, S), par('T3', 'Second lead T3', 0, S), par('T4', 'Second lag T4', 0.75, S),
    par('T5', 'Washout gain T5', 1, S), par('T6', 'Washout time constant T6', 4.2, S), par('KS', 'Gain KS', -2),
    par('LSMAX', 'Output maximum LSMAX', 0.1, PU), par('LSMIN', 'Output minimum LSMIN', -0.1, PU),
    par('VCU', 'Cut-off voltage maximum VCU', 0, PU, { help: 'Zero means none.' }), par('VCL', 'Cut-off voltage minimum VCL', 0, PU, { help: 'Zero means none.' })] },
  { model: 'ST2CUT', slot: 'stabiliser', label: 'Dual-input stabiliser', params: [
    par('MODE', 'First input signal', 1, undefined, { integer: true, choices: SIGNALS }), par('BUSR', 'First input\u2019s remote busbar', 0, undefined, REMOTE),
    par('MODE2', 'Second input signal', 0, undefined, { integer: true, choices: SIGNALS }), par('BUSR2', 'Second input\u2019s remote busbar', 0, undefined, REMOTE),
    par('K1', 'First input gain K1', 10), par('K2', 'Second input gain K2', 0), par('T1', 'First input time constant T1', 0, S),
    par('T2', 'Second input time constant T2', 0, S), par('T3', 'Washout gain T3', 3, S), par('T4', 'Washout time constant T4', 3, S),
    par('T5', 'First lead T5', 0.15, S), par('T6', 'First lag T6', 0.05, S), par('T7', 'Second lead T7', 0.15, S), par('T8', 'Second lag T8', 0.05, S),
    par('T9', 'Third lead T9', 0.15, S), par('T10', 'Third lag T10', 0.05, S), par('LSMAX', 'Output maximum LSMAX', 0.05, PU),
    par('LSMIN', 'Output minimum LSMIN', -0.05, PU), par('VCU', 'Cut-off band above VCU', 0, PU, { help: 'Above the initial voltage; zero means none.' }),
    par('VCL', 'Cut-off band below VCL', 0, PU, { help: 'Below the initial voltage (negative); zero means none.' })] },
];

/** Why a round-rotor machine's data cannot be simulated, or '' when they can: the reactances must fall in order,
 * Xd ≥ X′d ≥ X″d > Xl and Xq ≥ X′q > Xl (X″d is the short-circuit subtransient reactance).
 * @param {Record<string, unknown>} el */
export function rotorIssue(el) {
  if (el.cls !== 'gen' || el.machineModel !== 'roundRotor') return '';
  const n = (/** @type {string} */ k) => /** @type {number} */ (el[k]);
  const order = [['xd', 'Xd'], ['xdt', 'X′d'], ['xdss', 'X″d']];
  for (let i = 1; i < order.length; i++) {
    if (n(order[i][0]) > n(order[i - 1][0])) return `${order[i][1]} (${n(order[i][0])} p.u.) is above ${order[i - 1][1]} (${n(order[i - 1][0])} p.u.).`;
  }
  if (n('xdss') <= n('xl')) return `The leakage reactance Xl (${n('xl')} p.u.) must be below X″d (${n('xdss')} p.u.).`;
  if (n('xqt') > n('xq')) return `X′q (${n('xqt')} p.u.) is above Xq (${n('xq')} p.u.).`;
  if (n('xqt') <= n('xl')) return `The leakage reactance Xl (${n('xl')} p.u.) must be below X′q (${n('xqt')} p.u.).`;
  return '';
}

/** The control model with a name, or undefined. @param {unknown} model */
export const controllerOf = model => CONTROLLERS.find(c => c.model === model);

/** A control's value with every parameter of its model, missing ones at their typical values.
 * @param {Record<string, unknown>} value @returns {Record<string, unknown>} */
export function completeController(value) {
  const spec = controllerOf(value.model);
  if (!spec) return value;
  /** @type {Record<string, unknown>} */
  const out = { model: spec.model };
  for (const p of spec.params) out[p.key] = typeof value[p.key] === 'number' ? value[p.key] : p.default;
  return out;
}

/** @param {Record<string, unknown>} el */
const isRoundRotor = el => el.machineModel === 'roundRotor';
/** @param {Record<string, unknown>} el */
const isMotor = el => !!el.motor;
/** @param {Record<string, unknown>} el */
const isFeeder = el => !!el.feeder;

/** The transformers that can be a machine's unit transformer: those with an end at its busbar.
 * @param {readonly Element[]} elements @param {Element} machine @returns {Element[]} */
export function unitTrafoChoices(elements, machine) {
  return elements.filter(e => e.cls === 'trafo' && (e.hv === machine.bus || e.lv === machine.bus));
}
/** Round-rotor data (PSS/E GENROU); the engine's typical values (TYPICAL_ROUND_ROTOR) are the defaults. */
const ROUND_ROTOR = /** @type {FieldSpec[]} */ ([
  num('xd', 'Synchronous reactance xd', 1.8, { unit: 'p.u.', min: 0, exclusiveMin: true, group: 'rms' }),
  num('xq', 'Synchronous reactance xq', 1.7, { unit: 'p.u.', min: 0, exclusiveMin: true, group: 'rms' }),
  num('xqt', 'Transient reactance xq′', 0.55, { unit: 'p.u.', min: 0, exclusiveMin: true, group: 'rms' }),
  num('xl', 'Leakage reactance xl', 0.15, { unit: 'p.u.', min: 0, group: 'rms' }),
  num('td0t', 'Transient time constant T′d0', 6.5, { unit: 's', min: 0, exclusiveMin: true, group: 'rms' }),
  num('td0s', 'Subtransient time constant T″d0', 0.03, { unit: 's', min: 0, exclusiveMin: true, group: 'rms' }),
  num('tq0t', 'Transient time constant T′q0', 0.4, { unit: 's', min: 0, exclusiveMin: true, group: 'rms' }),
  num('tq0s', 'Subtransient time constant T″q0', 0.05, { unit: 's', min: 0, exclusiveMin: true, group: 'rms' }),
  num('s10', 'Saturation S(1.0)', 0, { min: 0, group: 'rms' }),
  num('s12', 'Saturation S(1.2)', 0, { min: 0, group: 'rms' }),
]);

/** @type {Readonly<Record<ElementClass, ClassSpec>>} */
export const CLASSES = {
  bus: {
    cls: 'bus', label: 'Busbar', plural: 'Busbars', prefix: 'B', kind: 'node', ends: [],
    fields: [
      name,
      num('vn', 'Nominal voltage', 110, { unit: 'kV', min: 0, exclusiveMin: true, symbol: 'Un' }),
      num('vmin', 'Lower voltage limit', 0.95, { unit: 'p.u.', min: 0, group: 'loadflow' }),
      num('vmax', 'Upper voltage limit', 1.05, { unit: 'p.u.', min: 0, group: 'loadflow' }),
      { key: 'zone', label: 'Zone', type: 'string', group: 'basic', default: '' },
      num('x', 'Position x', 0, { group: 'graphic' }),
      num('y', 'Position y', 0, { group: 'graphic' }),
      num('len', 'Bar length', 120, { group: 'graphic', min: 20 }),
      { key: 'orient', label: 'Orientation', type: 'enum', group: 'graphic', default: 'h', options: ['h', 'v'] },
    ],
  },
  line: {
    cls: 'line', label: 'Line', plural: 'Lines', prefix: 'L', kind: 'branch', ends: ['from', 'to'],
    fields: [
      name, bus('from', 'From busbar'), bus('to', 'To busbar'), inService,
      num('length', 'Length', 10, { unit: 'km', min: 0, exclusiveMin: true }),
      int('parallel', 'Parallel systems', 1, { min: 1, max: 10 }),
      num('r1', 'Resistance R′', 0.12, { unit: 'Ω/km', symbol: 'R1', help: 'Negative only in equivalents, such as the star of a three-winding transformer.' }),
      num('x1', 'Reactance X′', 0.39, { unit: 'Ω/km', symbol: 'X1', help: 'Negative for series capacitors.' }),
      num('b1', 'Susceptance B′', 2.9, { unit: 'µS/km', min: 0, symbol: 'B1' }),
      num('ratedA', 'Rated current', 0.6, { unit: 'kA', min: 0, symbol: 'Ir', help: 'Zero means the line has no rating and its loading is not reported.' }),
      num('r0', 'Zero-sequence R0′', 0.36, { unit: 'Ω/km', group: 'shortcircuit', help: 'Negative only in equivalents, such as the star of a three-winding transformer.' }),
      num('x0', 'Zero-sequence X0′', 1.17, { unit: 'Ω/km', group: 'shortcircuit', help: 'Negative only in equivalents.' }),
      num('b0', 'Zero-sequence B0′', 1.8, { unit: 'µS/km', min: 0, group: 'shortcircuit' }),
      attach('fromPos', 'From connection'), attach('toPos', 'To connection'),
      num('bend', 'Route offset', 0, { group: 'graphic', help: 'Moves the middle segment of the route.' }),
    ],
  },
  trafo: {
    cls: 'trafo', label: 'Transformer', plural: 'Transformers', prefix: 'T', kind: 'branch', ends: ['hv', 'lv'],
    fields: [
      name, bus('hv', 'HV busbar'), bus('lv', 'LV busbar'), inService,
      num('sn', 'Rated power', 40, { unit: 'MVA', min: 0, exclusiveMin: true, symbol: 'Sr' }),
      { key: 'thermal', label: 'Rated power limits loading', type: 'bool', group: 'basic', default: true,
        help: 'Off when the rated power is only the base of the impedance data, as for a MATPOWER branch without a rating: the loading is then not reported.' },
      num('vnHV', 'Rated voltage HV', 110, { unit: 'kV', min: 0, exclusiveMin: true, symbol: 'UrHV' }),
      num('vnLV', 'Rated voltage LV', 20, { unit: 'kV', min: 0, exclusiveMin: true, symbol: 'UrLV' }),
      num('uk', 'Short-circuit voltage', 12, { unit: '%', min: 0, exclusiveMin: true, symbol: 'uk' }),
      num('ur', 'Copper losses (resistive part)', 0.4, { unit: '%', min: 0, symbol: 'uR' }),
      num('i0', 'No-load current', 0.05, { unit: '%', min: 0, group: 'loadflow' }),
      num('pfe', 'Iron losses', 20, { unit: 'kW', min: 0, group: 'loadflow' }),
      { key: 'magnetising', label: 'Magnetising branch', type: 'enum', group: 'loadflow', default: 'both', options: MAGNETISING,
        help: 'Where the no-load current and iron losses are drawn: half at each winding, or all at the HV or the LV winding.' },
      { key: 'vectorGroup', label: 'Vector group', type: 'enum', group: 'basic', default: 'Dyn11', options: VECTOR_GROUPS },
      num('shift', 'Additional phase shift', 0, { unit: '°', min: -180, max: 180, group: 'loadflow',
        help: 'How far the LV side lags the HV side beyond the vector group, as in phase-shifting transformers.' }),
      { key: 'tapKind', label: 'Tap changer', type: 'enum', group: 'loadflow', default: 'ratio', options: TAP_KINDS,
        help: 'A ratio tap changer on the HV winding changes the voltage ratio; a phase tap changer shifts the phase.' },
      num('tapStep', 'Tap step (HV side)', 1.25, { unit: '%', group: 'loadflow', when: el => el.tapKind !== 'phase' }),
      num('phaseStep', 'Phase shift per step', 1, { unit: '°', group: 'loadflow', min: -30, max: 30, when: el => el.tapKind === 'phase',
        help: 'How far each position beyond neutral makes the LV side lag.' }),
      int('tapPos', 'Tap position', 0, { group: 'loadflow', operating: true }),
      int('tapNeutral', 'Neutral position', 0, { group: 'loadflow' }),
      int('tapMin', 'Lowest position', -9, { group: 'loadflow' }),
      int('tapMax', 'Highest position', 9, { group: 'loadflow' }),
      { key: 'tapControl', label: 'Automatic tap control', type: 'bool', group: 'loadflow', default: false, operating: true,
        help: 'Moves the taps in the load flow when the study case lets tap changers or phase shifters regulate.' },
      optionalBus('ctrlBus', 'Regulated busbar', 'LV busbar', { when: el => !!el.tapControl && el.tapKind !== 'phase' }),
      num('vTarget', 'Voltage target', 1, { unit: 'p.u.', group: 'loadflow', min: 0.5, max: 1.5, operating: true, when: el => !!el.tapControl && el.tapKind !== 'phase' }),
      num('vBand', 'Dead band', 2, { unit: '%', group: 'loadflow', min: 0, max: 20, when: el => !!el.tapControl && el.tapKind !== 'phase',
        help: 'Full width of the band the voltage may lie in without a tap change, % of the busbar\'s nominal voltage.' }),
      num('pTarget', 'Active power target', 0, { unit: 'MW', group: 'loadflow', operating: true, when: el => !!el.tapControl && el.tapKind === 'phase',
        help: 'Active power into the transformer at its HV winding.' }),
      num('pBand', 'Dead band', 5, { unit: 'MW', group: 'loadflow', min: 0, when: el => !!el.tapControl && el.tapKind === 'phase',
        help: 'Full width of the band the flow may lie in without a tap change.' }),
      num('uk0', 'Zero-sequence uk0', 12, { unit: '%', min: 0, exclusiveMin: true, group: 'shortcircuit' }),
      num('ur0', 'Zero-sequence uR0', 0.4, { unit: '%', min: 0, group: 'shortcircuit' }),
      num('rnHV', 'HV neutral earthing resistance', 0, { unit: 'Ω', min: 0, group: 'shortcircuit', when: el => /^(YN|ZN)/.test(String(el.vectorGroup)),
        help: 'The impedance between the HV star point and earth; zero is solid earthing.' }),
      num('xnHV', 'HV neutral earthing reactance', 0, { unit: 'Ω', min: 0, group: 'shortcircuit', when: el => /^(YN|ZN)/.test(String(el.vectorGroup)) }),
      num('rnLV', 'LV neutral earthing resistance', 0, { unit: 'Ω', min: 0, group: 'shortcircuit', when: el => /^[A-Z]+(yn|zn)/.test(String(el.vectorGroup)),
        help: 'The impedance between the LV star point and earth; zero is solid earthing.' }),
      num('xnLV', 'LV neutral earthing reactance', 0, { unit: 'Ω', min: 0, group: 'shortcircuit', when: el => /^[A-Z]+(yn|zn)/.test(String(el.vectorGroup)) }),
      { key: 'onLoadTaps', label: 'On-load tap changer', type: 'bool', group: 'shortcircuit', default: false,
        help: 'As the unit transformer of a power station unit: its correction factor is KS with an on-load tap changer, KSO without.' },
      num('tapRange', 'Off-load tap range', 0, { unit: '%', min: 0, max: 50, group: 'shortcircuit', symbol: 'pT', when: el => !el.onLoadTaps,
        help: 'As the unit transformer of a power station unit without an on-load tap changer: how far its taps may move the voltage either way, for KSO.' }),
      attach('hvPos', 'HV connection'), attach('lvPos', 'LV connection'),
      num('bend', 'Route offset', 0, { group: 'graphic', help: 'Moves the middle segment of the route.' }),
    ],
  },
  gen: {
    cls: 'gen', label: 'Synchronous machine', plural: 'Synchronous machines', prefix: 'G', kind: 'shunt', ends: ['bus'],
    fields: [
      name, bus('bus', 'Busbar'), inService,
      { key: 'mode', label: 'Control mode', type: 'enum', group: 'loadflow', default: 'PV', options: GEN_MODES,
        help: 'PV holds active power and voltage. PQ holds active and reactive power. Reference sets the angle and balances the system.' },
      num('p', 'Active power', 50, { unit: 'MW', group: 'loadflow', symbol: 'P', operating: true }),
      num('q', 'Reactive power (PQ mode)', 0, { unit: 'Mvar', group: 'loadflow', symbol: 'Q', operating: true, when: el => el.mode === 'PQ' }),
      num('vset', 'Voltage setpoint', 1.0, { unit: 'p.u.', min: 0.5, max: 1.5, group: 'loadflow', operating: true, when: el => el.mode !== 'PQ' }),
      optionalBus('regBus', 'Regulated busbar', 'Own busbar', { when: el => el.mode !== 'PQ',
        help: 'The busbar whose voltage the machine holds. Machines regulating one busbar share its reactive power.' }),
      num('angle', 'Voltage angle (reference)', 0, { unit: '°', group: 'loadflow', when: el => el.mode === 'Reference' }),
      num('qmin', 'Reactive power minimum', -30, { unit: 'Mvar', group: 'loadflow' }),
      num('qmax', 'Reactive power maximum', 40, { unit: 'Mvar', group: 'loadflow' }),
      num('pmin', 'Active power minimum', 0, { unit: 'MW', group: 'loadflow' }),
      num('pmax', 'Active power maximum', 0, { unit: 'MW', group: 'loadflow', min: 0,
        help: 'Zero means the rated power times the rated power factor.' }),
      num('participation', 'Participation factor', 1, { group: 'loadflow', min: 0,
        help: 'The machine\'s share of an island\'s imbalance when the study case shares it by participation factors.' }),
      num('sn', 'Rated power', 60, { unit: 'MVA', min: 0, exclusiveMin: true, symbol: 'SrG' }),
      num('vn', 'Rated voltage', 10.5, { unit: 'kV', min: 0, exclusiveMin: true, symbol: 'UrG' }),
      num('cosphi', 'Rated power factor', 0.85, { min: 0, max: 1, exclusiveMin: true, symbol: 'cos φrG' }),
      num('xdss', 'Subtransient reactance xd″', 0.16, { unit: 'p.u.', min: 0, exclusiveMin: true, group: 'shortcircuit' }),
      num('rs', 'Stator resistance', 0.0024, { unit: 'p.u.', min: 0, group: 'shortcircuit' }),
      num('pg', 'Voltage regulation range', 0, { unit: '%', min: 0, max: 20, group: 'shortcircuit', symbol: 'pG', when: el => !el.feeder,
        help: 'How far above its rated voltage the machine holds its terminals, for the correction factor KG.' }),
      { key: 'unitTrafo', label: 'Unit transformer', type: 'trafo', group: 'shortcircuit', default: '', optional: 'None', when: el => !el.feeder,
        help: 'The transformer that connects the machine to the network as a power station unit. Short-circuit currents then correct the two together (KS or KSO), and a fault at the machine\u2019s terminals sees the transformer uncorrected.' },
      { key: 'feeder', label: 'Stands for a network', type: 'bool', group: 'shortcircuit', default: false,
        help: 'The source is the equivalent of a neighbouring network, as external network injections in CGMES are: it regulates like a machine in the load flow and meets short circuits as a network feeder with the short-circuit power below.' },
      num('skMax', 'Short-circuit power max', 5000, { unit: 'MVA', min: 0, exclusiveMin: true, group: 'shortcircuit', symbol: 'Sk″max', when: isFeeder }),
      num('skMin', 'Short-circuit power min', 4000, { unit: 'MVA', min: 0, exclusiveMin: true, group: 'shortcircuit', symbol: 'Sk″min', when: isFeeder }),
      num('rxMax', 'R/X ratio max', 0.1, { min: 0, group: 'shortcircuit', when: isFeeder }),
      num('rxMin', 'R/X ratio min', 0.1, { min: 0, group: 'shortcircuit', when: isFeeder }),
      num('x0x1', 'X0/X1 ratio', 1, { min: 0, group: 'shortcircuit', when: isFeeder }),
      num('r0x0', 'R0/X0 ratio', 0.1, { min: 0, group: 'shortcircuit', when: isFeeder }),
      { key: 'machineModel', label: 'Rotor model', type: 'enum', group: 'rms', default: 'classical', options: ROTOR_MODELS,
        help: 'Classical (PSS/E GENCLS): a voltage behind the transient reactance. Round rotor (PSS/E GENROU): transient and subtransient circuits on both axes with saturation, using the subtransient reactance and stator resistance of the short-circuit data.' },
      num('h', 'Inertia constant', 4, { unit: 's', min: 0, exclusiveMin: true, group: 'rms', symbol: 'H' }),
      num('damping', 'Damping', 0, { unit: 'p.u.', min: 0, group: 'rms', symbol: 'D' }),
      num('xdt', 'Transient reactance xd′', 0.25, { unit: 'p.u.', min: 0, exclusiveMin: true, group: 'rms' }),
      ...ROUND_ROTOR.map(f => ({ ...f, when: isRoundRotor })),
      { key: 'exciter', label: 'Exciter', type: 'controller', slot: 'exciter', group: 'rms', default: null },
      { key: 'governor', label: 'Governor', type: 'controller', slot: 'governor', group: 'rms', default: null },
      { key: 'stabiliser', label: 'Stabiliser', type: 'controller', slot: 'stabiliser', group: 'rms', default: null,
        help: 'A stabiliser acts through the exciter; without an exciter it has no effect.' },
      attach('pos', 'Connection'),
      { key: 'side', label: 'Side', type: 'enum', group: 'graphic', default: 'above', options: SIDES },
    ],
  },
  extgrid: {
    cls: 'extgrid', label: 'External grid', plural: 'External grids', prefix: 'X', kind: 'shunt', ends: ['bus'],
    fields: [
      name, bus('bus', 'Busbar'), inService,
      num('vset', 'Voltage setpoint', 1.0, { unit: 'p.u.', min: 0.5, max: 1.5, group: 'loadflow', operating: true }),
      num('angle', 'Voltage angle', 0, { unit: '°', group: 'loadflow', operating: true }),
      num('skMax', 'Short-circuit power max', 5000, { unit: 'MVA', min: 0, exclusiveMin: true, group: 'shortcircuit', symbol: 'Sk″max' }),
      num('skMin', 'Short-circuit power min', 4000, { unit: 'MVA', min: 0, exclusiveMin: true, group: 'shortcircuit', symbol: 'Sk″min' }),
      num('rxMax', 'R/X ratio max', 0.1, { min: 0, group: 'shortcircuit' }),
      num('rxMin', 'R/X ratio min', 0.1, { min: 0, group: 'shortcircuit' }),
      num('x0x1', 'X0/X1 ratio', 1, { min: 0, group: 'shortcircuit' }),
      num('r0x0', 'R0/X0 ratio', 0.1, { min: 0, group: 'shortcircuit' }),
      attach('pos', 'Connection'),
      { key: 'side', label: 'Side', type: 'enum', group: 'graphic', default: 'above', options: SIDES },
    ],
  },
  load: {
    cls: 'load', label: 'Load', plural: 'Loads', prefix: 'D', kind: 'shunt', ends: ['bus'],
    fields: [
      name, bus('bus', 'Busbar'), inService,
      num('p', 'Active power', 10, { unit: 'MW', group: 'loadflow', symbol: 'P', operating: true, help: 'At nominal voltage.' }),
      num('q', 'Reactive power', 3, { unit: 'Mvar', group: 'loadflow', symbol: 'Q', operating: true, help: 'At nominal voltage.' }),
      num('pZ', 'Constant impedance share of P', 0, { unit: '%', group: 'loadflow', min: 0, max: 100,
        help: 'The share of the active power that varies with the voltage squared; constant current varies with the voltage, and the rest is constant power.' }),
      num('pI', 'Constant current share of P', 0, { unit: '%', group: 'loadflow', min: 0, max: 100 }),
      num('qZ', 'Constant impedance share of Q', 0, { unit: '%', group: 'loadflow', min: 0, max: 100 }),
      num('qI', 'Constant current share of Q', 0, { unit: '%', group: 'loadflow', min: 0, max: 100 }),
      { key: 'motor', label: 'Asynchronous motor', type: 'bool', group: 'shortcircuit', default: false,
        help: 'The load is a motor, or a group of motors, and feeds maximum short-circuit currents.' },
      num('motorP', 'Rated mechanical power', 1, { unit: 'MW', min: 0, exclusiveMin: true, group: 'shortcircuit', symbol: 'PrM', when: isMotor }),
      num('motorVn', 'Rated voltage', 0, { unit: 'kV', min: 0, group: 'shortcircuit', symbol: 'UrM', when: isMotor,
        help: 'Zero means the busbar\u2019s nominal voltage.' }),
      num('motorEff', 'Rated efficiency', 95, { unit: '%', min: 0, max: 100, exclusiveMin: true, group: 'shortcircuit', symbol: 'ηrM', when: isMotor }),
      num('motorCosphi', 'Rated power factor', 0.85, { min: 0, max: 1, exclusiveMin: true, group: 'shortcircuit', symbol: 'cos φrM', when: isMotor }),
      num('motorIlr', 'Locked-rotor current', 5, { unit: '× IrM', min: 0, exclusiveMin: true, group: 'shortcircuit', symbol: 'ILR/IrM', when: isMotor }),
      num('motorRx', 'R/X ratio', 0.1, { min: 0, group: 'shortcircuit', symbol: 'RM/XM', when: isMotor,
        help: 'The ratio of resistance to reactance of the motor\u2019s short-circuit impedance, from its data.' }),
      int('motorPoles', 'Pole pairs', 0, { min: 0, group: 'shortcircuit', when: isMotor,
        help: 'For the decay of the motor\u2019s current by the breaking time. Zero when not known: the breaking current then takes no decay, which errs high.' }),
      attach('pos', 'Connection'),
      { key: 'side', label: 'Side', type: 'enum', group: 'graphic', default: 'below', options: SIDES },
    ],
  },
  shunt: {
    cls: 'shunt', label: 'Shunt', plural: 'Shunts', prefix: 'S', kind: 'shunt', ends: ['bus'],
    fields: [
      name, bus('bus', 'Busbar'), inService,
      num('q', 'Reactive power per section', 10, { unit: 'Mvar', group: 'loadflow', help: 'At rated voltage. Positive for a capacitor, negative for a reactor.' }),
      num('p', 'Active losses per section', 0, { unit: 'MW', min: 0, group: 'loadflow' }),
      num('vn', 'Rated voltage', 110, { unit: 'kV', min: 0, exclusiveMin: true }),
      int('sections', 'Sections in service', 1, { group: 'loadflow', min: 0, operating: true }),
      int('maxSections', 'Sections installed', 1, { group: 'loadflow', min: 1 }),
      { key: 'vControl', label: 'Automatic voltage control', type: 'bool', group: 'loadflow', default: false, operating: true,
        help: 'Switches sections in the load flow when the study case lets switched shunts regulate.' },
      optionalBus('ctrlBus', 'Regulated busbar', 'Own busbar', { when: el => !!el.vControl }),
      num('vTarget', 'Voltage target', 1, { unit: 'p.u.', group: 'loadflow', min: 0.5, max: 1.5, operating: true, when: el => !!el.vControl }),
      num('vBand', 'Dead band', 2, { unit: '%', group: 'loadflow', min: 0, max: 20, when: el => !!el.vControl,
        help: 'Full width of the band the voltage may lie in without switching, % of the busbar\'s nominal voltage.' }),
      attach('pos', 'Connection'),
      { key: 'side', label: 'Side', type: 'enum', group: 'graphic', default: 'below', options: SIDES },
    ],
  },
};

export const CLASS_ORDER = /** @type {ElementClass[]} */ (['bus', 'line', 'trafo', 'gen', 'extgrid', 'load', 'shunt']);

/** @param {string} cls @returns {cls is ElementClass} */
export const isClass = cls => Object.hasOwn(CLASSES, cls);

/** Returns the field spec for a class and key, or undefined. @param {ElementClass} cls @param {string} key */
export const fieldOf = (cls, key) => CLASSES[cls].fields.find(f => f.key === key);

/** Bus-reference keys of an element, in end order. @param {ElementClass} cls */
export const endsOf = cls => CLASSES[cls].ends;

/** A new element of a class with every field at its default. @param {ElementClass} cls @param {string} id
 * @param {Record<string, unknown>} [values] @returns {Element} */
export function makeElement(cls, id, values = {}) {
  /** @type {Element} */
  const el = { id, cls, name: '' };
  for (const f of CLASSES[cls].fields) el[f.key] = f.default;
  return Object.assign(el, values, { id, cls });
}

/** Checks one value against its spec. Returns an error message, or '' when the value is acceptable.
 * @param {FieldSpec} f @param {unknown} v */
export function checkValue(f, v) {
  switch (f.type) {
    case 'number': case 'integer': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${f.label} must be a number.`;
      if (f.type === 'integer' && !Number.isInteger(v)) return `${f.label} must be a whole number.`;
      if (f.min !== undefined && (f.exclusiveMin ? v <= f.min : v < f.min)) return `${f.label} must be ${f.exclusiveMin ? 'greater than' : 'at least'} ${f.min}${f.unit ? ' ' + f.unit : ''}.`;
      if (f.max !== undefined && v > f.max) return `${f.label} must be at most ${f.max}${f.unit ? ' ' + f.unit : ''}.`;
      return '';
    }
    case 'string': case 'bus': case 'trafo': return typeof v === 'string' ? '' : `${f.label} must be text.`;
    case 'bool': return typeof v === 'boolean' ? '' : `${f.label} must be true or false.`;
    case 'enum': return f.options?.includes(/** @type {string} */ (v)) ? '' : `${f.label} must be one of ${f.options?.join(', ')}.`;
    case 'controller': {
      if (v === null) return '';
      if (!v || typeof v !== 'object') return `${f.label} must be a model with its parameters, or none.`;
      const c = /** @type {Record<string, unknown>} */ (v), spec = controllerOf(c.model);
      if (!spec || spec.slot !== f.slot) return `${f.label}: "${String(c.model)}" is not ${f.slot === 'exciter' ? 'an' : 'a'} ${f.slot} model of the library.`;
      for (const p of spec.params) {
        const x = c[p.key];
        if (x === undefined) continue;
        if (typeof x !== 'number' || !Number.isFinite(x)) return `${f.label}: ${p.label} must be a number.`;
        if (p.integer && !Number.isInteger(x)) return `${f.label}: ${p.label} must be a whole number.`;
      }
      return '';
    }
  }
}
