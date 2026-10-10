/** The Project page of the File view: study cases, scenarios and variants, where edits go, and the run log.
 *
 * Every change goes through `app.projectChanged` with the parts it touched, so it is saved, and the editor recomposes
 * when the active study case's composition changed. The page renders itself again after each change. */

import { h } from './dom.js';
import { icon } from './icons.js';
import { confirm } from './feedback.js';
import { activeCase, newPartId } from '../core/project.js';

/** @typedef {import('../core/project.js').Project} Project @typedef {import('../core/project.js').Part} Part */

/** @param {import('../app.js').App} app @returns {Promise<HTMLElement[]>} */
export async function projectPage(app) {
  const root = h('div', { class: 'project-page' });
  const runs = await app.library.runs(app.docId);
  /** Applies a change, then shows the page again. @param {Part[]} parts @param {boolean} recompose */
  const changed = async (parts, recompose) => {
    await app.projectChanged(parts, recompose);
    await draw();
  };
  const draw = async () => {
    const p = app.project, c = activeCase(p);
    root.replaceChildren(
      h('h1', { text: 'Project' }),
      h('p', { class: 'lead', text: 'One network studied under several conditions. A study case chooses a scenario (an operating point) and the variants (planned changes) to apply, with its own calculation settings. Each edit is kept in the part it belongs to.' }),
      section('Study cases', 'layers', 'New study case', 'Copies the active case: its scenario, variants and settings.', () => {
        const id = newPartId('case', p.cases.map(x => x.id));
        p.cases.push({ ...structuredClone(c), id, name: uniqueName('Study case', p.cases.map(x => x.name)) });
        void changed(['manifest'], false);
      }, p.cases.map(sc => caseCard(app, sc, changed))),
      section('Scenarios', 'power', 'New scenario', 'An operating point: switching, setpoints, loads, generation and taps.', () => {
        const id = newPartId('scenario', p.scenarios.map(x => x.id));
        p.scenarios.push({ id, name: uniqueName('Scenario', p.scenarios.map(x => x.name)), description: '', values: {} });
        void changed(['manifest', `scenario:${id}`], false);
      }, p.scenarios.length ? p.scenarios.map(s => partRow(app, s.name, `${countValues(s.values)} value${countValues(s.values) === 1 ? '' : 's'} set`,
        name => { s.name = name; void changed(['manifest'], false); },
        async () => {
          if (!(await confirm('Delete scenario', `Delete “${s.name}”? Study cases that use it go back to the base values.`, 'Delete'))) return;
          p.scenarios = p.scenarios.filter(x => x !== s);
          const affected = c.scenario === s.id;
          for (const sc of p.cases) if (sc.scenario === s.id) sc.scenario = '';
          await changed(['manifest', `scenario:${s.id}`], affected);
        })) : [empty('No scenarios. Without one, a study case uses the values in the base model.')]),
      section('Variants', 'duplicate', 'New variant', 'Joins the active study case and records your changes to the equipment.', () => {
        const id = newPartId('variant', p.variants.map(x => x.id));
        p.variants.push({ id, name: uniqueName('Variant', p.variants.map(x => x.name)), description: '', inService: '', ops: [] });
        c.variants.push(id);
        app.setRecording(id);
        void changed(['manifest', `variant:${id}`], false);
      }, p.variants.length ? p.variants.map(v => partRow(app, v.name, `${v.ops.length} change${v.ops.length === 1 ? '' : 's'}`,
        name => { v.name = name; void changed(['manifest'], false); },
        async () => {
          if (!(await confirm('Delete variant', `Delete “${v.name}” and the ${v.ops.length} change${v.ops.length === 1 ? '' : 's'} it holds?`, 'Delete'))) return;
          p.variants = p.variants.filter(x => x !== v);
          const affected = c.variants.includes(v.id);
          for (const sc of p.cases) sc.variants = sc.variants.filter(x => x !== v.id);
          await changed(['manifest', `variant:${v.id}`], affected);
        }, v)) : [empty('No variants. A variant holds planned changes to the equipment, such as a new line, kept apart from the network as built.')]),
      recordingPanel(app, draw),
      runLog(runs));
  };
  await draw();
  return [root];
}

/**
 * A section: its heading with an add button, a hint, and its rows.
 * @param {string} title @param {string} ic @param {string} add @param {string} hint @param {() => void} onAdd @param {HTMLElement[]} rows
 */
