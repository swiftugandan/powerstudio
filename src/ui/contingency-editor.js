/** The contingency dialog: the study case's own contingencies (elements that fail together) and its remedial
 * actions, with import and export of the contingency file (src/core/contingencies.js). */

import { h, download, fileName } from './dom.js';
import { icon } from './icons.js';
import { modal, toast } from './feedback.js';
import { parseNumber } from './format.js';
import { ACTION_CLASSES, BRANCH_CLASSES, OUTAGE_CLASSES, contingencyFile, readContingencyFile } from '../core/contingencies.js';

/**
 * @typedef {import('../core/contingencies.js').Contingency} Contingency
 * @typedef {import('../core/contingencies.js').RemedialAction} RemedialAction
 * @typedef {import('../core/contingencies.js').Condition} Condition
 * @typedef {import('../core/contingencies.js').Action} Action
 * @typedef {import('../core/catalog.js').Element} Element
 */

const CONDITIONS = /** @type {Array<[Condition['kind'], string, string]>} */ ([
  ['loading', 'Loading of', '%'], ['voltageBelow', 'Voltage below at', 'p.u.'], ['voltageAbove', 'Voltage above at', 'p.u.'], ['outage', 'Outage takes out', ''],
]);
/** Action choices: switching in and out are one kind in the file, two choices here. */
const ACTIONS = /** @type {Array<[string, string, string]>} */ ([
  ['out', 'Take out of service', ''], ['in', 'Put in service', ''], ['generation', 'Set generation of', 'MW'], ['tap', 'Set tap position of', ''], ['loadShed', 'Shed load', '%'],
]);

