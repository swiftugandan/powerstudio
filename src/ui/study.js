/** The study case dialog: settings of every calculation and the event list of the stability simulation. */

import { h } from './dom.js';
import { icon } from './icons.js';
import { fieldRow, elementPicker, MANY_BUSES } from './fields.js';
import { modal } from './feedback.js';
import { STUDY_FIELDS, EVENT_KINDS } from '../core/document.js';
import { parseNumber } from './format.js';

const TITLES = /** @type {Record<string, string>} */ ({ loadflow: 'Load flow', shortcircuit: 'Short circuit', contingency: 'Contingency analysis', rms: 'Stability simulation' });
const EVENT_LABEL = /** @type {Record<string, string>} */ ({ fault: 'Three-phase fault at', clear: 'Clear fault at', trip: 'Switch out', loadstep: 'Set load to (% of initial)' });

/** @param {import('../app.js').App} app @param {string} [focusSection] */
export async function openStudyDialog(app, focusSection) {
  const doc = app.store.doc;
  /** @type {Record<string, Record<string, unknown>>} */
  const draft = structuredClone(/** @type {any} */ (doc.study));
  /** @type {Record<string, string>} */
  const errors = {};
  const body = h('div');
  for (const [section, fields] of Object.entries(STUDY_FIELDS)) {
    const props = h('div', { class: 'props' });
    for (const f of fields) {
      if (section === 'shortcircuit' && f.key === 'location') {
        const buses = doc.elements.filter(e => e.cls === 'bus').map(b => ({ id: b.id, name: /** @type {string} */ (b.name) }));
        let control;
        if (buses.length > MANY_BUSES) {
          const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
          const picker = elementPicker(buses, String(draft.shortcircuit.location), 'study-location', v => { draft.shortcircuit.location = v; return ''; }, 'Every busbar');
          picker.input.addEventListener('change', () => { const msg = picker.apply(); error.textContent = msg; error.hidden = !msg; picker.input.classList.toggle('invalid', !!msg); });
          control = [h('div', { class: 'field' }, picker.input), error];
        } else {
          const sel = h('select', { class: 'input', id: 'study-location', 'data-key': 'location' }, h('option', { value: '', text: 'Every busbar' }),
            ...buses.map(b => h('option', { value: b.id, text: b.name || b.id })));
          sel.value = String(draft.shortcircuit.location);
          sel.addEventListener('change', () => { draft.shortcircuit.location = sel.value; });
          control = [h('div', { class: 'field' }, sel)];
        }
        props.append(h('label', { for: 'study-location', text: f.label, title: f.help }), ...control);
        continue;
      }
      props.append(...fieldRow(f, draft[section][f.key], v => {
        draft[section][f.key] = v;
        const k = `${section}.${f.key}`;
        const bad = (f.type === 'number' || f.type === 'integer') && (typeof v !== 'number' || !Number.isFinite(v) || (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max));
        if (bad) { errors[k] = `${f.label} is out of range.`; return errors[k]; }
        delete errors[k];
        return '';
      }));
    }
    body.append(h('h3', { text: TITLES[section], id: `study-${section}` }), props);
    if (section === 'loadflow') {
      const areas = areaEditor(app, /** @type {any} */ (draft.loadflow));
      if (areas) body.append(h('h3', { text: 'Area interchange', id: 'study-areas' }), areas);
    }
    if (section === 'contingency') {
      const { list, remedial } = doc.study.contingency;
      const own = `${list.length} contingenc${list.length === 1 ? 'y' : 'ies'} of your own and ${remedial.length} remedial action${remedial.length === 1 ? '' : 's'}`;
      body.append(h('p', { class: 'study-note', text: `${own}. Edit them from Calculate, Security, Contingencies.` }));
    }
  }
  body.append(h('h3', { text: 'Simulation events' }), eventEditor(app, /** @type {any} */ (draft.rms)));
  const ok = await modal({
    title: 'Study case', body, wide: true,
    actions: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, run: () => (Object.keys(errors).length ? null : true) }],
  });
  if (!ok) return;
  app.tryEdit('Study case', () => app.store.transact('Edit study case', tx => {
    for (const [section, fields] of Object.entries(STUDY_FIELDS)) for (const f of fields) tx.setStudy(section, f.key, draft[section][f.key]);
    const events = /** @type {any[]} */ (draft.rms.events).filter(e => Number.isFinite(e.t) && e.target).sort((a, b) => a.t - b.t);
    if (JSON.stringify(events) !== JSON.stringify(doc.study.rms.events)) tx.setStudy('rms', 'events', events);
    const areas = /** @type {import('../core/document.js').AreaTarget[]} */ (draft.loadflow.areas).filter(a => a.slack || a.export !== 0);
    if (JSON.stringify(areas) !== JSON.stringify(doc.study.loadflow.areas)) tx.setStudy('loadflow', 'areas', areas);
  }));
  if (focusSection) document.getElementById(`study-${focusSection}`)?.scrollIntoView();
}

