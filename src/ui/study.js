/** The study case dialog: settings of every calculation and the event list of the stability simulation. */

import { h } from './dom.js';
import { icon } from './icons.js';
import { fieldRow, elementPicker, MANY_BUSES } from './fields.js';
import { modal } from './feedback.js';
import { STUDY_FIELDS, EVENT_KINDS, EMT_EVENT_KINDS, EMT_FAULTS } from '../core/document.js';
import { parseNumber } from './format.js';
import { enumLabel } from './fields.js';

const TITLES = /** @type {Record<string, string>} */ ({ loadflow: 'Load flow', shortcircuit: 'Short circuit', contingency: 'Contingency analysis', rms: 'Stability simulation', emt: 'EMT simulation' });
const EVENT_LABEL = /** @type {Record<string, string>} */ ({ fault: 'Three-phase fault at', clear: 'Clear fault at', trip: 'Switch out', close: 'Switch in', loadstep: 'Set load to (% of initial)' });
const EMT_EVENT_LABEL = /** @type {Record<string, string>} */ ({ fault: 'Fault at', clear: 'Clear fault at', trip: 'Trip', close: 'Close' });

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
    if (section === 'rms') body.append(h('h3', { text: 'Simulation events', id: 'study-rms-events' }), eventEditor(app, /** @type {any} */ (draft.rms)));
    if (section === 'emt') body.append(h('h3', { text: 'EMT events', id: 'study-emt-events' }), emtEventEditor(app, /** @type {any} */ (draft.emt)));
    if (section === 'contingency') {
      const { list, remedial } = doc.study.contingency;
      const own = `${list.length} contingenc${list.length === 1 ? 'y' : 'ies'} of your own and ${remedial.length} remedial action${remedial.length === 1 ? '' : 's'}`;
      body.append(h('p', { class: 'study-note', text: `${own}. Edit them from Calculate, Security, Contingencies.` }));
    }
  }
  const shown = modal({
    title: 'Study case', body, wide: true,
    actions: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, run: () => (Object.keys(errors).length ? null : true) }],
  });
  // The section a command opened the dialog for comes into view at the top.
  if (focusSection) requestAnimationFrame(() => document.getElementById(`study-${focusSection}`)?.scrollIntoView({ block: 'start' }));
  const ok = await shown;
  if (!ok) return;
  app.tryEdit('Study case', () => app.store.transact('Edit study case', tx => {
    for (const [section, fields] of Object.entries(STUDY_FIELDS)) for (const f of fields) tx.setStudy(section, f.key, draft[section][f.key]);
    const events = /** @type {any[]} */ (draft.rms.events).filter(e => Number.isFinite(e.t) && e.target).sort((a, b) => a.t - b.t);
    if (JSON.stringify(events) !== JSON.stringify(doc.study.rms.events)) tx.setStudy('rms', 'events', events);
    const emtEvents = /** @type {any[]} */ (draft.emt.events).filter(e => Number.isFinite(e.t) && e.t >= 0 && e.target).sort((a, b) => a.t - b.t);
    if (JSON.stringify(emtEvents) !== JSON.stringify(doc.study.emt.events)) tx.setStudy('emt', 'events', emtEvents);
    const areas = /** @type {import('../core/document.js').AreaTarget[]} */ (draft.loadflow.areas).filter(a => a.slack || a.export !== 0);
    if (JSON.stringify(areas) !== JSON.stringify(doc.study.loadflow.areas)) tx.setStudy('loadflow', 'areas', areas);
  }));
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
    table.replaceChildren(h('thead', {}, h('tr', {}, h('th', { text: 'Time (s)' }), h('th', { text: 'Event' }), h('th', { text: 'Element' }), h('th', { text: 'Value', title: 'A load step\u2019s level, or a fault\u2019s resistance and reactance in Ω (empty: a bolted fault)' }), h('th'))));
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
      /** @type {HTMLElement} */
      let value;
      if (ev.kind === 'fault') {
        // The fault's impedance, R + jX in ohms; empty is a bolted fault.
        const part = (/** @type {'r' | 'x'} */ k, /** @type {string} */ label) => {
          const input = h('input', { class: 'input', 'aria-label': label, placeholder: k === 'r' ? 'R Ω' : 'X Ω', style: 'width:56px;text-align:right', value: ev[k] === undefined ? '' : String(ev[k]) });
          input.addEventListener('change', () => {
            const x = input.value.trim() === '' ? undefined : parseNumber(input.value);
            const bad = x !== undefined && !(x >= 0);
            input.classList.toggle('invalid', bad);
            if (bad) return;
            if (x === undefined) delete ev[k]; else ev[k] = x;
          });
          return input;
        };
        value = h('span', { class: 'fault-z' }, part('r', 'Fault resistance'), part('x', 'Fault reactance'));
      } else {
        const input = h('input', { class: 'input', 'aria-label': 'Event value', style: 'width:72px;text-align:right', value: ev.kind === 'loadstep' ? String(ev.value ?? 100) : '', disabled: ev.kind !== 'loadstep' });
        input.addEventListener('change', () => { ev.value = parseNumber(input.value); });
        value = input;
      }
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

/**
 * The EMT simulation's events: faults of any kind through a resistance, their clearing, and breakers opened and
 * closed. Times are in milliseconds here and seconds in the document.
 * @param {import('../app.js').App} app @param {{ events: import('../core/document.js').EmtEvent[] }} emt
 */
