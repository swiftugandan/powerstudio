import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContingencies, contingencyFile, readContingencyFile } from '../src/core/contingencies.js';
import { DocumentStore } from '../src/core/store.js';
import { ieee14 } from '../src/samples/ieee14.js';

const classes = new Map([['L1', 'line'], ['L2', 'line'], ['T1', 'trafo'], ['G1', 'gen'], ['D1', 'load'], ['B1', 'bus']]);

test('a rule never widens: one with an invalid condition, or for no remaining contingency, is skipped whole', () => {
  const shed = [{ kind: 'loadShed', element: 'D1', percent: 50 }];
  const r = checkContingencies([{ id: 'C1', elements: ['L1', 'L2'] }], [
    { id: 'R1', contingencies: ['C1', 'gone'], conditions: [{ kind: 'loading', element: 'L2', above: 100 }], actions: shed },
    { id: 'R2', contingencies: ['gone'], conditions: [], actions: shed },
    { id: 'R3', contingencies: [], conditions: [{ kind: 'loading', element: 'gone', above: 100 }], actions: shed },
    { id: 'R4', contingencies: [], conditions: [{ kind: 'voltageBelow', node: 'L1', below: 0.9 }], actions: shed },
  ], classes);
  assert.deepEqual(r.remedial.map(x => [x.id, x.contingencies]), [['R1', ['C1']]]);
  assert.equal(r.issues.length, 4);
});

test('contingencies keep only elements that can fail, and identifiers of their own', () => {
  const r = checkContingencies([{ id: 'C1', elements: ['L1', 'D1', 'B1'] }, { id: 'L2', elements: ['T1'] }, { id: 'C2', elements: ['D1'] }], [], classes);
  assert.deepEqual(r.contingencies, [{ id: 'C1', name: '', elements: ['L1'] }]);
});

test('actions name elements of the class they act on', () => {
  const r = checkContingencies([], [{ id: 'R1', contingencies: [], conditions: [], actions: [
    { kind: 'tap', element: 'T1', position: 2 }, { kind: 'tap', element: 'G1', position: 2 }, { kind: 'generation', element: 'G1', p: 40 },
    { kind: 'switch', element: 'L1', inService: false }, { kind: 'loadShed', element: 'D1', percent: 120 }] }], classes);
  assert.deepEqual(r.remedial[0].actions.map(a => `${a.kind} ${a.element}`), ['tap T1', 'generation G1', 'switch L1']);
});

test('the file round-trips, and a file of another kind is refused with a plain message', () => {
  const list = [{ id: 'C1', name: 'Double', elements: ['L1', 'L2'] }];
  const remedial = [{ id: 'R1', name: 'Shed', contingencies: ['C1'], conditions: [{ kind: /** @type {const} */ ('outage'), element: 'L1' }], actions: [{ kind: /** @type {const} */ ('switch'), element: 'T1', inService: false }] }];
  const back = readContingencyFile(contingencyFile(list, remedial), classes);
  assert.deepEqual([back.contingencies, back.remedial, back.issues], [list, remedial, []]);
  assert.throws(() => readContingencyFile('{"format":"powerstudio"}', classes), /not a contingency file/);
  assert.throws(() => readContingencyFile('nope', classes), /not valid JSON/);
});

test('removing an element takes it out of contingencies and rules, and undo brings them back', () => {
  const store = new DocumentStore(ieee14());
  store.transact('Lists', tx => {
    tx.setStudy('contingency', 'list', [{ id: 'C1', name: 'Pair', elements: ['L1', 'L2'] }, { id: 'C2', name: 'One', elements: ['L3'] }]);
    tx.setStudy('contingency', 'remedial', [
      { id: 'R1', name: 'For C2', contingencies: ['C2'], conditions: [], actions: [{ kind: 'loadShed', element: 'D2', percent: 10 }] },
      { id: 'R2', name: 'On L2', contingencies: [], conditions: [{ kind: 'loading', element: 'L2', above: 100 }], actions: [{ kind: 'loadShed', element: 'D3', percent: 10 }] },
      { id: 'R3', name: 'Two actions', contingencies: ['C1'], conditions: [], actions: [{ kind: 'switch', element: 'L3', inService: false }, { kind: 'loadShed', element: 'D3', percent: 10 }] },
    ]);
  });
  const before = structuredClone(store.doc.study.contingency);
  store.transact('Remove', tx => tx.remove('L3'));
  const after = store.doc.study.contingency;
  assert.deepEqual(after.list.map(c => c.id), ['C1'], 'C2 had L3 only');
  // R1 was for C2 only, so it goes rather than apply to every contingency; R3 keeps its other action.
  assert.deepEqual(after.remedial.map(r => [r.id, r.actions.length]), [['R2', 1], ['R3', 1]]);
  store.transact('Remove', tx => tx.remove('L2'));
  assert.deepEqual(store.doc.study.contingency.remedial.map(r => r.id), ['R3'], 'R2 had a condition on L2');
  store.undo();
  store.undo();
  assert.deepEqual(store.doc.study.contingency, before);
});