function section(title, ic, add, hint, onAdd, rows) {
  return h('section', { class: 'project-section' },
    h('div', { class: 'project-head' }, h('h2', { html: `${icon(ic, 17)}<span>${title}</span>` }),
      h('button', { type: 'button', class: 'btn', title: hint, html: `${icon('plus', 14)}<span>${add}</span>`, onclick: onAdd })),
    h('div', { class: 'project-rows' }, ...rows));
}

/** @param {string} text */
const empty = text => h('p', { class: 'project-empty', text });

/**
 * A study case: whether it is active, its name, its scenario and its variants.
 * @param {import('../app.js').App} app @param {import('../core/project.js').StudyCase} sc
 * @param {(parts: Part[], recompose: boolean) => Promise<void>} changed
 */
function caseCard(app, sc, changed) {
  const p = app.project, active = sc.id === p.activeCase;
  const radio = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'active-case', class: 'check', 'aria-label': `Make ${sc.name} the active study case` }));
  radio.checked = active;
  radio.addEventListener('change', async () => { await app.switchCase(sc.id); await changed([], false); });
  const scenario = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', 'aria-label': `Scenario of ${sc.name}` },
    h('option', { value: '', text: 'Base values' }), ...p.scenarios.map(s => h('option', { value: s.id, text: s.name }))));
  scenario.value = sc.scenario;
  scenario.addEventListener('change', () => { sc.scenario = scenario.value; void changed(['manifest'], active); });
  const variants = h('div', { class: 'case-variants' }, ...(p.variants.length ? p.variants.map(v => {
    const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', class: 'check' }));
    box.checked = sc.variants.includes(v.id);
    box.addEventListener('change', () => {
      // Variants apply in project order, whatever order they were ticked in.
      sc.variants = p.variants.filter(x => (x.id === v.id ? box.checked : sc.variants.includes(x.id))).map(x => x.id);
      void changed(['manifest'], active);
    });
    return h('label', { class: 'case-variant' }, box, h('span', { text: v.name }));
  }) : [h('span', { class: 'project-muted', text: 'No variants' })]));
  const del = h('button', { type: 'button', class: 'icon-btn sm', title: 'Delete study case', 'aria-label': `Delete ${sc.name}`, html: icon('delete', 15), disabled: p.cases.length < 2,
    onclick: async () => {
      if (!(await confirm('Delete study case', `Delete “${sc.name}”? Its scenario and variants stay in the project.`, 'Delete'))) return;
      p.cases = p.cases.filter(x => x !== sc);
      if (active) await app.switchCase(p.cases[0].id);
      await changed(['manifest'], false);
    } });
  return h('div', { class: `case-card${active ? ' active' : ''}` },
    h('div', { class: 'case-top' }, radio, nameField(sc.name, `Name of study case ${sc.name}`, name => { sc.name = name; void changed(['manifest'], false); }),
      active ? h('span', { class: 'pill ok', text: 'Active' }) : null, h('span', { class: 'grow' }), del),
    h('div', { class: 'case-grid' }, h('span', { class: 'label', text: 'Scenario' }), scenario, h('span', { class: 'label', text: 'Variants' }), variants));
}

/**
 * A scenario or variant: name, size, and for a variant its in-service date.
 * @param {import('../app.js').App} app @param {string} name @param {string} size @param {(name: string) => void} rename
 * @param {() => void} remove @param {import('../core/project.js').Variant} [variant]
 */
function partRow(app, name, size, rename, remove, variant) {
  const date = variant ? /** @type {HTMLInputElement} */ (h('input', { type: 'date', class: 'input', value: variant.inService, 'aria-label': `In service from (${name})`, title: 'Planned in-service date' })) : null;
  date?.addEventListener('change', () => { if (variant) { variant.inService = date.value; void app.projectChanged(['manifest'], false); } });
  return h('div', { class: 'part-row' }, nameField(name, `Name of ${name}`, rename), h('span', { class: 'project-muted', text: size }),
    date ? h('label', { class: 'part-date' }, h('span', { class: 'label', text: 'In service' }), date) : h('span'),
    h('button', { type: 'button', class: 'icon-btn sm', title: 'Delete', 'aria-label': `Delete ${name}`, html: icon('delete', 15), onclick: remove }));
}

