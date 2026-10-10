/** Property editors generated from field specs, used by the inspector and the study case dialog. Values commit on
 * Enter, blur or change; Escape restores the stored value. A rejected value stays in the box, marked, with the
 * reason underneath, so nothing is silently lost. */

import { h } from './dom.js';
import { editable, parseNumber } from './format.js';
import { CONTROLLERS, controllerOf, completeController } from '../core/catalog.js';

/** @typedef {import('../core/catalog.js').FieldSpec} FieldSpec */

/** Above this many busbars a busbar field is a text box with suggestions: a list of every busbar of a national
 * network would take seconds to build and cannot be scrolled through. */
export const MANY_BUSES = 200;

/** Suggestion lists, one per list of elements, built when a field first needs one.
 * @type {WeakMap<Array<{ id: string, name: string }>, HTMLDataListElement>} */
const suggestions = new WeakMap();
let suggestionCount = 0;

/**
 * An element picker for large networks: shows the element's name, accepts a name or an identifier, and suggests from
 * the list once focused. `apply` calls `pick` with the identifier ('' for the optional empty choice) and returns its
 * error message, or one of its own.
 * @param {Array<{ id: string, name: string }>} buses the elements to choose from @param {string} value @param {string} id
 * @param {(busId: string) => string} pick returns an error message, or '' on success @param {string} [optional]
 * @param {string} [noun] what an element is called in messages
 */
