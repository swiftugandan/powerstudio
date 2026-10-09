/** The inspector: properties of the selection (or of the document when nothing is selected), grouped like the
 * calculation they feed, plus the latest results for the selected element. */

import { h, esc } from './dom.js';
import { icon } from './icons.js';
import { fieldRow } from './fields.js';
import { fixed } from './format.js';
import { CLASSES, CLASS_ORDER } from '../core/catalog.js';
import { CLASS_ICON } from './tree.js';
import { minOf, maxOf } from '../core/extent.js';

/** @typedef {import('../core/catalog.js').Element} Element @typedef {import('../core/catalog.js').FieldGroup} FieldGroup */

const GROUPS = /** @type {Array<[FieldGroup, string]>} */ ([['basic', 'Basic data'], ['loadflow', 'Load flow'], ['shortcircuit', 'Short circuit'], ['rms', 'Stability'], ['graphic', 'Diagram']]);

export class Inspector {
  /** @param {HTMLElement} host @param {import('../app.js').App} app */
  constructor(host, app) {
    this.app = app;
    /** @type {Record<string, boolean>} */
    this.open = { graphic: false };
    this.body = h('div', { class: 'panel-body' });
    host.append(h('div', { class: 'panel-header' }, h('span', { class: 'title', text: 'Inspector' }),
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Hide panel', 'aria-label': 'Hide inspector', 'data-cmd': 'view.inspector', html: icon('panelRight', 16) })), this.body);
    this.frame = 0;
  }

  /** Re-renders on the next frame, keeping focus on the same field and the scroll position. */
  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  render() {
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusKey = this.body.contains(active) ? active?.dataset.key : undefined;
    const scroll = this.body.scrollTop;
    const app = this.app, sel = [...app.selection].map(id => app.store.get(id)).filter(e => !!e);
    if (sel.length === 0) this.body.replaceChildren(...this.documentView());
    else if (sel.length === 1) this.body.replaceChildren(...this.elementView(/** @type {Element} */ (sel[0])));
    else this.body.replaceChildren(...this.multiView(/** @type {Element[]} */ (sel)));
    this.body.scrollTop = scroll;
    if (focusKey) {
      const el = /** @type {HTMLInputElement | null} */ (this.body.querySelector(`[data-key="${focusKey}"]`));
      el?.focus();
      if (el && 'select' in el && el.type === 'text') el.select();
    }
  }

  /** Puts the cursor in the name field of the selection. */
  focus() {
    const el = /** @type {HTMLInputElement | null} */ (this.body.querySelector('[data-key="name"]'));
    if (el) { el.focus(); el.select(); }
  }

  /** @param {string} key @param {string} label @param {HTMLElement[]} content */
  section(key, label, content) {
    const d = h('details', { class: 'insp-section', 'data-section': key });
    d.open = this.open[key] ?? true;
    d.addEventListener('toggle', () => { this.open[key] = d.open; });
    d.append(h('summary', { html: `${icon('chevronDown', 14)}<span>${esc(label)}</span>` }), ...content);
    return d;
  }

  /** @returns {HTMLElement[]} */
  documentView() {
    const app = this.app, doc = app.store.doc;
    const head = h('div', { class: 'insp-head' }, h('div', { class: 'glyph-tile', html: icon('database', 18) }),
      h('div', { class: 'what' }, h('div', { class: 'cls', text: 'Network' }), h('div', { class: 'name', text: doc.name || 'Untitled network' })));
    const props = h('div', { class: 'props' });
    const add = (/** @type {import('../core/catalog.js').FieldSpec} */ f, /** @type {unknown} */ v, /** @type {(v: unknown) => void} */ set) =>
      props.append(...fieldRow(f, v, val => app.tryEdit('Edit network', () => set(val))));
    add({ key: 'name', label: 'Name', type: 'string', group: 'basic', default: '' }, doc.name, v => app.store.transact('Rename network', tx => tx.setDoc('name', String(v).trim() || 'Untitled network')));
    add({ key: 'baseMVA', label: 'Base power', type: 'number', group: 'basic', default: 100, unit: 'MVA', min: 0, exclusiveMin: true }, doc.baseMVA,
      v => { if (!(typeof v === 'number' && v > 0)) throw new Error('Base power must be greater than 0 MVA.'); app.store.transact('Base power', tx => tx.setDoc('baseMVA', v)); });
    add({ key: 'frequency', label: 'Frequency', type: 'enum', group: 'basic', default: '50', options: ['50', '60'], unit: 'Hz' }, String(doc.frequency),
      v => app.store.transact('Frequency', tx => tx.setDoc('frequency', Number(v))));
    const desc = h('textarea', { class: 'input', rows: '6', style: 'height:auto;padding:6px 8px;resize:vertical;grid-column:1/-1', 'aria-label': 'Description', 'data-key': 'description' });
    desc.value = doc.description;
    desc.addEventListener('change', () => app.store.transact('Description', tx => tx.setDoc('description', desc.value)));
    props.append(h('label', { text: 'Description', style: 'grid-column:1/-1' }), desc);
    const counts = h('div', { class: 'insp-summary' });
    for (const cls of CLASS_ORDER) {
      const n = doc.elements.filter(e => e.cls === cls).length;
      counts.append(h('div', { class: 'stat' }, h('div', { class: 'k', text: CLASSES[cls].plural }), h('div', { class: 'v', text: String(n) })));
    }
    /** @type {HTMLElement[]} */
    const out = [head, this.section('doc', 'Network', [props]), this.section('counts', 'Contents', [counts])];
    out.push(h('div', { class: 'insp-note', html: 'Select an element on the diagram or in the model tree to edit it. Double-click an element to jump here.' }));
    return out;
  }

  /** @param {Element} el @returns {HTMLElement[]} */
  elementView(el) {
    const app = this.app, spec = CLASSES[el.cls];
    const head = h('div', { class: 'insp-head' },
      h('div', { class: 'glyph-tile', html: icon(CLASS_ICON[el.cls], 18) }),
      h('div', { class: 'what' }, h('div', { class: 'cls', text: `${spec.label} · ${el.id}` }), h('div', { class: 'name', text: el.name || el.id })),
      h('div', { class: 'insp-actions' },
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Show on diagram', 'aria-label': 'Show on diagram', html: icon('locate', 16), onclick: () => app.viewport.reveal([el.id]) }),
        el.cls !== 'bus' ? h('button', { type: 'button', class: 'icon-btn sm', title: el.inService === false ? 'Switch into service' : 'Switch out of service', 'aria-label': 'Toggle in service', 'aria-pressed': String(el.inService !== false), 'data-cmd': 'edit.toggleService', html: icon('power', 16) }) : null,
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Delete', 'aria-label': 'Delete', 'data-cmd': 'edit.delete', html: icon('delete', 16) })));
    /** @type {HTMLElement[]} */
    const out = [head];
    const results = this.resultsFor(el);
    if (results) out.push(results);
    const buses = app.store.doc.elements.filter(e => e.cls === 'bus').map(b => ({ id: b.id, name: b.name || b.id }));
    for (const [group, label] of GROUPS) {
      const fields = spec.fields.filter(f => f.group === group);
      if (!fields.length) continue;
      const props = h('div', { class: 'props' });
      for (const f of fields) {
        if (el.cls === 'gen' && f.key === 'angle' && el.mode !== 'Reference') continue;
        if (el.cls === 'gen' && f.key === 'q' && el.mode !== 'PQ') continue;
        props.append(...fieldRow(f, el[f.key], v => app.tryEdit(`Edit ${f.label.toLowerCase()}`, () => app.store.transact(`Edit ${f.label.toLowerCase()}`, tx => tx.set(el.id, f.key, f.key === 'name' ? String(v).trim() : v), { coalesce: `field-${el.id}-${f.key}` })), { buses }));
      }
      out.push(this.section(group, label, [props]));
    }
    return out;
  }

  /** @param {Element[]} els */
  multiView(els) {
    const app = this.app;
    const byClass = CLASS_ORDER.map(c => [c, els.filter(e => e.cls === c).length]).filter(([, n]) => n);
    const head = h('div', { class: 'insp-head' }, h('div', { class: 'glyph-tile', html: icon('select', 18) }),
      h('div', { class: 'what' }, h('div', { class: 'cls', text: 'Selection' }), h('div', { class: 'name', text: `${els.length} elements` })));
    const counts = h('div', { class: 'insp-summary' }, ...byClass.map(([c, n]) => h('div', { class: 'stat' }, h('div', { class: 'k', text: CLASSES[/** @type {import('../core/catalog.js').ElementClass} */ (c)].plural }), h('div', { class: 'v', text: String(n) }))));
    const actions = h('div', { style: 'display:flex;gap:8px;padding:0 12px 12px;flex-wrap:wrap' },
      h('button', { type: 'button', class: 'btn', 'data-cmd': 'edit.toggleService', html: `${icon('power', 15)}<span>Switch in or out</span>` }),
      h('button', { type: 'button', class: 'btn danger', 'data-cmd': 'edit.delete', html: `${icon('delete', 15)}<span>Delete</span>` }));
    void app;
    return [head, counts, actions];
  }

  /** Read-only rows with the latest results for an element, or null. @param {Element} el */
  resultsFor(el) {
    const app = this.app, R = app.results;
    /** @type {Array<[string, string]>} */
    const rows = [];
    const kind = app.overlayKind;
    if (kind === 'none') return null;
    if (kind === 'loadflow' && R.loadflow) {
      /** @type {import('../engine/reports.js').LoadFlowResult} */
      const r = R.loadflow.result;
      if (r.deenergized.includes(el.id)) rows.push(['State', 'De-energised']);
      const b = r.buses.find(x => x.id === el.id);
      if (b) rows.push(['Voltage', `${fixed(b.kv, 3)} kV`], ['Voltage', `${fixed(b.vm, 4)} p.u.`], ['Angle', `${fixed(b.va, 3)}°`], ['Type', b.type]);
      const br = r.branches.find(x => x.id === el.id);
      if (br) rows.push(['P from / to', `${fixed(br.pFrom, 2)} / ${fixed(br.pTo, 2)} MW`], ['Q from / to', `${fixed(br.qFrom, 2)} / ${fixed(br.qTo, 2)} Mvar`],
        ['I from / to', `${fixed(br.iFrom, 4)} / ${fixed(br.iTo, 4)} kA`], ['Losses', `${fixed(br.pLoss * 1000, 1)} kW`], ['Loading', Number.isFinite(br.loading) ? `${fixed(br.loading, 1)} %` : 'no rating']);
      const u = [...r.gens, ...r.grids, ...r.loads, ...r.shunts].find(x => x.id === el.id);
      if (u) {
        rows.push(['Active power', `${fixed(u.p, 3)} MW`], ['Reactive power', `${fixed(u.q, 3)} Mvar`]);
        if ('atLimit' in u && u.atLimit) rows.push(['Limit', u.atLimit === 'max' ? 'At upper Q limit' : 'At lower Q limit']);
      }
    } else if (kind === 'shortcircuit' && R.shortcircuit) {
      /** @type {import('../engine/reports.js').ShortCircuitResult} */
      const r = R.shortcircuit.result;
      const b = r.buses.find(x => x.id === el.id);
      if (b) rows.push(['Ik″', `${fixed(b.ikss, 3)} kA`], ['ip', `${fixed(b.ip, 3)} kA`], ['Ith (1 s)', `${fixed(b.ith, 3)} kA`], ['Sk″', `${fixed(b.skss, 1)} MVA`],
        ['κ', fixed(b.kappa, 3)], ['R/X', fixed(b.rx, 3)], ['Z1', `${fixed(b.r1, 4)} + j${fixed(b.x1, 4)} Ω`]);
      if (b && r.fault === '1ph') rows.push(['Z0', Number.isFinite(b.r0) ? `${fixed(b.r0, 4)} + j${fixed(b.x0, 4)} Ω` : '—']);
      const c = r.contributions.find(x => x.id === el.id);
      if (c) rows.push(['Fault current', `${fixed(Math.max(c.iFrom, c.iTo), 3)} kA`]);
    } else if (kind === 'contingency' && R.contingency) {
      /** @type {import('../engine/reports.js').ContingencyResult} */
      const r = R.contingency.result;
      const w = r.worstLoading[el.id];
      if (w) rows.push(['Worst loading', `${fixed(w.value, 1)} %`], ['Worst outage', app.store.get(w.outage)?.name || w.outage]);
      const v = r.worstVoltage[el.id];
      if (v) rows.push(['Lowest voltage', `${fixed(v.min, 4)} p.u.`], ['  when out', app.store.get(v.minOutage)?.name || v.minOutage], ['Highest voltage', `${fixed(v.max, 4)} p.u.`]);
      const c = r.cases.find(x => x.id === el.id);
      if (c) rows.push(['When out of service', c.converged ? `${c.violations.length} violation${c.violations.length === 1 ? '' : 's'}` : 'No convergence']);
    } else if (kind === 'rms' && R.rms) {
      /** @type {import('../engine/reports.js').RmsResult} */
      const r = R.rms.result;
      const m = r.machines.find(x => x.id === el.id);
      if (m) rows.push(['Rotor angle range', `${fixed(minOf(m.delta), 1)}° … ${fixed(maxOf(m.delta), 1)}°`], ['Speed range', `${fixed(minOf(m.speed), 3)} … ${fixed(maxOf(m.speed), 3)} Hz`]);
      const k = r.busIds.indexOf(el.id);
      if (k >= 0) rows.push(['Lowest voltage', `${fixed(minOf(r.voltages[k]), 3)} p.u.`], ['Final voltage', `${fixed(r.voltages[k][r.voltages[k].length - 1], 3)} p.u.`]);
    }
    if (!rows.length) return null;
    const props = h('div', { class: 'props' });
    for (const [k, v] of rows) props.append(h('label', { text: k }), h('div', { class: 'readonly-value', text: v, title: v }));
    const stale = app.resultsStale(kind) ? h('div', { class: 'stale', html: `${icon('warning', 14)}<span>Calculated before the last edit</span>` }) : null;
    const label = { loadflow: 'Load flow results', shortcircuit: 'Short-circuit results', contingency: 'Contingency results', rms: 'Simulation results', none: 'Results' }[kind];
    return this.section('results', label, stale ? [stale, props] : [props]);
  }
}