/**
 * The interchange target of every zone: net export, tolerance and slack busbar. Null when no busbar has a zone.
 * @param {import('../app.js').App} app @param {{ areas: import('../core/document.js').AreaTarget[] }} lf
 */
function areaEditor(app, lf) {
  const doc = app.store.doc;
  const zones = [...new Set(doc.elements.filter(e => e.cls === 'bus' && e.zone).map(e => /** @type {string} */ (e.zone)))].sort((a, b) => a.localeCompare(b, 'en-GB'));
  if (!zones.length) return null;
  // One row per zone, the ones without a target starting empty.
  lf.areas = zones.map(zone => lf.areas.find(a => a.zone === zone) ?? { zone, export: 0, tolerance: 10, slack: '' });
  const number = (/** @type {number} */ v, /** @type {(x: number) => void} */ set, /** @type {string} */ aria, /** @type {number} */ min) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { class: 'input has-unit', value: String(v), 'aria-label': aria, inputmode: 'decimal' }));
    input.addEventListener('change', () => { const x = parseNumber(input.value); const ok = Number.isFinite(x) && x >= min; input.classList.toggle('invalid', !ok); if (ok) set(x); });
    return h('div', { class: 'field' }, input, h('span', { class: 'unit', text: 'MW' }));
  };
  const rows = lf.areas.map(a => {
    const slack = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', 'aria-label': `Slack busbar of ${a.zone}` }, h('option', { value: '', text: 'None: not controlled' }),
      ...doc.elements.filter(e => e.cls === 'bus' && e.zone === a.zone).map(b => h('option', { value: b.id, text: b.name || b.id }))));
    slack.value = a.slack;
    slack.addEventListener('change', () => { a.slack = slack.value; });
    return h('tr', {}, h('td', { class: 'area-zone', text: a.zone, title: a.zone }),
      h('td', { 'data-label': 'Export target' }, number(a.export, x => { a.export = x; }, `Export target of ${a.zone}`, -Infinity)),
      h('td', { 'data-label': 'Tolerance' }, number(a.tolerance, x => { a.tolerance = x; }, `Tolerance of ${a.zone}`, 0)),
      h('td', { 'data-label': 'Slack busbar' }, slack));
  });
  return h('div', {},
    h('p', { class: 'study-note', text: 'A zone exports the active power leaving it through branches to other zones. With area interchange on, the machines at a zone\'s slack busbar hold its export within the tolerance.' }),
    h('table', { class: 'events areas' }, h('thead', {}, h('tr', {}, h('th', { text: 'Zone' }), h('th', { text: 'Export target' }), h('th', { text: 'Tolerance' }), h('th', { text: 'Slack busbar' }))), h('tbody', {}, ...rows)));
}

