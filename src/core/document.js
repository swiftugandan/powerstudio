/** The PowerStudio document: a network of elements, its single-line diagram positions and its study case.
 *
 * Documents are plain JSON so they can be saved to IndexedDB, exported and re-imported unchanged. `normalizeDocument`
 * is the one gate every document passes on the way in: it fills defaults, drops unknown keys, checks every value
 * against the catalogue and reports what it fixed or rejected. */

import { CLASSES, checkValue, endsOf, isClass, makeElement } from './catalog.js';

/**
 * @typedef {import('./catalog.js').Element} Element
 * @typedef {import('./catalog.js').ElementClass} ElementClass
 * @typedef {import('./catalog.js').FieldSpec} FieldSpec
 * @typedef {{ t: number, kind: 'fault' | 'clear' | 'trip' | 'loadstep', target: string, value?: number }} SimEvent
 * @typedef {{
 *   loadflow: { tolerance: number, maxIter: number, enforceQLimits: boolean, dcStart: boolean, loadScale: number },
 *   shortcircuit: { fault: '3ph' | '2ph' | '1ph', mode: 'max' | 'min', kappa: 'B' | 'C', lvTolerance: '6' | '10', location: string },
 *   contingency: { lines: boolean, trafos: boolean, gens: boolean, maxLoading: number },
 *   rms: { tEnd: number, dt: number, events: SimEvent[] },
 * }} Study
 * @typedef {{ format: 'powerstudio', version: 1, name: string, description: string, baseMVA: number, frequency: 50 | 60,
 *   elements: Element[], study: Study }} PowerDocument
 */

export const FORMAT = 'powerstudio';
export const VERSION = 1;

/** Study case settings, described like element fields so the settings dialog and validation share one spec.
 * @type {Readonly<Record<keyof Omit<Study, 'rms'> | 'rms', readonly FieldSpec[]>>} */
export const STUDY_FIELDS = {
  loadflow: [
    { key: 'tolerance', label: 'Power mismatch tolerance', type: 'number', group: 'loadflow', default: 0.001, unit: 'MVA', min: 1e-9, max: 10 },
    { key: 'maxIter', label: 'Maximum iterations', type: 'integer', group: 'loadflow', default: 30, min: 1, max: 200 },
    { key: 'enforceQLimits', label: 'Respect reactive power limits', type: 'bool', group: 'loadflow', default: false },
    { key: 'dcStart', label: 'Start from a DC load flow', type: 'bool', group: 'loadflow', default: true, help: 'Initial angles come from a DC load flow instead of a flat start. Converges more reliably on meshed networks with phase-shifting transformers.' },
    { key: 'loadScale', label: 'Load scaling', type: 'number', group: 'loadflow', default: 100, unit: '%', min: 0, max: 1000 },
  ],
  shortcircuit: [
    { key: 'fault', label: 'Fault type', type: 'enum', group: 'shortcircuit', default: '3ph', options: ['3ph', '2ph', '1ph'] },
    { key: 'mode', label: 'Calculation', type: 'enum', group: 'shortcircuit', default: 'max', options: ['max', 'min'] },
    { key: 'kappa', label: 'Peak factor method', type: 'enum', group: 'shortcircuit', default: 'C', options: ['B', 'C'] },
    { key: 'lvTolerance', label: 'LV voltage tolerance', type: 'enum', group: 'shortcircuit', default: '10', options: ['6', '10'] },
    { key: 'location', label: 'Fault location', type: 'string', group: 'shortcircuit', default: '', help: 'Empty runs a fault at every busbar in turn.' },
  ],
  contingency: [
    { key: 'lines', label: 'Line outages', type: 'bool', group: 'loadflow', default: true },
    { key: 'trafos', label: 'Transformer outages', type: 'bool', group: 'loadflow', default: true },
    { key: 'gens', label: 'Generator outages', type: 'bool', group: 'loadflow', default: false },
    { key: 'maxLoading', label: 'Loading limit', type: 'number', group: 'loadflow', default: 100, unit: '%', min: 1, max: 1000 },
  ],
  rms: [
    { key: 'tEnd', label: 'Simulation time', type: 'number', group: 'rms', default: 3, unit: 's', min: 0.01, max: 120 },
    { key: 'dt', label: 'Step size', type: 'number', group: 'rms', default: 0.001, unit: 's', min: 1e-5, max: 0.05 },
  ],
};

export const EVENT_KINDS = /** @type {const} */ (['fault', 'clear', 'trip', 'loadstep']);

/** @returns {Study} */
export function defaultStudy() {
  /** @type {Record<string, Record<string, unknown>>} */
  const study = {};
  for (const [section, fields] of Object.entries(STUDY_FIELDS)) {
    study[section] = Object.fromEntries(fields.map(f => [f.key, f.default]));
  }
  study.rms.events = [];
  return /** @type {Study} */ (/** @type {unknown} */ (study));
}

/** @param {string} [name] @returns {PowerDocument} */
export function emptyDocument(name = 'Untitled network') {
  return { format: FORMAT, version: VERSION, name, description: '', baseMVA: 100, frequency: 50, elements: [], study: defaultStudy() };
}

/** Next free id for a class, from the ids already in use. @param {Iterable<string>} ids @param {ElementClass} cls */
export function nextId(ids, cls) {
  const prefix = CLASSES[cls].prefix;
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return prefix + (max + 1);
}

