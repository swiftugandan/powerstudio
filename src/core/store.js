/** The document store: the open document, its edit history and change notifications.
 *
 * Every user-visible change goes through `transact`, which records each operation with the value it replaced so
 * undo and redo can play it back exactly. Values are checked against the catalogue before they are written, so the
 * document is always valid. Consecutive edits that share a coalescing key (a drag, typing in one field) merge into one
 * undo step. */

import { CLASSES, CLASS_ORDER, checkValue, fieldOf } from './catalog.js';
import { STUDY_FIELDS, busesOf } from './document.js';

/**
 * @typedef {import('./catalog.js').Element} Element
 * @typedef {import('./document.js').PowerDocument} PowerDocument
 * @typedef {{ type: 'set', id: string, key: string, before: unknown, after: unknown }
 *   | { type: 'add', el: Element, index: number }
 *   | { type: 'remove', el: Element, index: number }
 *   | { type: 'doc', key: 'name' | 'description' | 'baseMVA' | 'frequency', before: unknown, after: unknown }
 *   | { type: 'study', section: string, key: string, before: unknown, after: unknown }} Op
 * @typedef {{ label: string, ops: Op[], coalesce: string, time: number }} Transaction
 * @typedef {{ label: string, ids: Set<string>, structural: boolean, network: boolean, study: boolean, meta: boolean,
 *   source: 'edit' | 'undo' | 'redo' | 'load', ops: Op[] }} Change A change, with the operations as they were applied
 */

const HISTORY = 200;
const COALESCE_MS = 1200;

export class DocumentStore {
  /** @param {PowerDocument} doc */
  constructor(doc) {
    /** @type {PowerDocument} */
    this.doc = doc;
    /** @type {Map<string, Element>} */
    this.index = new Map();
    /** @type {Transaction[]} */
    this.past = [];
    /** @type {Transaction[]} */
    this.future = [];
    /** @type {Set<(change: Change) => void>} */
    this.listeners = new Set();
    this.revision = 0;
    this.reindex();
  }

  reindex() { this.index = new Map(this.doc.elements.map(e => [e.id, e])); }

  /** @param {string} id */
  get(id) { return this.index.get(id); }

  /** @param {(change: Change) => void} fn */
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Replaces the whole document, clearing history. @param {PowerDocument} doc */
  load(doc) {
    this.doc = doc;
    this.past = []; this.future = [];
    this.reindex();
    this.emit({ label: 'Open', ids: new Set(), structural: true, network: true, study: true, meta: true, source: 'load', ops: [] });
  }

  /**
   * Runs an edit. The callback receives an editing API; if it throws, everything it did is rolled back.
   * @param {string} label shown in the Undo and Redo tooltips @param {(tx: Tx) => void} fn @param {{ coalesce?: string }} [opt]
   */
  transact(label, fn, opt = {}) {
    const tx = new Tx(this);
    try { fn(tx); }
    catch (error) { tx.rollback(); throw error; }
    if (!tx.ops.length) return;
    const now = Date.now(), last = this.past[this.past.length - 1];
    if (opt.coalesce && last && last.coalesce === opt.coalesce && now - last.time < COALESCE_MS) {
      for (const op of tx.ops) last.ops.push(op);
      last.time = now;
    } else {
      this.past.push({ label, ops: tx.ops, coalesce: opt.coalesce ?? '', time: now });
      if (this.past.length > HISTORY) this.past.shift();
    }
    this.future = [];
    this.emit(describe(label, tx.ops, 'edit'));
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get undoLabel() { return this.past[this.past.length - 1]?.label ?? ''; }
  get redoLabel() { return this.future[this.future.length - 1]?.label ?? ''; }

  undo() {
    const t = this.past.pop();
    if (!t) return;
    const applied = [];
    for (let i = t.ops.length - 1; i >= 0; i--) { const op = invert(t.ops[i]); this.apply(op); applied.push(op); }
    this.future.push(t);
    this.emit(describe(t.label, applied, 'undo'));
  }

  redo() {
    const t = this.future.pop();
    if (!t) return;
    for (const op of t.ops) this.apply(op);
    t.time = 0; // never coalesce into a redone step
    this.past.push(t);
    this.emit(describe(t.label, t.ops, 'redo'));
  }

  /** @param {Op} op */
  apply(op) { applyOp(this.doc, this.index, op); }

  /** @param {Change} change */
  emit(change) {
    this.revision++;
    for (const fn of this.listeners) fn(change);
  }
}

/** The editing API handed to a transaction. */
export class Tx {
  /** @param {DocumentStore} store */
  constructor(store) {
    this.store = store;
    /** @type {Op[]} */
    this.ops = [];
  }

