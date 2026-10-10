import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentStore } from '../src/core/store.js';
import { makeElement } from '../src/core/catalog.js';
import { riverside } from '../src/samples/riverside.js';
import { ieee14 } from '../src/samples/ieee14.js';

const snapshot = (/** @type {DocumentStore} */ s) => JSON.stringify(s.doc);

test('undo and redo restore the document exactly, through adds, edits and cascading deletes', () => {
  const s = new DocumentStore(riverside());
  const states = [snapshot(s)];
  s.transact('Edit load', tx => tx.set('D1', 'p', 7.5)); states.push(snapshot(s));
  s.transact('Add bus', tx => tx.add(makeElement('bus', 'B10', { name: 'New', vn: 20 }))); states.push(snapshot(s));
  s.transact('Delete busbar', tx => tx.remove('B3')); states.push(snapshot(s));
  assert.ok(!s.get('L1') && !s.get('L2') && !s.get('D1'), 'elements on the busbar go with it');
  for (let i = states.length - 2; i >= 0; i--) { s.undo(); assert.equal(snapshot(s), states[i]); }
  for (let i = 1; i < states.length; i++) { s.redo(); assert.equal(snapshot(s), states[i]); }
});

test('invalid values are refused and leave no trace', () => {
  const s = new DocumentStore(riverside());
  const before = snapshot(s);
  assert.throws(() => s.transact('Bad', tx => { tx.set('D1', 'p', 3); tx.set('L1', 'length', -1); }), /greater than 0/);
  assert.equal(snapshot(s), before);
  assert.equal(s.canUndo, false);
  assert.throws(() => s.transact('Loop', tx => tx.set('L1', 'to', 'B2')), /same busbar/);
  assert.throws(() => s.transact('Dangling', tx => tx.set('L1', 'to', 'D1')), /must be a busbar/);
});

test('an optional busbar field can be emptied, and deleting the busbar it names empties it', () => {
  const s = new DocumentStore(ieee14());
  const gen = /** @type {import('../src/core/catalog.js').Element} */ (s.doc.elements.find(e => e.cls === 'gen' && e.mode !== 'slack'));
  s.transact('Regulate', tx => tx.set(gen.id, 'regBus', 'B9'));
  s.transact('Own busbar', tx => tx.set(gen.id, 'regBus', ''));
  assert.equal(s.get(gen.id)?.regBus, '');
  assert.throws(() => s.transact('Empty', tx => tx.set(gen.id, 'bus', '')), /must be a busbar/);
  s.transact('Regulate', tx => tx.set(gen.id, 'regBus', 'B9'));
  s.transact('Delete busbar', tx => tx.remove('B9'));
  assert.ok(!s.get('B9'));
  assert.equal(s.get(gen.id)?.regBus, '');
});

test('edits with the same coalescing key become one undo step', () => {
  const s = new DocumentStore(riverside());
  const x0 = /** @type {number} */ (s.get('B3')?.x);
  for (let k = 1; k <= 5; k++) s.transact('Move', tx => tx.set('B3', 'x', x0 + k * 20), { coalesce: 'drag' });
  assert.equal(s.past.length, 1);
  s.undo();
  assert.equal(s.get('B3')?.x, x0);
});

test('changes report whether the network or only the drawing changed', () => {
  const s = new DocumentStore(riverside());
  /** @type {import('../src/core/store.js').Change[]} */
  const seen = [];
  s.subscribe(c => seen.push(c));
  s.transact('Move', tx => tx.set('B3', 'x', 0));
  s.transact('Edit', tx => tx.set('D1', 'q', 1));
  s.transact('Study', tx => tx.setStudy('loadflow', 'maxIter', 12));
  assert.deepEqual(seen.map(c => [c.network, c.study]), [[false, false], [true, false], [false, true]]);
});
