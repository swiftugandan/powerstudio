/** The study report: the active study case's results laid out for print (and the browser's save as PDF).
 *
 * A cover with the network, the study case, its scenario and variants, and the run record of each calculation (the
 * engine and the hashes that let the run be reproduced); then, for each calculation that has results, its key figures,
 * the rows that matter (violations first), and the settings it ran with; and the diagram with the results on it when
 * the network is small enough to print. The report is built into its own root, which print shows alone, and always
 * in the light palette. */

import { h } from './dom.js';
import { fixed, duration } from './format.js';
import { enumLabel } from './fields.js';
import { activeCase } from '../core/project.js';
import { STUDY_FIELDS } from '../core/document.js';
import { CLASSES } from '../core/catalog.js';
import { buildScene } from '../render/scene.js';
import { toSVG } from '../render/svg.js';
import { buildOverlay } from './overlay.js';
import { readPalette } from './theme.js';
import { engineDigest } from '../engine/module.js';
import { APP_VERSION } from '../core/version.js';

/** @typedef {import('../engine/reports.js').CalcKind} CalcKind */

/** Elements up to which the diagram is printed; beyond, it would not be legible on a page. */
const DIAGRAM_UP_TO = 4000;
/** Rows a table prints before it says how many more there are. */
const ROWS = 40;
const TITLE = /** @type {Record<CalcKind, string>} */ ({ loadflow: 'Load flow', shortcircuit: 'Short circuit', contingency: 'Contingency analysis', rms: 'Stability simulation' });

