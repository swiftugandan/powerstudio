/** Projects: one network studied under many conditions.
 *
 * A project holds the network model as built (the base document), variants (planned changes to the equipment, kept as
 * the editor's operations), scenarios (operating points: overrides of the fields the catalogue marks `operating`), and
 * study cases (a scenario, the active variants and the calculation settings). The editor works on the active study
 * case's composition: the base, then each active variant's operations replayed in project order, then the scenario's
 * overrides, with the case's settings as the document's study.
 *
 * Every edit is routed to the part of the project it belongs to (`route`):
 * - a calculation setting (a `study` operation) goes to the active study case;
 * - an operating field goes to the active scenario, when the case has one;
 * - a drawing field goes to whichever part holds the element (the base, or the variant that added it), since diagrams
 *   are not planned changes;
 * - anything else goes to the variant being recorded, or to the variant that added the element, or else to the base.
 *
 * Operations are copied as they are recorded: the store's operations carry live elements and arrays. Replaying a
 * variant over a base edited since it was recorded is tolerant (`replay`): a value is set whatever it was before, an
 * element is added after the others of its class, a removal of an element that is not there does nothing, and a
 * scenario's override of an element the composition does not have is dropped. */

import { CLASS_ORDER, fieldOf } from './catalog.js';
import { DRAWING_KEYS } from './store.js';

/**
 * @typedef {import('./document.js').PowerDocument} PowerDocument
 * @typedef {import('./document.js').Study} Study
 * @typedef {import('./catalog.js').Element} Element
 * @typedef {import('./store.js').Op} Op
 * @typedef {{ id: string, name: string, description: string, inService: string, ops: Op[] }} Variant A planned change
 *   to the equipment; `inService` is the date it is planned for (ISO, '' for none).
 * @typedef {{ id: string, name: string, description: string, values: Record<string, Record<string, unknown>> }} Scenario
 *   An operating point: values of operating fields by element and field.
 * @typedef {{ id: string, name: string, scenario: string, variants: string[], study: Study }} StudyCase What to
 *   calculate: a scenario ('' for the base values), the active variants and the settings.
 * @typedef {{ base: PowerDocument, variants: Variant[], scenarios: Scenario[], cases: StudyCase[], activeCase: string,
 *   recording: string }} Project `recording` is the variant edits to the equipment go to ('' for the base); it is one
 *   of the active case's variants.
 * @typedef {'base' | 'manifest' | `variant:${string}` | `scenario:${string}`} Part A separately stored part.
 */

/** A project holding one document, with one study case for its settings. @param {PowerDocument} doc @returns {Project} */
export function projectFromDocument(doc) {
  return { base: doc, variants: [], scenarios: [], cases: [{ id: 'case-1', name: 'Base case', scenario: '', variants: [], study: structuredClone(doc.study) }], activeCase: 'case-1', recording: '' };
}

/** The active study case. @param {Project} p @returns {StudyCase} */
export function activeCase(p) {
  return p.cases.find(c => c.id === p.activeCase) ?? p.cases[0];
}

/** The document the editor works on: the base with the active case's variants and scenario applied.
 * @param {Project} p @returns {PowerDocument} */