/** Bus ids an element connects to, in end order. @param {Element} el @returns {string[]} */
export function busesOf(el) {
  return endsOf(el.cls).map(k => /** @type {string} */ (el[k]));
}

/** Elements connected to a bus. @param {Iterable<Element>} elements @param {string} busId @returns {Element[]} */
export function attachedTo(elements, busId) {
  const out = [];
  for (const el of elements) if (el.cls !== 'bus' && busesOf(el).includes(busId)) out.push(el);
  return out;
}

/** A readable label for an element. @param {Element} el */
export const labelOf = el => el.name || el.id;

/**
 * Brings any parsed JSON into a valid document. Unknown classes and keys are dropped, missing fields get defaults,
 * invalid values are replaced by defaults, and elements that point at missing buses are removed. Every change is
 * reported so the user can see what an import did.
 * @param {unknown} input @returns {{ doc: PowerDocument, issues: string[] }}
 */
export function normalizeDocument(input) {
  /** @type {string[]} */
  const issues = [];
  if (!input || typeof input !== 'object') throw new Error('The file does not contain a PowerStudio document.');
  const raw = /** @type {Record<string, unknown>} */ (input);
  if (raw.format !== FORMAT) throw new Error('The file is not a PowerStudio document (format field missing).');
  if (typeof raw.version !== 'number' || raw.version > VERSION) throw new Error(`Document version ${String(raw.version)} is newer than this app supports (${VERSION}).`);
  const doc = emptyDocument(typeof raw.name === 'string' ? raw.name : 'Imported network');
  if (typeof raw.description === 'string') doc.description = raw.description;
  if (typeof raw.baseMVA === 'number' && raw.baseMVA > 0) doc.baseMVA = raw.baseMVA;
  if (raw.frequency === 60) doc.frequency = 60;

  const seen = new Set();
  /** @type {Element[]} */
  const elements = [];
  for (const item of Array.isArray(raw.elements) ? raw.elements : []) {
    if (!item || typeof item !== 'object') { issues.push('Skipped an element that is not an object.'); continue; }
    const r = /** @type {Record<string, unknown>} */ (item);
    const cls = String(r.cls);
    if (!isClass(cls)) { issues.push(`Skipped an element of unknown class "${cls}".`); continue; }
    const id = typeof r.id === 'string' && r.id ? r.id : '';
    if (!id || seen.has(id)) { issues.push(`Skipped a ${CLASSES[cls].label.toLowerCase()} with a missing or duplicate id "${id}".`); continue; }
    seen.add(id);
    const el = makeElement(cls, id);
    for (const f of CLASSES[cls].fields) {
      if (!(f.key in r)) continue;
      const err = checkValue(f, r[f.key]);
      if (err) issues.push(`${id}: ${err} Using ${JSON.stringify(f.default)}.`);
      else el[f.key] = r[f.key];
    }
    elements.push(el);
  }
  const buses = new Set(elements.filter(e => e.cls === 'bus').map(e => e.id));
  doc.elements = elements.filter(el => {
    if (el.cls === 'bus') return true;
    const missing = busesOf(el).filter(b => !buses.has(b));
    if (missing.length) issues.push(`${el.id}: removed, it connects to a missing busbar.`);
    else if (new Set(busesOf(el)).size < busesOf(el).length) { issues.push(`${el.id}: removed, both ends are on the same busbar.`); return false; }
    return missing.length === 0;
  });

  const study = raw.study && typeof raw.study === 'object' ? /** @type {Record<string, Record<string, unknown>>} */ (raw.study) : {};
  for (const [section, fields] of Object.entries(STUDY_FIELDS)) {
    const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (doc.study[/** @type {keyof Study} */ (section)]));
    const src = study[section] ?? {};
    for (const f of fields) {
      if (!(f.key in src)) continue;
      const err = checkValue(f, src[f.key]);
      if (err) issues.push(`Study case: ${err}`);
      else target[f.key] = src[f.key];
    }
  }
  const ids = new Set(doc.elements.map(e => e.id));
  for (const ev of Array.isArray(study.rms?.events) ? study.rms.events : []) {
    const e = /** @type {Record<string, unknown>} */ (ev);
    if (typeof e?.t !== 'number' || !EVENT_KINDS.includes(/** @type {never} */ (e.kind)) || typeof e.target !== 'string' || !ids.has(e.target)) {
      issues.push('Study case: skipped an invalid simulation event.');
      continue;
    }
    /** @type {SimEvent} */
    const out = { t: e.t, kind: /** @type {SimEvent['kind']} */ (e.kind), target: e.target };
    if (typeof e.value === 'number') out.value = e.value;
    doc.study.rms.events.push(out);
  }
  doc.study.rms.events.sort((a, b) => a.t - b.t);
  return { doc, issues };
}

/** Structural problems that stop a calculation, as messages. @param {PowerDocument} doc @returns {string[]} */
export function validateForCalculation(doc) {
  const out = [];
  const byId = new Map(doc.elements.map(e => [e.id, e]));
  for (const el of doc.elements) {
    if (el.cls === 'line') {
      const a = byId.get(/** @type {string} */ (el.from)), b = byId.get(/** @type {string} */ (el.to));
      if (a && b && Math.abs(/** @type {number} */ (a.vn) - /** @type {number} */ (b.vn)) > 1e-9 * /** @type {number} */ (a.vn)) {
        out.push(`${labelOf(el)} joins busbars with different nominal voltages (${a.vn} kV and ${b.vn} kV). Use a transformer.`);
      }
    }
  }
  return out;
}