/** @param {import('../app.js').App} app */
export async function openContingencyDialog(app) {
  const doc = app.store.doc;
  const cls = new Map(doc.elements.map(e => [e.id, e.cls]));
  const byId = new Map(doc.elements.map(e => [e.id, e]));
  const draft = { list: structuredClone(doc.study.contingency.list), remedial: structuredClone(doc.study.contingency.remedial) };
  const label = (/** @type {string} */ id) => byId.get(id)?.name || id;
  const body = h('div', { class: 'cont-editor' });

  // One datalist per set of classes, filled when an input first needs it (a large network has many thousands).
  /** @type {Map<string, HTMLDataListElement>} */
  const lists = new Map();
  const listFor = (/** @type {readonly string[]} */ classes) => {
    const key = classes.join(',');
    let dl = lists.get(key);
    if (!dl) {
      dl = /** @type {HTMLDataListElement} */ (h('datalist', { id: `cont-list-${lists.size}` }));
      const items = doc.elements.filter(e => classes.includes(e.cls));
      dl.append(...items.map(e => h('option', { value: e.id, label: e.name && e.name !== e.id ? e.name : undefined })));
      lists.set(key, dl);
      body.append(dl);
    }
    return dl.id;
  };
  /** An element picker: type an identifier or a name, or pick from the list. It shows the element's name; calls `set`
   * with the identifier, or marks the input invalid.
   * A required picker without an element is marked when Apply finds it empty.
   * @param {readonly string[]} classes @param {string} value @param {(id: string) => void} set @param {string} aria @param {boolean} [required] */
  const picker = (classes, value, set, aria, required = true) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { class: 'input', value: value ? label(value) : '', placeholder: placeholderOf(classes), 'aria-label': aria, autocomplete: 'off', spellcheck: 'false',
      'data-required': required ? '' : undefined, 'data-id': value || undefined }));
    input.addEventListener('focus', () => { if (!input.getAttribute('list')) input.setAttribute('list', listFor(classes)); }, { once: true });
    input.title = value;
    input.addEventListener('change', () => {
      const text = input.value.trim();
      let id = classes.includes(cls.get(text) ?? '') ? text : '';
      if (!id) {
        const named = doc.elements.filter(e => classes.includes(e.cls) && e.name === text);
        if (named.length === 1) id = named[0].id;
      }
      input.classList.toggle('invalid', !id);
      input.title = id || 'No element of the right kind has this identifier or name.';
      if (id) { input.value = label(id); input.dataset.id = id; set(id); }
      else delete input.dataset.id;
    });
    return input;
  };
  const numberInput = (/** @type {number} */ value, /** @type {string} */ unit, /** @type {(v: number) => void} */ set, /** @type {string} */ aria, integer = false) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { class: `input${unit ? ' has-unit' : ''}`, value: String(value), 'aria-label': aria, inputmode: 'decimal' }));
    input.addEventListener('change', () => {
      const v = parseNumber(input.value);
      const ok = Number.isFinite(v) && (!integer || Number.isInteger(v));
      input.classList.toggle('invalid', !ok);
      if (ok) set(v);
    });
    return h('div', { class: 'field' }, input, unit ? h('span', { class: 'unit', text: unit }) : null);
  };
  const removeButton = (/** @type {string} */ aria, /** @type {() => void} */ run) =>
    h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': aria, title: aria, html: icon('delete', 15), onclick: run });
  const addButton = (/** @type {string} */ text, /** @type {() => void} */ run) =>
    h('button', { type: 'button', class: 'btn sm', html: `${icon('plus', 14)}<span>${text}</span>`, onclick: run });
  const nextId = (/** @type {string} */ prefix, /** @type {Array<{ id: string }>} */ items) => {
    let k = items.length + 1;
    while (items.some(c => c.id === `${prefix}${k}`) || cls.has(`${prefix}${k}`)) k++;
    return `${prefix}${k}`;
  };

  const contingencies = h('div');
  const renderContingencies = () => {
    if (!draft.list.length) {
      contingencies.replaceChildren(h('p', { class: 'cont-empty', text: 'No contingencies of your own yet.' }));
      return;
    }
    const rows = draft.list.map((c, i) => {
      const name = /** @type {HTMLInputElement} */ (h('input', { class: 'input', value: c.name, placeholder: c.id, 'aria-label': 'Contingency name' }));
      name.addEventListener('change', () => { c.name = name.value.trim(); });
      const chips = h('div', { class: 'chips' }, ...c.elements.map((id, j) => h('span', { class: 'chip', title: id },
        h('span', { text: label(id) }),
        h('button', { type: 'button', 'aria-label': `Remove ${label(id)}`, html: icon('close', 12), onclick: () => { c.elements.splice(j, 1); renderContingencies(); } }))));
      const add = picker(OUTAGE_CLASSES, '', id => { if (!c.elements.includes(id)) c.elements.push(id); renderContingencies(); }, 'Add an element to this contingency', !c.elements.length);
      add.placeholder = `Add ${placeholderOf(OUTAGE_CLASSES).toLowerCase()}`;
      chips.append(add);
      return h('tr', {}, h('td', { class: 'cont-name' }, name), h('td', {}, chips), h('td', { class: 'cont-del' },
        removeButton('Remove contingency', () => { draft.list.splice(i, 1); renderContingencies(); renderRules(); })));
    });
    contingencies.replaceChildren(h('table', { class: 'cont-table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { text: 'Elements out together' }), h('th'))), h('tbody', {}, ...rows)));
  };

  const rules = h('div');
  const renderRules = () => {
    if (!draft.remedial.length) {
      rules.replaceChildren(h('p', { class: 'cont-empty', text: 'No remedial actions yet.' }));
      return;
    }
    rules.replaceChildren(...draft.remedial.map((r, i) => ruleCard(r, i)));
  };
  /** @param {RemedialAction} r @param {number} i */
  const ruleCard = (r, i) => {
    const name = /** @type {HTMLInputElement} */ (h('input', { class: 'input', value: r.name, placeholder: r.id, 'aria-label': 'Remedial action name' }));
    name.addEventListener('change', () => { r.name = name.value.trim(); });
    const head = h('div', { class: 'rule-head' }, name, removeButton('Remove remedial action', () => { draft.remedial.splice(i, 1); renderRules(); }));

    // The contingencies it is for: every one, one of the study case's own, or a single-element outage.
    const scope = h('div', { class: 'chips' });
    const ownName = (/** @type {string} */ id) => { const c = draft.list.find(x => x.id === id); return c ? c.name || c.id : `Outage of ${label(id)}`; };
    if (!r.contingencies.length) scope.append(h('span', { class: 'chip quiet', text: 'Every contingency' }));
    r.contingencies.forEach((id, j) => scope.append(h('span', { class: 'chip', title: id }, h('span', { text: ownName(id) }),
      h('button', { type: 'button', 'aria-label': `Remove ${ownName(id)}`, html: icon('close', 12), onclick: () => { r.contingencies.splice(j, 1); renderRules(); } }))));
    const own = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', 'aria-label': 'Add a contingency of your own' },
      h('option', { value: '', text: draft.list.length ? 'Add your contingency' : 'No contingencies of your own' }),
      ...draft.list.filter(c => !r.contingencies.includes(c.id)).map(c => h('option', { value: c.id, text: c.name || c.id }))));
    own.disabled = !draft.list.length;
    own.addEventListener('change', () => { if (own.value) { r.contingencies.push(own.value); renderRules(); } });
    const outage = picker(OUTAGE_CLASSES, '', id => { if (!r.contingencies.includes(id)) r.contingencies.push(id); renderRules(); }, 'Add the outage of an element', false);
    outage.placeholder = `Add outage of a ${placeholderOf(OUTAGE_CLASSES).toLowerCase()}`;
    scope.append(own, outage);

    const conditions = h('tbody');
    r.conditions.forEach((c, j) => {
      const kind = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', 'aria-label': 'Condition' }, ...CONDITIONS.map(([k, text]) => h('option', { value: k, text }))));
      kind.value = c.kind;
      kind.addEventListener('change', () => { r.conditions[j] = newCondition(/** @type {Condition['kind']} */ (kind.value)); renderRules(); });
      const spec = /** @type {[string, string, string]} */ (CONDITIONS.find(x => x[0] === c.kind));
      const target = c.kind === 'voltageBelow' || c.kind === 'voltageAbove'
        ? picker(['bus'], c.node, id => { /** @type {any} */ (c).node = id; }, 'Condition busbar')
        : picker(c.kind === 'outage' ? OUTAGE_CLASSES : BRANCH_CLASSES, c.element, id => { /** @type {any} */ (c).element = id; }, c.kind === 'outage' ? 'Condition element' : 'Condition branch');
      const value = c.kind === 'loading' ? numberInput(c.above, spec[2], v => { c.above = v; }, 'Loading threshold')
        : c.kind === 'voltageBelow' ? numberInput(c.below, spec[2], v => { c.below = v; }, 'Voltage threshold')
          : c.kind === 'voltageAbove' ? numberInput(c.above, spec[2], v => { c.above = v; }, 'Voltage threshold') : h('span');
      conditions.append(h('tr', {}, h('td', {}, kind), h('td', {}, target), h('td', {}, value),
        h('td', { class: 'cont-del' }, removeButton('Remove condition', () => { r.conditions.splice(j, 1); renderRules(); }))));
    });

    const actions = h('tbody');
    r.actions.forEach((a, j) => {
      const choice = a.kind === 'switch' ? (a.inService ? 'in' : 'out') : a.kind;
      const kind = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', 'aria-label': 'Action' }, ...ACTIONS.map(([k, text]) => h('option', { value: k, text }))));
      kind.value = choice;
      kind.addEventListener('change', () => { r.actions[j] = newAction(kind.value, a.element, cls); renderRules(); });
      const classes = ACTION_CLASSES[a.kind];
      const target = picker(classes, classes.includes(cls.get(a.element) ?? '') ? a.element : '', id => { a.element = id; }, 'Action element');
      const value = a.kind === 'generation' ? numberInput(a.p, 'MW', v => { a.p = v; }, 'Active power')
        : a.kind === 'tap' ? numberInput(a.position, '', v => { a.position = v; }, 'Tap position', true)
          : a.kind === 'loadShed' ? numberInput(a.percent, '%', v => { a.percent = Math.min(100, Math.max(0, v)); }, 'Share shed') : h('span');
      actions.append(h('tr', {}, h('td', {}, kind), h('td', {}, target), h('td', {}, value),
        h('td', { class: 'cont-del' }, removeButton('Remove action', () => { r.actions.splice(j, 1); renderRules(); }))));
    });

    return h('section', { class: 'rule', 'aria-label': r.name || r.id }, head,
      h('div', { class: 'rule-label', text: 'After' }), scope,
      h('div', { class: 'rule-label', text: r.conditions.length ? 'When all of these hold' : 'When: always (no conditions)' }),
      r.conditions.length ? h('table', { class: 'cont-table rows' }, conditions) : null,
      addButton('Add condition', () => { r.conditions.push(newCondition('loading')); renderRules(); }),
      h('div', { class: 'rule-label', text: 'Do' }),
      r.actions.length ? h('table', { class: 'cont-table rows' }, actions) : h('p', { class: 'cont-empty', 'data-required': '', text: 'Add at least one action.' }),
      addButton('Add action', () => { r.actions.push(newAction('out', '', cls)); renderRules(); }));
  };

  body.append(
    h('h3', { text: 'Contingencies' }),
    h('p', { class: 'cont-note', text: 'The analysis takes out each line and transformer in turn, as the study case sets. Add contingencies here for elements that fail together, such as both circuits of a double line.' }),
    contingencies,
    addButton('Add contingency', () => { draft.list.push({ id: nextId('C', draft.list), name: '', elements: [] }); renderContingencies(); renderRules();
      /** @type {HTMLInputElement | null} */ (contingencies.querySelector('tbody tr:last-child .chips input'))?.focus(); }),
    h('h3', { text: 'Remedial actions' }),
    h('p', { class: 'cont-note', text: 'After a contingency, a rule whose conditions all hold applies its actions, and the contingency is solved again. Results show the state after them.' }),
    rules,
    addButton('Add remedial action', () => { draft.remedial.push({ id: nextId('R', draft.remedial), name: '', contingencies: [], conditions: [newCondition('loading')], actions: [newAction('out', '', cls)] }); renderRules(); }));
  renderContingencies();
  renderRules();

  const importFile = () => {
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }));
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const read = readContingencyFile(await file.text(), cls);
        draft.list = read.contingencies;
        draft.remedial = read.remedial;
        renderContingencies();
        renderRules();
        const what = `${read.contingencies.length} contingenc${read.contingencies.length === 1 ? 'y' : 'ies'} and ${read.remedial.length} remedial action${read.remedial.length === 1 ? '' : 's'}`;
        if (read.issues.length) toast('warn', `${read.issues.slice(0, 3).join(' ')}${read.issues.length > 3 ? ` And ${read.issues.length - 3} more.` : ''}`, { title: `Read ${what}` });
        else toast('ok', `Read ${what}. Apply to keep them.`);
      } catch (e) {
        toast('error', /** @type {Error} */ (e).message, { title: 'Could not read the file' });
      }
    });
    document.body.append(input);
    input.click();
  };
  const exportFile = () => {
    const kept = tidy(draft, cls);
    download(new Blob([contingencyFile(kept.list, kept.remedial)], { type: 'application/json' }), fileName(`${doc.name}-contingencies`, '.json'));
  };

  /** Marks what is missing; true when everything is complete. */
  const complete = () => {
    const missing = [...body.querySelectorAll('[data-required]')].filter(e => e.tagName !== 'INPUT' || !(/** @type {HTMLElement} */ (e)).dataset.id);
    for (const e of missing) e.classList.add('invalid');
    if (!missing.length) return true;
    missing[0].scrollIntoView({ block: 'center' });
    toast('warn', 'Pick the highlighted elements, or remove the entries they belong to.', { title: `${missing.length} entr${missing.length === 1 ? 'y needs' : 'ies need'} an element` });
    return false;
  };
  const ok = await modal({
    title: 'Contingencies and remedial actions', body, wide: true,
    actions: [{ label: 'Import…', left: true, run: () => { importFile(); return null; } }, { label: 'Export', left: true, run: () => { exportFile(); return null; } },
      { label: 'Cancel', value: false }, { label: 'Apply', primary: true, run: () => (complete() ? true : null) }],
  });
  if (!ok) return;
  const kept = tidy(draft, cls);
  app.tryEdit('Contingencies', () => app.store.transact('Edit contingencies', tx => {
    if (JSON.stringify(kept.list) !== JSON.stringify(doc.study.contingency.list)) tx.setStudy('contingency', 'list', kept.list);
    if (JSON.stringify(kept.remedial) !== JSON.stringify(doc.study.contingency.remedial)) tx.setStudy('contingency', 'remedial', kept.remedial);
  }));
}