export function compose(p) {
  const steps = composeSteps(p);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/** Elements copied between two pauses of `composeSteps`. */
const COPY_STEP = 5000;

/**
 * `compose` in steps: it pauses after every few thousand elements copied, so the app can spread the composition of a
 * national network over several frames.
 * @param {Project} p @returns {Generator<void, PowerDocument, void>}
 */
export function* composeSteps(p) {
  const c = activeCase(p);
  const { elements, ...rest } = p.base;
  const doc = /** @type {PowerDocument} */ ({ ...structuredClone(rest), elements: [] });
  for (let i = 0; i < elements.length; i += COPY_STEP) {
    for (const el of structuredClone(elements.slice(i, i + COPY_STEP))) doc.elements.push(el);
    if (i + COPY_STEP < elements.length) yield;
  }
  for (const v of p.variants) if (c.variants.includes(v.id)) replay(doc, v.ops);
  const scenario = p.scenarios.find(s => s.id === c.scenario);
  if (scenario) {
    const index = new Map(doc.elements.map(e => [e.id, e]));
    for (const [id, fields] of Object.entries(scenario.values)) {
      const el = index.get(id);
      if (!el) continue;
      for (const [key, value] of Object.entries(fields)) if (fieldOf(el.cls, key)?.operating) el[key] = structuredClone(value);
    }
  }
  doc.study = structuredClone(c.study);
  return doc;
}

/**
 * Applies recorded operations to a document, tolerating a document that changed since they were recorded.
 * @param {PowerDocument} doc @param {Op[]} ops
 */
export function replay(doc, ops) {
  const index = new Map(doc.elements.map(e => [e.id, e]));
  for (const op of ops) {
    if (op.type === 'set') {
      const el = index.get(op.id);
      if (el) el[op.key] = structuredClone(op.after);
    } else if (op.type === 'add') {
      if (index.has(op.el.id)) continue;
      const el = structuredClone(op.el);
      doc.elements.splice(slotFor(doc.elements, el.cls), 0, el);
      index.set(el.id, el);
    } else if (op.type === 'remove') {
      if (!index.has(op.el.id)) continue;
      doc.elements.splice(doc.elements.findIndex(e => e.id === op.el.id), 1);
      index.delete(op.el.id);
    } else if (op.type === 'doc') {
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (doc))[op.key] = structuredClone(op.after);
    }
  }
}

/** Where an element of a class goes: after the last element of its class, keeping the document grouped by class.
 * @param {Element[]} elements @param {import('./catalog.js').ElementClass} cls */
function slotFor(elements, cls) {
  const order = CLASS_ORDER.indexOf(cls);
  for (let i = 0; i < elements.length; i++) if (CLASS_ORDER.indexOf(elements[i].cls) > order) return i;
  return elements.length;
}

/**
 * Records the store's operations in the parts of the project they belong to, as the module comment sets out, and
 * returns the parts that changed.
 * @param {Project} p @param {Op[]} ops @returns {Set<Part>}
 */
export function route(p, ops) {
  /** @type {Set<Part>} */
  const dirty = new Set();
  const c = activeCase(p);
  const scenario = p.scenarios.find(s => s.id === c.scenario);
  const recording = c.variants.includes(p.recording) ? p.variants.find(v => v.id === p.recording) : undefined;
  const base = new Map(p.base.elements.map(e => [e.id, e]));
  /** The elements active variants add, with the variant (the last to add one wins) and the class. */
  /** @type {Map<string, { v: Variant, cls: import('./catalog.js').ElementClass }>} */
  const added = new Map();
  for (const v of p.variants) {
    if (!c.variants.includes(v.id)) continue;
    for (const op of v.ops) if (op.type === 'add') added.set(op.el.id, { v, cls: op.el.cls });
  }
  /** The active variant that added an element, when the base does not have it. @param {string} id */
  const addedBy = id => (base.has(id) ? undefined : added.get(id)?.v);
  /** @param {Variant} v @param {Op} op */
  const log = (v, op) => {
    v.ops.push(structuredClone(op));
    if (op.type === 'add') added.set(op.el.id, { v, cls: op.el.cls });
    dirty.add(`variant:${v.id}`);
  };
  for (const op of ops) {
    if (op.type === 'study') {
      /** @type {Record<string, any>} */ (c.study)[op.section][op.key] = structuredClone(op.after);
      dirty.add('manifest');
    } else if (op.type === 'doc') {
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (p.base))[op.key] = structuredClone(op.after);
      dirty.add('base');
    } else if (op.type === 'set') {
      const cls = base.get(op.id)?.cls ?? added.get(op.id)?.cls;
      const operating = cls ? !!fieldOf(cls, op.key)?.operating : false;
      if (operating && scenario) {
        (scenario.values[op.id] ??= {})[op.key] = structuredClone(op.after);
        dirty.add(`scenario:${scenario.id}`);
        continue;
      }
      const owner = addedBy(op.id);
      if (owner) log(owner, op);
      else if (recording && !DRAWING_KEYS.has(op.key)) log(recording, op);
      else {
        const el = base.get(op.id);
        if (el) { el[op.key] = structuredClone(op.after); dirty.add('base'); }
      }
    } else if (op.type === 'add') {
      if (recording) { log(recording, op); continue; }
      const el = structuredClone(op.el);
      p.base.elements.splice(slotFor(p.base.elements, el.cls), 0, el);
      base.set(el.id, el);
      dirty.add('base');
    } else if (op.type === 'remove') {
      const owner = addedBy(op.el.id) ?? recording;
      if (owner) { log(owner, op); continue; }
      const i = p.base.elements.findIndex(e => e.id === op.el.id);
      if (i >= 0) { p.base.elements.splice(i, 1); base.delete(op.el.id); dirty.add('base'); }
    }
  }
  return dirty;
}

