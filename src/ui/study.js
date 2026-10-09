/** The study case dialog: settings of every calculation and the event list of the stability simulation. */

import { h } from './dom.js';
import { icon } from './icons.js';
import { fieldRow } from './fields.js';
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
        const sel = h('select', { class: 'input', id: 'study-location', 'data-key': 'location' }, h('option', { value: '', text: 'Every busbar' }),
          ...doc.elements.filter(e => e.cls === 'bus').map(b => h('option', { value: b.id, text: b.name || b.id })));
        sel.value = String(draft.shortcircuit.location);
        sel.addEventListener('change', () => { draft.shortcircuit.location = sel.value; });
        props.append(h('label', { for: 'study-location', text: f.label, title: f.help }), h('div', { class: 'field' }, sel));
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
  }));
  if (focusSection) document.getElementById(`study-${focusSection}`)?.scrollIntoView();
}

/** @param {import('../app.js').App} app @param {{ events: import('../core/document.js').SimEvent[] }} rms */
function eventEditor(app, rms) {
  const doc = app.store.doc;
  const table = h('table', { class: 'events' });
  const targets = (/** @type {string} */ kind) => doc.elements.filter(e => (kind === 'fault' || kind === 'clear' ? e.cls === 'bus' : kind === 'loadstep' ? e.cls === 'load' : e.cls !== 'bus'));
  const render = () => {
    table.replaceChildren(h('thead', {}, h('tr', {}, h('th', { text: 'Time (s)' }), h('th', { text: 'Event' }), h('th', { text: 'Element' }), h('th', { text: 'Value' }), h('th'))));
    const body = h('tbody');
    rms.events.forEach((ev, i) => {
      const t = h('input', { class: 'input', value: String(ev.t), 'aria-label': 'Event time', style: 'width:80px;text-align:right' });
      t.addEventListener('change', () => { ev.t = parseNumber(t.value); t.classList.toggle('invalid', !(ev.t >= 0)); });
      const kind = h('select', { class: 'input', 'aria-label': 'Event type' }, ...EVENT_KINDS.map(k => h('option', { value: k, text: EVENT_LABEL[k] })));
      kind.value = ev.kind;
      kind.addEventListener('change', () => { ev.kind = /** @type {any} */ (kind.value); if (!targets(ev.kind).some(e => e.id === ev.target)) ev.target = targets(ev.kind)[0]?.id ?? ''; render(); });
      const target = h('select', { class: 'input', 'aria-label': 'Event element' }, ...targets(ev.kind).map(e => h('option', { value: e.id, text: e.name || e.id })));
      target.value = ev.target;
      target.addEventListener('change', () => { ev.target = target.value; });
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
