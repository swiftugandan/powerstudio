/** Property editors generated from field specs, used by the inspector and the study case dialog. Values commit on
 * Enter, blur or change; Escape restores the stored value. A rejected value stays in the box, marked, with the
 * reason underneath, so nothing is silently lost. */

import { h } from './dom.js';
import { editable, parseNumber } from './format.js';

/** @typedef {import('../core/catalog.js').FieldSpec} FieldSpec */

/**
 * Builds the label and editor of one field.
 * @param {FieldSpec} f @param {unknown} value
 * @param {(v: unknown) => string} commit returns an error message, or '' on success
 * @param {{ buses?: Array<{ id: string, name: string }>, id?: string, labelOverride?: string }} [ctx]
 * @returns {HTMLElement[]} label, field and an error row
 */
export function fieldRow(f, value, commit, ctx = {}) {
  const id = ctx.id ?? `f-${f.key}-${Math.random().toString(36).slice(2, 7)}`;
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
  if (key === 'balance') return /** @type {Record<string, string>} */ ({
    reference: 'Reference machine or external grid', maxP: 'Machines, by maximum power', targetP: 'Machines, by present power',
    factor: 'Machines, by participation factor', margin: 'Machines, by remaining margin', load: 'Loads, by active power',
  })[v] ?? v;
  return v;
}