  /** @param {Op} op */
  run(op) { this.store.apply(op); this.ops.push(op); }

  rollback() {
    for (let i = this.ops.length - 1; i >= 0; i--) this.store.apply(invert(this.ops[i]));
    this.ops = [];
  }

  /** Sets one field after checking it against the catalogue. @param {string} id @param {string} key @param {unknown} value */
  set(id, key, value) {
    const el = this.store.get(id);
    if (!el) throw new Error(`Unknown element ${id}.`);
    const spec = fieldOf(el.cls, key);
    if (!spec) throw new Error(`${CLASSES[el.cls].label} has no field ${key}.`);
    const err = checkValue(spec, value);
    if (err) throw new Error(err);
    // An optional busbar field may be empty: its named default ("Own busbar").
    if (spec.type === 'bus' && !(value === '' && spec.optional !== undefined)) {
      const bus = this.store.get(/** @type {string} */ (value));
      if (!bus || bus.cls !== 'bus') throw new Error(`${spec.label} must be a busbar.`);
      const others = busesOf(el).filter((_, i) => CLASSES[el.cls].ends[i] !== key);
      if (others.includes(/** @type {string} */ (value))) throw new Error('Both ends cannot connect to the same busbar.');
    }
    if (Object.is(el[key], value)) return;
    this.run({ type: 'set', id, key, before: el[key], after: value });
  }

  /** Adds an element after the last one of its class, keeping the document grouped by class. @param {Element} el */
  add(el) {
    if (this.store.get(el.id)) throw new Error(`An element with id ${el.id} already exists.`);
    const els = this.store.doc.elements, order = CLASS_ORDER.indexOf(el.cls);
    let index = els.length;
    for (let i = 0; i < els.length; i++) if (CLASS_ORDER.indexOf(els[i].cls) > order) { index = i; break; }
    this.run({ type: 'add', el, index });
  }

  /** Removes an element and, for a busbar, everything connected to it. @param {string} id */
  remove(id) {
    const el = this.store.get(id);
    if (!el) return;
    if (el.cls === 'bus') {
      for (const other of [...this.store.doc.elements]) if (other.cls !== 'bus' && busesOf(other).includes(id)) this.remove(other.id);
      // Optional busbar references (a regulated busbar) fall back to their default.
      for (const other of this.store.doc.elements) {
        for (const f of CLASSES[other.cls].fields) if (f.type === 'bus' && f.optional !== undefined && other[f.key] === id) this.set(other.id, f.key, '');
      }
    }
    // The study case forgets the element: simulation events on it, a zone's slack busbar, and it in contingencies
    // and remedial actions.
    const study = this.store.doc.study;
    if (study.loadflow.areas.some(a => a.slack === id)) this.setStudy('loadflow', 'areas', study.loadflow.areas.map(a => (a.slack === id ? { ...a, slack: '' } : a)));
    const events = study.rms.events.filter(e => e.target !== id);
    if (events.length !== study.rms.events.length) this.setStudy('rms', 'events', events);
    const list = study.contingency.list.map(c => ({ ...c, elements: c.elements.filter(e => e !== id) })).filter(c => c.elements.length);
    if (JSON.stringify(list) !== JSON.stringify(study.contingency.list)) this.setStudy('contingency', 'list', list);
    // A rule with a condition on the element goes (without the condition it would fire more widely than meant), and
    // so does a rule only for contingencies that no longer exist (it would otherwise be for every one).
    const kept = new Set(list.map(c => c.id));
    /** @type {typeof study.contingency.remedial} */
    const remedial = [];
    for (const r of study.contingency.remedial) {
      if (r.conditions.some(c => ('node' in c ? c.node : c.element) === id)) continue;
      const contingencies = r.contingencies.filter(c => c !== id && (kept.has(c) || this.store.get(c)));
      const actions = r.actions.filter(a => a.element !== id);
      if (!actions.length || (r.contingencies.length && !contingencies.length)) continue;
      remedial.push({ ...r, contingencies, actions });
    }
    if (JSON.stringify(remedial) !== JSON.stringify(study.contingency.remedial)) this.setStudy('contingency', 'remedial', remedial);
    const index = this.store.doc.elements.indexOf(el);
    this.run({ type: 'remove', el, index });
  }