function emtEventEditor(app, emt) {
  const doc = app.store.doc;
  const table = h('table', { class: 'events emt-events' });
  /** @type {Map<string, Array<{ id: string, name: string }>>} */
  const lists = new Map();
  const switchable = new Set(['line', 'trafo', 'gen', 'extgrid', 'load', 'shunt']);
  const targets = (/** @type {string} */ kind) => {
    const group = kind === 'fault' || kind === 'clear' ? 'bus' : 'other';
    let list = lists.get(group);
    if (!list) {
      list = doc.elements.filter(e => (group === 'bus' ? e.cls === 'bus' : switchable.has(e.cls))).map(e => ({ id: e.id, name: /** @type {string} */ (e.name) }));
      lists.set(group, list);
    }
    return list;
  };
  const ms = (/** @type {number} */ t) => String(+(t * 1000).toFixed(3));
  const render = () => {
    table.replaceChildren(h('thead', {}, h('tr', {}, h('th', { text: 'Time (ms)' }), h('th', { text: 'Event' }), h('th', { text: 'Element' }),
      h('th', { text: 'Fault', title: 'The phases a fault connects, and its resistance in each faulted path in Ω (empty: a bolted fault)' }), h('th'))));
    const body = h('tbody');
    emt.events.forEach((ev, i) => {
      const t = h('input', { class: 'input', value: ms(ev.t), 'aria-label': 'Event time in milliseconds', inputmode: 'decimal', style: 'width:80px;text-align:right' });
      t.addEventListener('change', () => { const v = parseNumber(t.value); ev.t = v / 1000; t.classList.toggle('invalid', !(v >= 0)); });
      const kind = h('select', { class: 'input', 'aria-label': 'Event type' }, ...EMT_EVENT_KINDS.map(k => h('option', { value: k, text: EMT_EVENT_LABEL[k] })));
      kind.value = ev.kind;
      kind.addEventListener('change', () => {
        ev.kind = /** @type {any} */ (kind.value);
        if (!targets(ev.kind).some(e => e.id === ev.target)) ev.target = targets(ev.kind)[0]?.id ?? '';
        if (ev.kind !== 'fault') { delete ev.fault; delete ev.r; } else ev.fault ??= '3ph';
        render();
      });
      const choices = targets(ev.kind);
      /** @type {HTMLElement} */
      let target;
      if (choices.length > MANY_BUSES) {
        const picker = elementPicker(choices, ev.target, `emt-event-${i}`, v => { ev.target = v; return ''; }, undefined, ev.kind === 'fault' || ev.kind === 'clear' ? 'busbar' : 'element');
        picker.input.setAttribute('aria-label', 'Event element');
        picker.input.addEventListener('change', () => { const msg = picker.apply(); picker.input.classList.toggle('invalid', !!msg); picker.input.title = msg; });
        target = picker.input;
      } else {
        const select = h('select', { class: 'input', 'aria-label': 'Event element' }, ...choices.map(e => h('option', { value: e.id, text: e.name || e.id })));
        select.value = ev.target;
        select.addEventListener('change', () => { ev.target = select.value; });
        target = select;
      }
      /** @type {HTMLElement} */
      let fault;
      if (ev.kind === 'fault') {
        const type = h('select', { class: 'input', 'aria-label': 'Fault type' }, ...EMT_FAULTS.map(f => h('option', { value: f, text: enumLabel('fault', f) })));
        type.value = ev.fault ?? '3ph';
        type.addEventListener('change', () => { ev.fault = /** @type {any} */ (type.value); });
        const r = h('input', { class: 'input', 'aria-label': 'Fault resistance in ohms', placeholder: 'R Ω', inputmode: 'decimal', style: 'width:64px;text-align:right', value: ev.r === undefined ? '' : String(ev.r) });
        r.addEventListener('change', () => {
          const x = r.value.trim() === '' ? undefined : parseNumber(r.value);
          const bad = x !== undefined && !(x >= 0);
          r.classList.toggle('invalid', bad);
          if (bad) return;
          if (x === undefined) delete ev.r; else ev.r = x;
        });
        fault = h('span', { class: 'fault-z' }, type, r);
      } else fault = h('span', { class: 'muted', text: '—', 'aria-label': 'No fault' });
      const del = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Remove event', html: icon('delete', 15), onclick: () => { emt.events.splice(i, 1); render(); } });
      body.append(h('tr', {}, h('td', {}, t), h('td', {}, kind), h('td', {}, target), h('td', {}, fault), h('td', {}, del)));
    });
    table.append(body);
  };
  render();
  const add = h('button', { type: 'button', class: 'btn', style: 'margin-top:8px', html: `${icon('plus', 14)}<span>Add EMT event</span>`,
    onclick: () => {
      const last = emt.events[emt.events.length - 1];
      emt.events.push(last ? { t: +(last.t + 0.05).toFixed(4), kind: 'clear', target: last.kind === 'fault' || last.kind === 'clear' ? last.target : targets('clear')[0]?.id ?? '' }
        : { t: 0.02, kind: 'fault', target: targets('fault')[0]?.id ?? '', fault: '3ph' });
      render();
    } });
  return h('div', {},
    h('p', { class: 'study-note', text: 'A trip opens each breaker pole at its next current zero, as an arc goes out, and a cleared fault goes out phase by phase the same way. A close switches all three poles at once, so its time sets the point on the wave. Lines, transformers, loads and shunts out of service can be closed in.' }),
    table, add);
}
