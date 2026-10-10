import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentStore } from '../src/core/store.js';
import { makeElement } from '../src/core/catalog.js';
import { projectFromDocument, compose, route, replay, activeCase } from '../src/core/project.js';
import { ieee14 } from '../src/samples/ieee14.js';

/** A project on IEEE 14 with the editor's store on its composition, every edit routed as the app routes it. */
function session() {
  const project = projectFromDocument(ieee14());
  const store = new DocumentStore(compose(project));
  /** @type {Set<string>} */
  const dirty = new Set();
  store.subscribe(change => { if (change.source !== 'load') for (const part of route(project, change.ops)) dirty.add(part); });
  /** Re-composes after a change of case, scenario or variants, as switching does. */
  const reopen = () => store.load(compose(project));
  return { project, store, dirty, reopen };
}

const el = (/** @type {DocumentStore} */ s, /** @type {string} */ id) => /** @type {import('../src/core/catalog.js').Element} */ (s.get(id));

test('a new project composes to its document, with the case holding the settings', () => {
  const { project, store } = session();
  assert.deepEqual(store.doc, ieee14());
  assert.deepEqual(activeCase(project).study, ieee14().study);
});

test('edits to the equipment go to the base, unless a variant is recording, and study settings go to the case', () => {
  const { project, store, dirty } = session();
  store.transact('Edit', tx => tx.set('L1', 'length', 12));
  assert.equal(project.base.elements.find(e => e.id === 'L1')?.length, 12);
  project.variants.push({ id: 'variant-1', name: 'New line', description: '', inService: '', ops: [] });
  activeCase(project).variants.push('variant-1');
  project.recording = 'variant-1';
  store.transact('Add', tx => tx.add(makeElement('line', 'L99', { from: 'B1', to: 'B5' })));
  store.transact('Edit', tx => tx.set('L2', 'length', 20));
  store.transact('Settings', tx => tx.setStudy('loadflow', 'tolerance', 0.01));
  assert.ok(!project.base.elements.some(e => e.id === 'L99'), "the base does not get the variant's line");
  assert.notEqual(project.base.elements.find(e => e.id === 'L2')?.length, 20);
  assert.equal(project.variants[0].ops.length, 2);
  assert.equal(activeCase(project).study.loadflow.tolerance, 0.01);
  assert.deepEqual([...dirty].sort(), ['base', 'manifest', 'variant:variant-1']);
  // Drawing the variant's line, or the base's busbar, goes where the element lives.
  store.transact('Move', tx => { tx.set('L99', 'bend', 40); tx.set('B1', 'x', 500); });
  assert.equal(project.variants[0].ops.at(-1)?.type, 'set');
  assert.equal(project.base.elements.find(e => e.id === 'B1')?.x, 500);
});

test('a scenario takes the operating values, and switching cases recomposes', () => {
  const { project, store, reopen } = session();
  project.scenarios.push({ id: 'scenario-1', name: 'Winter peak', description: '', values: {} });
  project.cases.push({ id: 'case-2', name: 'Winter', scenario: 'scenario-1', variants: [], study: structuredClone(activeCase(project).study) });
  project.activeCase = 'case-2';
  reopen();
  const load = /** @type {string} */ (store.doc.elements.find(e => e.cls === 'load')?.id);
  const before = Number(el(store, load).p);
  store.transact('Peak', tx => { tx.set(load, 'p', before * 2); tx.set('L1', 'length', 15); });
  assert.deepEqual(project.scenarios[0].values[load], { p: before * 2 }, 'the load belongs to the scenario');
  assert.equal(project.base.elements.find(e => e.id === 'L1')?.length, 15, 'a length is equipment, so the base');
  project.activeCase = 'case-1';
  reopen();
  assert.equal(el(store, load).p, before);
  project.activeCase = 'case-2';
  reopen();
  assert.equal(el(store, load).p, before * 2);
});

