/** The element catalogue: every class a PowerStudio network can hold, with the fields each one carries.
 *
 * The field specs are the single source of truth for the inspector, for validation of imported files and for the
 * documentation tables in docs/ENGINE.md. Values are stored in engineering units (kV, MW, Ω/km, %) as a network
 * engineer enters them; the engine converts them to its model on import (engine/crates/ps-io/src/powerstudio.rs). */

/**
 * @typedef {'number' | 'integer' | 'string' | 'bool' | 'enum' | 'bus'} FieldType
 * @typedef {'basic' | 'loadflow' | 'shortcircuit' | 'rms' | 'graphic'} FieldGroup
 * @typedef {{
 *   key: string, label: string, type: FieldType, group: FieldGroup, default: unknown,
 *   unit?: string, min?: number, max?: number, exclusiveMin?: boolean, options?: readonly string[], help?: string,
 *   symbol?: string, optional?: string, when?: (el: Record<string, unknown>) => boolean,
 * }} FieldSpec
 * `optional` lets a busbar field be empty and names that choice ("Own busbar"); `when` shows a field only when it
 * applies to the element's other values (a control's target only while the control is on).
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
const inService = /** @type {FieldSpec} */ ({ key: 'inService', label: 'In service', type: 'bool', group: 'basic', default: true });
const name = /** @type {FieldSpec} */ ({ key: 'name', label: 'Name', type: 'string', group: 'basic', default: '' });
/** Position of a connection along its bus bar, from -0.5 (start) to 0.5 (end). @param {string} key @param {string} label */
const attach = (key, label) => num(key, label, 0, { group: 'graphic', min: -0.5, max: 0.5, help: 'Position along the bus bar, from -0.5 (start) to 0.5 (end).' });