export function elementPicker(buses, value, id, pick, optional, noun = 'busbar') {
  const nameOf = (/** @type {string} */ b) => buses.find(x => x.id === b)?.name || b;
  const input = /** @type {HTMLInputElement} */ (h('input', { id, class: 'input', type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: optional ?? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} name or identifier`, value: value ? nameOf(value) : '' }));
  input.addEventListener('focus', () => {
    let list = suggestions.get(buses);
    if (!list) {
      list = /** @type {HTMLDataListElement} */ (h('datalist', { id: `bus-suggestions-${++suggestionCount}` }));
      list.append(...buses.map(b => h('option', { value: b.name || b.id, label: b.name && b.name !== b.id ? b.id : undefined })));
      document.body.append(list);
      suggestions.set(buses, list);
    }
    input.setAttribute('list', list.id);
  });
  let stored = input.value;
  const apply = () => {
    const text = input.value.trim();
    if (text === stored) return '';
    let busId = '';
    if (text) {
      const byId = buses.find(b => b.id === text);
      const named = buses.filter(b => b.name === text);
      busId = byId?.id ?? (named.length === 1 ? named[0].id : '');
      if (!busId) return named.length > 1 ? `Several ${noun}s are called ${text}; type the identifier.` : `No ${noun} is called ${text}.`;
    } else if (optional === undefined) {
      return `Choose a ${noun}.`;
    }
    const msg = pick(busId);
    if (!msg) { stored = busId ? nameOf(busId) : ''; input.value = stored; }
    return msg;
  };
  return { input, apply };
}

/**
 * Builds the label and editor of one field.
 * @param {FieldSpec} f @param {unknown} value
 * @param {(v: unknown) => string} commit returns an error message, or '' on success
 * @param {{ buses?: Array<{ id: string, name: string }>, id?: string, labelOverride?: string }} [ctx]
 * @returns {HTMLElement[]} label, field and an error row
 */
export function fieldRow(f, value, commit, ctx = {}) {
  const id = ctx.id ?? `f-${f.key}-${Math.random().toString(36).slice(2, 7)}`;
  if (f.type === 'controller') return controllerRows(f, /** @type {Record<string, unknown> | null} */ (value), commit, id);
  const label = h('label', { for: id, text: ctx.labelOverride ?? f.label, title: f.help });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const wrap = h('div', { class: 'field' });
  /** @param {string} msg */
  const showError = msg => { error.textContent = msg; error.hidden = !msg; input.classList.toggle('invalid', !!msg); input.setAttribute('aria-invalid', String(!!msg)); };
  /** @type {HTMLInputElement | HTMLSelectElement} */
  let input;
  if (f.type === 'bool') {
    input = h('input', { type: 'checkbox', id, class: 'check' });
    /** @type {HTMLInputElement} */ (input).checked = !!value;
    input.addEventListener('change', () => showError(commit(/** @type {HTMLInputElement} */ (input).checked)));
  } else if (f.type === 'bus' && (ctx.buses?.length ?? 0) > MANY_BUSES) {
    const picker = elementPicker(ctx.buses ?? [], String(value ?? ''), id, v => commit(v), f.optional);
    input = picker.input;
    input.addEventListener('change', () => showError(picker.apply()));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); showError(picker.apply()); } });
  } else if (f.type === 'enum' || f.type === 'bus') {
    input = h('select', { id, class: 'input' });
    const options = f.type === 'bus' ? (ctx.buses ?? []).map(b => ({ value: b.id, label: b.name || b.id })) : (f.options ?? []).map(o => ({ value: o, label: enumLabel(f.key, o) }));
    if (f.type === 'bus' && f.optional !== undefined) options.unshift({ value: '', label: f.optional });
    for (const o of options) input.append(h('option', { value: o.value, text: o.label }));
    input.value = String(value);
    input.addEventListener('change', () => showError(commit(input.value)));
  } else {
    const numeric = f.type === 'number' || f.type === 'integer';
    input = h('input', { id, class: `input${f.unit ? ' has-unit' : ''}`, type: 'text', inputmode: numeric ? 'decimal' : 'text', spellcheck: 'false', autocomplete: 'off' });
    const shown = numeric ? editable(/** @type {number} */ (value)) : String(value ?? '');
    input.value = shown;
    let stored = shown;
    const apply = () => {
      if (input.value === stored) { showError(''); return; }
      const v = numeric ? parseNumber(input.value) : input.value;
      const msg = commit(v);
      showError(msg);
      if (!msg) { stored = numeric ? editable(/** @type {number} */ (v)) : String(v); input.value = stored; }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = stored; showError(''); input.blur(); }
    });
    input.addEventListener('blur', apply);
  }
  input.dataset.key = f.key;
  wrap.append(input);
  if (f.unit && f.type !== 'bool' && f.type !== 'enum') wrap.append(h('span', { class: 'unit', text: f.unit }));
  return [label, wrap, error];
}

/** Which controls' parameter groups are open, by field key, for this session: an edit redraws the inspector. */
const openControls = new Set();

/**
 * A machine's control: the model, chosen from the library's models for the field's slot (or none), and below it the
 * model's parameters in a group that opens on demand. Changing the model starts it from its typical values.
 * @param {FieldSpec} f @param {Record<string, unknown> | null} value @param {(v: unknown) => string} commit @param {string} id
 * @returns {HTMLElement[]}
 */
function controllerRows(f, value, commit, id) {
  const spec = value ? controllerOf(value.model) : undefined;
  const select = h('select', { id, class: 'input' }, h('option', { value: '', text: 'None' }),
    ...CONTROLLERS.filter(c => c.slot === f.slot).map(c => h('option', { value: c.model, text: `${c.model} · ${c.label}` })));
  select.value = spec ? spec.model : '';
  select.dataset.key = f.key;
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  select.addEventListener('change', () => {
    const msg = commit(select.value ? completeController({ model: select.value }) : null);
    error.textContent = msg;
    error.hidden = !msg;
  });
  /** @type {HTMLElement[]} */
  const out = [h('label', { for: id, text: f.label, title: f.help }), h('div', { class: 'field' }, select), error];
  if (!spec || !value) return out;
  const params = h('div', { class: 'props' });
  const group = h('details', { class: 'control-params', open: openControls.has(f.key) },
    h('summary', { text: `${spec.model} parameters (${spec.params.length})` }), params);
  group.addEventListener('toggle', () => { if (/** @type {HTMLDetailsElement} */ (group).open) openControls.add(f.key); else openControls.delete(f.key); });
  out.push(group);
  for (const p of spec.params) {
    /** @type {FieldSpec} */
    const pf = p.choices
      ? { key: `${f.key}.${p.key}`, label: p.label, type: 'enum', group: f.group, default: String(p.default), options: p.choices.map(([v]) => String(v)), help: p.help }
      : { key: `${f.key}.${p.key}`, label: p.label, type: p.integer ? 'integer' : 'number', group: f.group, default: p.default, unit: p.unit, help: p.help };
    const current = typeof value[p.key] === 'number' ? value[p.key] : p.default;
    const rows = fieldRow(pf, p.choices ? String(current) : current, v => {
      const x = typeof v === 'string' ? Number(v) : /** @type {number} */ (v);
      if (!Number.isFinite(x)) return `${p.label} must be a number.`;
      if (p.integer && !Number.isInteger(x)) return `${p.label} must be a whole number.`;
      return commit({ ...value, [p.key]: x });
    }, { id: `${id}-${p.key.replace(/[^\w]/g, '_')}` });
    params.append(...rows);
  }
  return out;
}

/** Readable labels for enum options. @param {string} key @param {string} v */
export function enumLabel(key, v) {
  if (key === 'fault') return /** @type {Record<string, string>} */ ({ '3ph': 'Three-phase', '2ph': 'Line to line', '1ph': 'Line to earth' })[v] ?? v;
  if (key === 'mode' && (v === 'max' || v === 'min')) return v === 'max' ? 'Maximum currents' : 'Minimum currents';
  if (key === 'kappa') return v === 'B' ? 'Method B (R/X at the fault)' : 'Method C (equivalent frequency)';
  if (key === 'lvTolerance') return `${v} % (cmax ${v === '6' ? '1.05' : '1.10'})`;
  if (key === 'orient') return v === 'h' ? 'Horizontal' : 'Vertical';
  if (key === 'side') return v === 'above' ? 'Above / left' : 'Below / right';
  if (key === 'magnetising') return /** @type {Record<string, string>} */ ({ both: 'Both windings', hv: 'HV winding', lv: 'LV winding' })[v] ?? v;
  if (key === 'tapKind') return v === 'phase' ? 'Phase shift' : 'Voltage ratio';
  if (key === 'machineModel') return v === 'roundRotor' ? 'Round rotor' : 'Classical';
  const signal = /^(exciter|governor|stabiliser)\.MODE2?$/.test(key) ? controllerOf('IEEEST')?.params[0].choices?.find(([c]) => String(c) === v) : undefined;
  if (signal) return signal[1];
  if (key === 'balance') return /** @type {Record<string, string>} */ ({
    reference: 'Reference machine or external grid', maxP: 'Machines, by maximum power', targetP: 'Machines, by present power',
    factor: 'Machines, by participation factor', margin: 'Machines, by remaining margin', load: 'Loads, by active power',
  })[v] ?? v;
  return v;
}