  /** @param {'name' | 'description' | 'baseMVA' | 'frequency'} key @param {unknown} value */
  setDoc(key, value) {
    const doc = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (this.store.doc));
    if (Object.is(doc[key], value)) return;
    this.run({ type: 'doc', key, before: doc[key], after: value });
  }

  /** @param {string} section @param {string} key @param {unknown} value */
  setStudy(section, key, value) {
    const target = /** @type {Record<string, any>} */ (this.store.doc.study)[section];
    if (!target) throw new Error(`Unknown study section ${section}.`);
    if (!(key === 'events' || (section === 'contingency' && (key === 'list' || key === 'remedial')) || (section === 'loadflow' && key === 'areas'))) {
      const spec = /** @type {Record<string, readonly import('./catalog.js').FieldSpec[]>} */ (STUDY_FIELDS)[section]?.find(f => f.key === key);
      if (!spec) throw new Error(`Unknown study setting ${section}.${key}.`);
      const err = checkValue(spec, value);
      if (err) throw new Error(err);
    }
    if (Object.is(target[key], value)) return;
    this.run({ type: 'study', section, key, before: target[key], after: value });
  }
}

/** @param {Op} op @returns {Op} */
function invert(op) {
  switch (op.type) {
    case 'set': return { ...op, before: op.after, after: op.before };
    case 'add': return { type: 'remove', el: op.el, index: op.index };
    case 'remove': return { type: 'add', el: op.el, index: op.index };
    case 'doc': return { ...op, before: op.after, after: op.before };
    case 'study': return { ...op, before: op.after, after: op.before };
  }
}

const GRAPHIC_KEYS = new Set(['x', 'y', 'len', 'orient', 'fromPos', 'toPos', 'hvPos', 'lvPos', 'pos', 'side', 'bend', 'name']);

/** @param {string} label @param {Op[]} ops @param {Change['source']} source @returns {Change} */
function describe(label, ops, source) {
  const ids = new Set();
  let structural = false, network = false, study = false, meta = false;
  for (const op of ops) {
    if (op.type === 'set') {
      ids.add(op.id);
      if (!GRAPHIC_KEYS.has(op.key)) network = true;
      if (['from', 'to', 'hv', 'lv', 'bus'].includes(op.key)) structural = true;
    } else if (op.type === 'add' || op.type === 'remove') { ids.add(op.el.id); structural = true; network = true; }
    else if (op.type === 'study') study = true;
    else { meta = true; if (op.key === 'baseMVA' || op.key === 'frequency') network = true; }
  }
  return { label, ids, structural, network, study, meta, source, ops };
}

/**
 * Applies one operation to a document and its id index: the store's edits, and the same edits on the copies the
 * calculation workers keep. @param {PowerDocument} doc @param {Map<string, Element>} index @param {Op} op
 */
export function applyOp(doc, index, op) {
  switch (op.type) {
    case 'set': { const el = index.get(op.id); if (el) el[op.key] = op.after; break; }
    case 'add': doc.elements.splice(op.index, 0, op.el); index.set(op.el.id, op.el); break;
    case 'remove': {
      const i = doc.elements.findIndex(e => e.id === op.el.id);
      if (i >= 0) doc.elements.splice(i, 1);
      index.delete(op.el.id);
      break;
    }
    case 'doc': /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (doc))[op.key] = op.after; break;
    case 'study': /** @type {Record<string, any>} */ (doc.study)[op.section][op.key] = op.after; break;
  }
}