export const VECTOR_GROUPS = /** @type {const} */ (['YNyn0', 'YNd1', 'YNd5', 'YNd11', 'Dyn1', 'Dyn5', 'Dyn11', 'Yd1', 'Yd5', 'Yd11', 'Dy1', 'Dy5', 'Dy11', 'Yy0', 'YNy0', 'Yyn0', 'Dd0']);
export const GEN_MODES = /** @type {const} */ (['PV', 'PQ', 'Reference']);
export const SIDES = /** @type {const} */ (['below', 'above']);
export const MAGNETISING = /** @type {const} */ (['both', 'hv', 'lv']);
export const TAP_KINDS = /** @type {const} */ (['ratio', 'phase']);

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
      num('r0', 'Zero-sequence R0′', 0.36, { unit: 'Ω/km', min: 0, group: 'shortcircuit' }),
      num('x0', 'Zero-sequence X0′', 1.17, { unit: 'Ω/km', min: 0, exclusiveMin: true, group: 'shortcircuit' }),
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
      int('tapPos', 'Tap position', 0, { group: 'loadflow' }),
      int('tapNeutral', 'Neutral position', 0, { group: 'loadflow' }),
      int('tapMin', 'Lowest position', -9, { group: 'loadflow' }),
      int('tapMax', 'Highest position', 9, { group: 'loadflow' }),
      { key: 'tapControl', label: 'Automatic tap control', type: 'bool', group: 'loadflow', default: false,
        help: 'Moves the taps in the load flow when the study case lets tap changers or phase shifters regulate.' },
      optionalBus('ctrlBus', 'Regulated busbar', 'LV busbar', { when: el => !!el.tapControl && el.tapKind !== 'phase' }),
      num('vTarget', 'Voltage target', 1, { unit: 'p.u.', group: 'loadflow', min: 0.5, max: 1.5, when: el => !!el.tapControl && el.tapKind !== 'phase' }),
      num('vBand', 'Dead band', 2, { unit: '%', group: 'loadflow', min: 0, max: 20, when: el => !!el.tapControl && el.tapKind !== 'phase',
        help: 'Full width of the band the voltage may lie in without a tap change, % of the busbar\'s nominal voltage.' }),
      num('pTarget', 'Active power target', 0, { unit: 'MW', group: 'loadflow', when: el => !!el.tapControl && el.tapKind === 'phase',
        help: 'Active power into the transformer at its HV winding.' }),
      num('pBand', 'Dead band', 5, { unit: 'MW', group: 'loadflow', min: 0, when: el => !!el.tapControl && el.tapKind === 'phase',
        help: 'Full width of the band the flow may lie in without a tap change.' }),
      num('uk0', 'Zero-sequence uk0', 12, { unit: '%', min: 0, exclusiveMin: true, group: 'shortcircuit' }),
      num('ur0', 'Zero-sequence uR0', 0.4, { unit: '%', min: 0, group: 'shortcircuit' }),
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
      num('p', 'Active power', 50, { unit: 'MW', group: 'loadflow', symbol: 'P' }),
      num('q', 'Reactive power (PQ mode)', 0, { unit: 'Mvar', group: 'loadflow', symbol: 'Q', when: el => el.mode === 'PQ' }),
      num('vset', 'Voltage setpoint', 1.0, { unit: 'p.u.', min: 0.5, max: 1.5, group: 'loadflow', when: el => el.mode !== 'PQ' }),
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
      num('xdt', 'Transient reactance xd′', 0.25, { unit: 'p.u.', min: 0, exclusiveMin: true, group: 'rms' }),
      num('h', 'Inertia constant', 4, { unit: 's', min: 0, exclusiveMin: true, group: 'rms', symbol: 'H' }),
      num('damping', 'Damping', 0, { unit: 'p.u.', min: 0, group: 'rms', symbol: 'D' }),
      attach('pos', 'Connection'),
      { key: 'side', label: 'Side', type: 'enum', group: 'graphic', default: 'above', options: SIDES },
    ],
  },
  extgrid: {
    cls: 'extgrid', label: 'External grid', plural: 'External grids', prefix: 'X', kind: 'shunt', ends: ['bus'],
    fields: [
      name, bus('bus', 'Busbar'), inService,
      num('vset', 'Voltage setpoint', 1.0, { unit: 'p.u.', min: 0.5, max: 1.5, group: 'loadflow' }),
      num('angle', 'Voltage angle', 0, { unit: '°', group: 'loadflow' }),
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
      num('p', 'Active power', 10, { unit: 'MW', group: 'loadflow', symbol: 'P', help: 'At nominal voltage.' }),
      num('q', 'Reactive power', 3, { unit: 'Mvar', group: 'loadflow', symbol: 'Q', help: 'At nominal voltage.' }),
      num('pZ', 'Constant impedance share of P', 0, { unit: '%', group: 'loadflow', min: 0, max: 100,
        help: 'The share of the active power that varies with the voltage squared; constant current varies with the voltage, and the rest is constant power.' }),
      num('pI', 'Constant current share of P', 0, { unit: '%', group: 'loadflow', min: 0, max: 100 }),
      num('qZ', 'Constant impedance share of Q', 0, { unit: '%', group: 'loadflow', min: 0, max: 100 }),
      num('qI', 'Constant current share of Q', 0, { unit: '%', group: 'loadflow', min: 0, max: 100 }),
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
      int('sections', 'Sections in service', 1, { group: 'loadflow', min: 0 }),
      int('maxSections', 'Sections installed', 1, { group: 'loadflow', min: 1 }),
      { key: 'vControl', label: 'Automatic voltage control', type: 'bool', group: 'loadflow', default: false,
        help: 'Switches sections in the load flow when the study case lets switched shunts regulate.' },
      optionalBus('ctrlBus', 'Regulated busbar', 'Own busbar', { when: el => !!el.vControl }),
      num('vTarget', 'Voltage target', 1, { unit: 'p.u.', group: 'loadflow', min: 0.5, max: 1.5, when: el => !!el.vControl }),
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
    case 'string': case 'bus': return typeof v === 'string' ? '' : `${f.label} must be text.`;
    case 'bool': return typeof v === 'boolean' ? '' : `${f.label} must be true or false.`;
    case 'enum': return f.options?.includes(/** @type {string} */ (v)) ? '' : `${f.label} must be one of ${f.options?.join(', ')}.`;
  }
}