/** A new identifier for a part, unique among `taken`. @param {string} prefix @param {Iterable<string>} taken */
export function newPartId(prefix, taken) {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/** The manifest part: the project's variants and scenarios without their contents, its study cases, and what is
 * active. @param {Project} p */
export function manifestOf(p) {
  return {
    version: 1,
    variants: p.variants.map(({ ops: _, ...meta }) => meta),
    scenarios: p.scenarios.map(({ values: _, ...meta }) => meta),
    cases: p.cases, activeCase: p.activeCase, recording: p.recording,
  };
}

/**
 * The stored text of the given parts other than the base (which is stored as a document); a variant or scenario that
 * no longer exists is deleted (null).
 * @param {Project} p @param {Iterable<Part>} parts @returns {Array<[string, string | null]>}
 */
export function partTexts(p, parts) {
  /** @type {Array<[string, string | null]>} */
  const out = [];
  for (const part of parts) {
    if (part === 'base') continue;
    if (part === 'manifest') { out.push(['manifest', JSON.stringify(manifestOf(p))]); continue; }
    const [kind, id] = part.split(':');
    const name = `${kind}/${id}`;
    if (kind === 'variant') { const v = p.variants.find(x => x.id === id); out.push([name, v ? JSON.stringify(v.ops) : null]); }
    else { const s = p.scenarios.find(x => x.id === id); out.push([name, s ? JSON.stringify(s.values) : null]); }
  }
  return out;
}

/**
 * A project from its stored parts; a document stored before projects has none and gets one study case.
 * @param {PowerDocument} base @param {Map<string, string>} parts @returns {Project}
 */
export function projectFromParts(base, parts) {
  const text = parts.get('manifest');
  if (!text) return projectFromDocument(base);
  /** @type {ReturnType<typeof manifestOf>} */
  const m = JSON.parse(text);
  const read = (/** @type {string} */ name, /** @type {unknown} */ fallback) => { const t = parts.get(name); return t ? JSON.parse(t) : fallback; };
  const p = /** @type {Project} */ ({
    base,
    variants: m.variants.map(v => ({ ...v, ops: read(`variant/${v.id}`, []) })),
    scenarios: m.scenarios.map(s => ({ ...s, values: read(`scenario/${s.id}`, {}) })),
    cases: m.cases, activeCase: m.activeCase, recording: m.recording,
  });
  if (!p.cases.length) p.cases = projectFromDocument(base).cases;
  if (!p.cases.some(c => c.id === p.activeCase)) p.activeCase = p.cases[0].id;
  if (!activeCase(p).variants.includes(p.recording)) p.recording = '';
  return p;
}

/** Every part of a project, for a first save. @param {Project} p @returns {Part[]} */
export function allParts(p) {
  return ['base', 'manifest', ...p.variants.map(v => /** @type {Part} */ (`variant:${v.id}`)), ...p.scenarios.map(s => /** @type {Part} */ (`scenario:${s.id}`))];
}