/** Builds the report for the open project and prints it. @param {import('../app.js').App} app */
export async function printReport(app) {
  const root = await buildReport(app);
  const host = /** @type {HTMLElement} */ (document.getElementById('print-root'));
  host.replaceChildren(root);
  const done = () => { host.replaceChildren(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/** The report's content. @param {import('../app.js').App} app @returns {Promise<HTMLElement>} */
export async function buildReport(app) {
  const doc = app.store.doc, p = app.project, c = activeCase(p);
  const scenario = p.scenarios.find(s => s.id === c.scenario);
  const variants = p.variants.filter(v => c.variants.includes(v.id));
  const runs = new Map((await app.library.runs(app.docId)).map(r => [r.run, r]));
  const kinds = /** @type {CalcKind[]} */ (['loadflow', 'contingency', 'shortcircuit', 'rms']).filter(k => app.results[k]);
  const counts = new Map();
  for (const el of doc.elements) counts.set(el.cls, (counts.get(el.cls) ?? 0) + 1);
  const name = (/** @type {string} */ id) => app.store.get(id)?.name || id;

  const cover = h('section', { class: 'report-cover' },
    h('p', { class: 'report-kicker', text: 'Study report' }),
    h('h1', { text: doc.name }),
    doc.description ? h('p', { class: 'report-lead', text: doc.description }) : null,
    facts([
      ['Study case', c.name],
      ['Scenario', scenario ? scenario.name : 'Base values (no scenario)'],
      ['Variants', variants.length ? variants.map(v => `${v.name}${v.inService ? ` (in service ${v.inService})` : ''}`).join(', ') : 'None'],
      ['Network', [...counts].map(([cls, n]) => `${n.toLocaleString('en-GB')} ${(n === 1 ? CLASSES[/** @type {import('../core/catalog.js').ElementClass} */ (cls)].label : CLASSES[/** @type {import('../core/catalog.js').ElementClass} */ (cls)].plural).toLowerCase()}`).join(', ')],
      ['Base power, frequency', `${doc.baseMVA} MVA, ${doc.frequency} Hz`],
      ['Printed', new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })],
      ['PowerStudio', `${APP_VERSION}, engine SHA-256 ${(await engineDigest()).slice(0, 16) || 'unavailable'}`],
    ]),
    h('h2', { text: 'Run records' }),
    kinds.length ? table(['Calculation', 'Run', 'Model', 'Settings', 'Results', 'Outcome'], kinds.map(k => {
      const stored = /** @type {import('../app.js').StoredResult} */ (app.results[k]);
      const rec = stored.run ? runs.get(stored.run) : undefined;
      if (!rec) return [TITLE[k], 'Not recorded: calculated on edit', '', '', '', ''];
      return [TITLE[k], new Date(rec.time).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' }), short(rec.inputs.modelSha256), short(rec.inputs.studySha256), short(rec.resultsSha256), outcome(rec)];
    }), 'report-records') : h('p', { text: 'No calculation has results yet.' }),
    h('p', { class: 'report-note', text: 'Hashes are SHA-256 (first 16 digits): of the model as calculated, of the study case settings and of the results without their timings. The same engine on the same inputs gives the same results hash. The full record is in the project’s run log.' }));

  const sections = kinds.map(k => {
    const stored = /** @type {import('../app.js').StoredResult} */ (app.results[k]);
    const stale = app.resultsStale(k);
    const body = k === 'loadflow' ? loadflow(stored.result, name, app) : k === 'contingency' ? contingency(stored.result, name)
      : k === 'shortcircuit' ? shortcircuit(stored.result, name) : rms(stored.result);
    return h('section', { class: 'report-section' },
      h('h2', { text: TITLE[k] }),
      stale ? h('p', { class: 'report-warn', text: 'Calculated before the last edit: these results may not describe the network as it is now.' }) : null,
      h('p', { class: 'report-time', text: `Calculated in ${duration(stored.ms)}.` }),
      ...body,
      h('h3', { text: 'Settings' }),
      settings(k, doc.study));
  });

  return h('article', { class: 'report' }, cover, ...sections, diagram(app),
    h('footer', { class: 'report-footer', text: `PowerStudio ${APP_VERSION}. Short-circuit currents follow the method of IEC 60909-0 and are not certified against the standard; check results that matter with a validated tool.` }));
}

/** A two-column list of facts. @param {Array<[string, string]>} rows */
function facts(rows) {
  return h('dl', { class: 'report-facts' }, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
}

/** A table, with a line for the rows left out. @param {string[]} head @param {string[][]} rows @param {string} [cls]
 * @param {number} [total] rows there are in all */
function table(head, rows, cls = '', total = rows.length) {
  const t = h('table', { class: `report-table ${cls}` },
    h('thead', {}, h('tr', {}, ...head.map((x, i) => h('th', { class: i ? 'num' : '', text: x })))),
    h('tbody', {}, ...rows.map(r => h('tr', {}, ...r.map((x, i) => h('td', { class: i && /^[-+\u2212]?[\d.,]/.test(x) ? 'num' : '', text: x }))))));
  return total > rows.length ? h('div', {}, t, h('p', { class: 'report-note', text: `${(total - rows.length).toLocaleString('en-GB')} more not printed; the results tables in the app list them all and export them as CSV.` })) : t;
}

/** @param {string} x */
const short = x => (x ? x.slice(0, 16) : '—');

/** @param {import('./persistence.js').RunRecord} r */
function outcome(r) {
  const o = /** @type {Record<string, any>} */ (r.outcome);
  if (r.kind === 'loadflow') return o.converged ? `Converged in ${o.iterations}` : 'Did not converge';
  if (r.kind === 'contingency') return `${o.violating} violating, ${o.unsolvable} unsolvable`;
  if (r.kind === 'shortcircuit') return `Up to ${Number(o.maxIkssKa).toFixed(1)} kA`;
  return o.stable ? 'Stable' : 'Loses synchronism';
}

/** @param {import('../engine/reports.js').LoadFlowResult} r @param {(id: string) => string} name @param {import('../app.js').App} app */
function loadflow(r, name, app) {
  const band = (/** @type {string} */ id) => app.store.get(id);
  const outside = r.buses.filter(b => { const e = band(b.id); return e && (b.vm < /** @type {number} */ (e.vmin) || b.vm > /** @type {number} */ (e.vmax)); });
  const loaded = [...r.branches].filter(b => Number.isFinite(b.loading)).sort((a, b) => b.loading - a.loading);
  const heavy = loaded.filter(b => b.loading >= 90);
  return [
    facts([
      ['Result', r.converged ? `Converged in ${r.iterations} iteration${r.iterations === 1 ? '' : 's'}` : `Did not converge: ${r.message}`],
      ['Generation, load, losses', `${fixed(r.totals.generation, 2)} MW, ${fixed(r.totals.load, 2)} MW, ${fixed(r.totals.losses, 3)} MW`],
      ['Busbars outside their voltage band', String(outside.length)],
      ['Branches loaded above 90 %', String(heavy.length)],
    ]),
    h('h3', { text: outside.length ? 'Busbars outside their voltage band' : 'Lowest and highest voltages' }),
    table(['Busbar', 'u (p.u.)', 'U (kV)', 'Angle (°)'],
      (outside.length ? outside : [...r.buses].sort((a, b) => a.vm - b.vm).filter((_, i, a) => i < 5 || i >= a.length - 5)).slice(0, ROWS)
        .map(b => [name(b.id), fixed(b.vm, 4), fixed(b.kv, 2), fixed(b.va, 2)]), '', outside.length || Math.min(10, r.buses.length)),
    h('h3', { text: 'Most loaded branches' }),
    table(['Branch', 'Loading (%)', 'P from (MW)', 'Q from (Mvar)'], loaded.slice(0, Math.max(10, Math.min(ROWS, heavy.length)))
      .map(b => [name(b.id), fixed(b.loading, 1), fixed(b.pFrom, 2), fixed(b.qFrom, 2)])),
    ...(r.warnings.length ? [h('h3', { text: 'Warnings' }), h('ul', { class: 'report-list' }, ...r.warnings.slice(0, ROWS).map(w => h('li', { text: w })))] : []),
  ];
}

/** @param {import('../engine/reports.js').ContingencyResult} r @param {(id: string) => string} name */
function contingency(r, name) {
  const bad = r.cases.filter(c => !c.converged || c.violations.some(v => !v.inBase));
  const worst = Object.entries(r.worstLoading).sort((a, b) => b[1].value - a[1].value);
  return [
    facts([
      ['Contingencies', r.cases.length.toLocaleString('en-GB')],
      ['With new violations', String(r.cases.filter(c => c.converged && c.violations.some(v => !v.inBase)).length)],
      ['Not solvable', String(r.cases.filter(c => !c.converged).length)],
      ['Loading limit', `${r.limit} %`],
    ]),
    h('h3', { text: bad.length ? 'Contingencies with new violations or no solution' : 'Secure under every contingency' }),
    ...(bad.length ? [table(['Contingency', 'Result', 'Max loading (%)', 'Violations'], bad.slice(0, ROWS).map(c => [
      name(c.id), c.converged ? `${c.violations.length} violation${c.violations.length === 1 ? '' : 's'}` : 'Not solvable', fixed(c.maxLoading, 1),
      c.violations.slice(0, 4).map(v => (v.kind === 'loading' ? `${name(v.id)} ${fixed(v.value, 0)} %` : `${name(v.id)} ${fixed(v.value, 3)} p.u.`)).join(', '),
    ]), '', bad.length)] : []),
    h('h3', { text: 'Worst post-contingency loading' }),
    table(['Branch', 'Worst loading (%)', 'Under the outage of'], worst.slice(0, 20).map(([id, w]) => [name(id), fixed(w.value, 1), name(w.outage)]), '', worst.length),
  ];
}

/** @param {import('../engine/reports.js').ShortCircuitResult} r @param {(id: string) => string} name */
function shortcircuit(r, name) {
  const top = [...r.buses].sort((a, b) => b.ikss - a.ikss);
  return [
    facts([
      ['Fault', `${enumLabel('fault', r.fault)}, ${r.mode === 'max' ? 'maximum' : 'minimum'} currents, κ method ${r.kappaMethod}`],
      ['Location', r.location ? name(r.location) : `Every busbar (${r.buses.length})`],
    ]),
    h('h3', { text: 'Highest initial short-circuit currents' }),
    r.fault === '3ph' && r.mode === 'max'
      ? table(['Busbar', 'Ik″ (kA)', 'ip (kA)', `Ib at ${fixed(r.tMin, 2)} s (kA)`, 'Sk″ (MVA)'],
        top.slice(0, ROWS).map(b => [name(b.id), fixed(b.ikss, 3), fixed(b.ip, 3), fixed(b.ib, 3), fixed(b.skss, 1)]), '', top.length)
      : table(['Busbar', 'Ik″ (kA)', 'ip (kA)', 'Sk″ (MVA)'], top.slice(0, ROWS).map(b => [name(b.id), fixed(b.ikss, 3), fixed(b.ip, 3), fixed(b.skss, 1)]), '', top.length),
  ];
}

/** @param {import('../engine/reports.js').RmsResult} r */
function rms(r) {
  return [
    facts([['Result', r.message], ['Steps', String(r.steps)], ['Angles against', r.angleReference === 'grid' ? 'the external grid' : 'the centre of inertia']]),
    h('h3', { text: 'Events' }),
    table(['Time (s)', 'Event'], r.events.map(e => [fixed(e.t, 3), e.note])),
  ];
}

/** The settings a calculation ran with, as the study case dialog lists them. @param {CalcKind} k
 * @param {import('../core/document.js').Study} study */
function settings(k, study) {
  const values = /** @type {Record<string, unknown>} */ (study[k]);
  return facts(STUDY_FIELDS[k].map(f => {
    const v = values[f.key];
    const text = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : f.type === 'enum' ? enumLabel(f.key, String(v)) : `${v}${f.unit ? ` ${f.unit}` : ''}`;
    return /** @type {[string, string]} */ ([f.label, text]);
  }));
}

/** The diagram with the results shown on it, in the light palette, when the network is small enough to print.
 * @param {import('../app.js').App} app */
function diagram(app) {
  const doc = app.store.doc;
  if (doc.elements.length > DIAGRAM_UP_TO) {
    return h('section', { class: 'report-section' }, h('h2', { text: 'Diagram' }),
      h('p', { text: `A diagram of ${doc.elements.length.toLocaleString('en-GB')} elements is not legible on a page and is left out. Export it from the app as PNG or SVG.` }));
  }
  const P = lightPalette();
  const kind = app.overlayKind;
  const stored = kind === 'none' ? undefined : app.results[kind];
  const overlay = stored && kind !== 'none' ? buildOverlay(kind, stored.result, doc, P, { colouring: app.prefs.colouring, rmsIndex: app.rmsIndex }).overlay : null;
  const list = buildScene({ elements: doc.elements, palette: P, selection: new Set(), hover: '', overlay, preview: null, labels: { names: true, branchNames: false, boxes: true } });
  const svg = toSVG(list, app.viewport.extent(), P.bg, doc.name);
  return h('section', { class: 'report-section report-diagram' }, h('h2', { text: stored ? `Diagram with the ${TITLE[/** @type {CalcKind} */ (kind)].toLowerCase()} results` : 'Diagram' }),
    h('div', { class: 'report-svg', html: svg }));
}

/** The diagram's palette in the light theme, whichever theme the app shows: read with the theme switched for one
 * synchronous style read, so nothing repaints. */
function lightPalette() {
  const root = document.documentElement, was = root.dataset.theme;
  root.dataset.theme = 'light';
  const P = readPalette();
  if (was === undefined) delete root.dataset.theme; else root.dataset.theme = was;
  return P;
}