/** What a picker for these classes asks for. @param {readonly string[]} classes */
function placeholderOf(classes) {
  const words = /** @type {Record<string, string>} */ ({ bus: 'busbar', line: 'line', trafo: 'transformer', gen: 'machine', load: 'load', shunt: 'shunt' });
  const names = classes.map(c => words[c] ?? c);
  const text = names.length > 2 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join(' or ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** @param {Condition['kind']} kind @returns {Condition} */
function newCondition(kind) {
  if (kind === 'loading') return { kind, element: '', above: 100 };
  if (kind === 'voltageBelow') return { kind, node: '', below: 0.9 };
  if (kind === 'voltageAbove') return { kind, node: '', above: 1.1 };
  return { kind: 'outage', element: '' };
}

/** @param {string} choice @param {string} element @param {Map<string, string>} cls @returns {Action} */
function newAction(choice, element, cls) {
  const kind = choice === 'in' || choice === 'out' ? 'switch' : /** @type {Action['kind']} */ (choice);
  const keep = ACTION_CLASSES[kind].includes(cls.get(element) ?? '') ? element : '';
  if (kind === 'switch') return { kind, element: keep, inService: choice === 'in' };
  if (kind === 'generation') return { kind, element: keep, p: 0 };
  if (kind === 'tap') return { kind, element: keep, position: 0 };
  return { kind: 'loadShed', element: keep, percent: 10 };
}

/** The draft with incomplete items left out, through the same check as a file.
 * @param {{ list: Contingency[], remedial: RemedialAction[] }} draft @param {Map<string, string>} cls */
function tidy(draft, cls) {
  const named = draft.list.map(c => ({ ...c, name: c.name || c.id }));
  const r = readContingencyFile(contingencyFile(named, draft.remedial.map(x => ({ ...x, name: x.name || x.id }))), cls);
  return { list: r.contingencies, remedial: r.remedial };
}