/** @param {import('../app.js').App} app @param {{ events: import('../core/document.js').SimEvent[] }} rms */
function eventEditor(app, rms) {
  const doc = app.store.doc;
  const table = h('table', { class: 'events' });
  /** The elements each kind of event can act on, listed once for the dialog. @type {Map<string, Array<{ id: string, name: string }>>} */
  const lists = new Map();
  const targets = (/** @type {string} */ kind) => {
    const group = kind === 'fault' || kind === 'clear' ? 'bus' : kind === 'loadstep' ? 'load' : 'other';
    let list = lists.get(group);
    if (!list) {
      list = doc.elements.filter(e => (group === 'bus' ? e.cls === 'bus' : group === 'load' ? e.cls === 'load' : e.cls !== 'bus'))
        .map(e => ({ id: e.id, name: /** @type {string} */ (e.name) }));
      lists.set(group, list);
    }
    return list;
  };
  const render = () => {
    table.replaceChildren(h('thead', {}, h('tr', {}, h('th', { text: 'Time (s)' }), h('th', { text: 'Event' }), h('th', { text: 'Element' }), h('th', { text: 'Value' }), h('th'))));
    const body = h('tbody');
    rms.events.forEach((ev, i) => {
      const t = h('input', { class: 'input', value: String(ev.t), 'aria-label': 'Event time', style: 'width:80px;text-align:right' });
      t.addEventListener('change', () => { ev.t = parseNumber(t.value); t.classList.toggle('invalid', !(ev.t >= 0)); });
      const kind = h('select', { class: 'input', 'aria-label': 'Event type' }, ...EVENT_KINDS.map(k => h('option', { value: k, text: EVENT_LABEL[k] })));
      kind.value = ev.kind;
      kind.addEventListener('change', () => { ev.kind = /** @type {any} */ (kind.value); if (!targets(ev.kind).some(e => e.id === ev.target)) ev.target = targets(ev.kind)[0]?.id ?? ''; render(); });
      const choices = targets(ev.kind);
      /** @type {HTMLElement} */
      let target;
      if (choices.length > MANY_BUSES) {
        const picker = elementPicker(choices, ev.target, `event-${i}`, v => { ev.target = v; return ''; }, undefined, ev.kind === 'fault' || ev.kind === 'clear' ? 'busbar' : 'element');
        picker.input.setAttribute('aria-label', 'Event element');
        picker.input.addEventListener('change', () => { const msg = picker.apply(); picker.input.classList.toggle('invalid', !!msg); picker.input.title = msg; });
        target = picker.input;
      } else {
        const select = h('select', { class: 'input', 'aria-label': 'Event element' }, ...choices.map(e => h('option', { value: e.id, text: e.name || e.id })));
        select.value = ev.target;
        select.addEventListener('change', () => { ev.target = select.value; });
        target = select;
      }
      const value = h('input', { class: 'input', 'aria-label': 'Event value', style: 'width:72px;text-align:right', value: ev.kind === 'loadstep' ? String(ev.value ?? 100) : '', disabled: ev.kind !== 'loadstep' });
      value.addEventListener('change', () => { ev.value = parseNumber(value.value); });
      const del = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Remove event', html: icon('delete', 15), onclick: () => { rms.events.splice(i, 1); render(); } });
      body.append(h('tr', {}, h('td', {}, t), h('td', {}, kind), h('td', {}, target), h('td', {}, value), h('td', {}, del)));
    });
    table.append(body);
  };
  render();
  const add = h('button', { type: 'button', class: 'btn', style: 'margin-top:8px', html: `${icon('plus', 14)}<span>Add event</span>`,
    onclick: () => { const last = rms.events[rms.events.length - 1]; rms.events.push({ t: last ? +(last.t + 0.1).toFixed(3) : 0.1, kind: 'fault', target: targets('fault')[0]?.id ?? '' }); render(); } });
  return h('div', {}, table, add);
}