/** A name edited in place. @param {string} value @param {string} label @param {(name: string) => void} set */
function nameField(value, label, set) {
  const input = /** @type {HTMLInputElement} */ (h('input', { class: 'input name-field', value, 'aria-label': label, spellcheck: 'false' }));
  input.addEventListener('change', () => { const v = input.value.trim(); if (v && v !== value) set(v); else input.value = value; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = value; input.blur(); } });
  return input;
}

/** Where edits to the equipment go: the base or one of the active case's variants. @param {import('../app.js').App} app @param {() => Promise<void>} draw */
function recordingPanel(app, draw) {
  const p = app.project, c = activeCase(p);
  const options = p.variants.filter(v => c.variants.includes(v.id));
  const select = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', 'aria-label': 'Where changes to the equipment go', disabled: !options.length },
    h('option', { value: '', text: 'The base model (the network as built)' }), ...options.map(v => h('option', { value: v.id, text: `Variant: ${v.name}` }))));
  select.value = p.recording;
  select.addEventListener('change', () => { app.setRecording(select.value); void draw(); });
  return h('section', { class: 'project-section' },
    h('div', { class: 'project-head' }, h('h2', { html: `${icon('record', 17)}<span>Where changes go</span>` })),
    h('div', { class: 'recording-panel' }, select,
      h('p', { class: 'project-muted', text: options.length
        ? 'Changes to the equipment go here. Operating values go to the active case’s scenario when it has one, settings to the study case, and moves on the diagram to wherever the element is kept.'
        : 'Changes go to the base model. Add a variant to the active study case to record planned changes apart from it.' })));
}

/** The run log, newest first. @param {import('./persistence.js').RunRecord[]} runs */
function runLog(runs) {
  const head = h('div', { class: 'project-head' }, h('h2', { html: `${icon('history', 17)}<span>Run log</span>` }));
  if (!runs.length) return h('section', { class: 'project-section' }, head, empty('No runs yet. Every calculation you start is recorded here with the hashes of its inputs and results, so it can be reproduced.'));
  const short = (/** @type {string} */ x) => (x ? x.slice(0, 10) : '—');
  const table = h('table', { class: 'grid runs' },
    h('thead', {}, h('tr', {}, ...['Time', 'Calculation', 'Study case', 'Outcome', 'Model', 'Results', 'Duration'].map(t => h('th', { text: t })))),
    h('tbody', {}, ...[...runs].reverse().map(r => h('tr', {},
      h('td', { text: new Date(r.time).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) }),
      h('td', { text: KIND[r.kind] ?? r.kind }),
      h('td', { text: [r.studyCase, r.scenario, ...r.variants].filter(Boolean).join(' · '), title: `Scenario: ${r.scenario || 'base values'}; variants: ${r.variants.join(', ') || 'none'}` }),
      h('td', { text: outcome(r) }),
      h('td', { class: 'mono', text: short(r.inputs.modelSha256), title: r.inputs.modelSha256 }),
      h('td', { class: 'mono', text: short(r.resultsSha256), title: r.resultsSha256 }),
      h('td', { class: 'num', text: `${(r.durationMs / 1000).toFixed(2)} s` })))));
  return h('section', { class: 'project-section' }, head, h('div', { class: 'runs-wrap' }, table));
}

const KIND = /** @type {Record<string, string>} */ ({ loadflow: 'Load flow', shortcircuit: 'Short circuit', contingency: 'Contingency', rms: 'Stability' });

/** A run's outcome in a few words. @param {import('./persistence.js').RunRecord} r */
function outcome(r) {
  const o = /** @type {Record<string, any>} */ (r.outcome);
  if (r.kind === 'loadflow') return o.converged ? `Converged in ${o.iterations}` : 'Did not converge';
  if (r.kind === 'contingency') return `${o.cases} outages, ${o.violating} violating, ${o.unsolvable} unsolvable`;
  if (r.kind === 'shortcircuit') return `${o.buses} busbars, up to ${Number(o.maxIkssKa).toFixed(1)} kA`;
  return o.stable ? 'Stable' : 'Loses synchronism';
}

/** @param {Record<string, Record<string, unknown>>} values */
const countValues = values => Object.values(values).reduce((n, f) => n + Object.keys(f).length, 0);

/** The first of "Name 1", "Name 2", … not taken. @param {string} stem @param {string[]} taken */
function uniqueName(stem, taken) {
  let n = taken.length + 1;
  while (taken.includes(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}