test('a variant replays over a base edited since, and a scenario override of a missing element is dropped', () => {
  const { project, store, reopen } = session();
  project.variants.push({ id: 'variant-1', name: 'Rebuild', description: '', inService: '', ops: [] });
  project.scenarios.push({ id: 'scenario-1', name: 'Light', description: '', values: {} });
  const c = activeCase(project);
  c.variants.push('variant-1');
  c.scenario = 'scenario-1';
  project.recording = 'variant-1';
  reopen();
  store.transact('Variant', tx => {
    tx.set('L3', 'length', 30);
    tx.add(makeElement('bus', 'B99', { vn: 132 }));
    tx.remove('L4');
  });
  store.transact('Scenario', tx => tx.set('L3', 'inService', false));
  // The base changes after the variant was recorded: L3 is edited, L4 is removed, a new line is added.
  project.recording = '';
  store.transact('Base', tx => { tx.set('L3', 'length', 5); tx.remove('L4'); tx.add(makeElement('line', 'L98', { from: 'B1', to: 'B2' })); });
  project.base.elements = project.base.elements.filter(e => e.id !== 'L3');
  reopen();
  assert.ok(!store.get('L3'), 'an override of an element the composition lacks is dropped');
  assert.ok(store.get('B99') && store.get('L98') && !store.get('L4'));
  const ids = store.doc.elements.map(e => e.id);
  assert.ok(ids.indexOf('B99') < ids.indexOf('L1'), "the variant's busbar sits with the busbars");
});

test('a recorded operation is a copy: later edits of the element do not change the log', () => {
  const { project, store } = session();
  project.variants.push({ id: 'variant-1', name: 'V', description: '', inService: '', ops: [] });
  activeCase(project).variants.push('variant-1');
  project.recording = 'variant-1';
  store.transact('Add', tx => tx.add(makeElement('load', 'D99', { bus: 'B3', p: 1 })));
  el(store, 'D99').p = 7;
  const add = project.variants[0].ops[0];
  assert.equal(add.type === 'add' && add.el.p, 1);
});

test('replay ignores what a value was before, and removals of missing elements', () => {
  const doc = ieee14();
  replay(doc, [
    { type: 'set', id: 'L1', key: 'length', before: 999, after: 2 },
    { type: 'remove', el: /** @type {any} */ ({ id: 'nowhere' }) },
    { type: 'add', index: 0, el: makeElement('shunt', 'S99', { bus: 'B9' }) },
  ]);
  assert.equal(doc.elements.find(e => e.id === 'L1')?.length, 2);
  const ids = doc.elements.map(e => e.id);
  assert.ok(ids.indexOf('S99') > ids.indexOf('L1'), 'an added element goes with its class, not at the recorded index');
});

test('a project survives its parts: manifest, variants and scenarios', async () => {
  const { manifestOf, partTexts, projectFromParts, allParts } = await import('../src/core/project.js');
  const { project, store } = session();
  project.variants.push({ id: 'variant-1', name: 'V', description: 'A line', inService: '2027-01-01', ops: [] });
  project.scenarios.push({ id: 'scenario-1', name: 'S', description: '', values: {} });
  const c = activeCase(project);
  c.variants.push('variant-1');
  c.scenario = 'scenario-1';
  project.recording = 'variant-1';
  store.transact('Edit', tx => { tx.add(makeElement('bus', 'B99', { vn: 33 })); tx.set('L1', 'inService', false); });
  const texts = new Map(partTexts(project, allParts(project)).map(([k, v]) => [k, /** @type {string} */ (v)]));
  assert.ok(!texts.has('base'));
  const again = projectFromParts(project.base, texts);
  assert.deepEqual(again, project);
  assert.deepEqual(manifestOf(again).variants, [{ id: 'variant-1', name: 'V', description: 'A line', inService: '2027-01-01' }]);
  assert.deepEqual(compose(again), compose(project));
  // A deleted variant's part is deleted.
  project.variants = [];
  assert.deepEqual(partTexts(project, ['variant:variant-1']), [['variant/variant-1', null]]);
  // A document saved before projects opens with one case holding its settings.
  const old = projectFromParts(ieee14(), new Map());
  assert.equal(old.cases.length, 1);
  assert.deepEqual(old.cases[0].study, ieee14().study);
});
