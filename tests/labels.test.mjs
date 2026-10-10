import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studies } from './helpers.mjs';
import { buildScene } from '../src/render/scene.js';
import { buildOverlay } from '../src/ui/overlay.js';
import { DocumentStore, DRAWING_KEYS } from '../src/core/store.js';
import { CLASSES } from '../src/core/catalog.js';
import { ieee14 } from '../src/samples/ieee14.js';
import { riverside } from '../src/samples/riverside.js';

/** @type {any} */
const rgba = [0.5, 0.5, 0.5, 1];
const palette = /** @type {any} */ ({ bg: rgba, grid: rgba, ink: rgba, muted: rgba, select: rgba, hover: rgba, label: rgba, labelMuted: rgba, boxBg: rgba,
  boxBorder: rgba, boxText: rgba, kv: { ehv: rgba, hv: rgba, mv: rgba, lv: rgba }, fault: rgba, preview: rgba, res: { ok: rgba, warn: rgba, high: rgba, low: rgba } });

/**
 * The diagram of a sample with a study's results on it.
 * @param {import('../src/core/document.js').PowerDocument} doc @param {'loadflow' | 'shortcircuit' | 'contingency'} kind
 * @param {{ disentangle?: boolean, branchNames?: boolean }} [opt]
 */
function scene(doc, kind, opt = {}) {
  const result = kind === 'loadflow' ? studies.loadflow(doc, {}) : kind === 'shortcircuit' ? studies.shortcircuit(doc, {}) : studies.contingency(doc);
  const { overlay } = buildOverlay(kind, result, doc, palette, { colouring: 'results' });
  return buildScene({ elements: doc.elements, palette, selection: new Set(), hover: '', overlay, preview: null,
    labels: { names: true, branchNames: !!opt.branchNames, boxes: true, disentangle: opt.disentangle ?? true } });
}

/** Pairs of labels whose rectangles overlap. @param {import('../src/render/displaylist.js').DisplayList} list */
function overlaps(list) {
  const items = /** @type {import('../src/render/labels.js').LabelIndex} */ (list.labels).items, out = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].rect, b = items[j].rect;
    if (a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6) out.push(`${items[i].owner}.${items[i].slot} × ${items[j].owner}.${items[j].slot}`);
  }
  return out;
}

for (const [name, make] of /** @type {const} */ ([['IEEE 14-bus', ieee14], ['Riverside', riverside]])) {
  for (const kind of /** @type {const} */ (['loadflow', 'shortcircuit', 'contingency'])) {
    test(`${name}, ${kind}: no name or result box overlaps another`, () => {
      const list = scene(make(), kind, { branchNames: true });
      assert.ok(/** @type {any} */ (list.labels).items.length > 20);
      assert.deepEqual(overlaps(list), []);
    });
  }
}

test('with disentangling off every label keeps its default place; on, the same diagram has none overlapping', () => {
  const fixed = scene(ieee14(), 'loadflow', { disentangle: false });
  for (const l of /** @type {any} */ (fixed.labels).items) assert.deepEqual([l.rect.x0, l.rect.y0], [l.def.x, l.def.y], `${l.owner}.${l.slot}`);
  // The fixed places are the ones 1.0 drew, which collide: the reason for placing them.
  assert.ok(overlaps(fixed).length > 10);
  assert.deepEqual(overlaps(scene(ieee14(), 'loadflow')), []);
});

test('the same document and results give the same diagram, to the byte', () => {
  const a = scene(riverside(), 'loadflow'), b = scene(riverside(), 'loadflow');
  for (let k = 0; k < a.layers.length; k++) {
    assert.deepEqual(Array.from(a.layers[k].shapes), Array.from(b.layers[k].shapes));
    assert.deepEqual(a.layers[k].texts, b.layers[k].texts);
  }
});

test('a label dragged by hand keeps its offset, and the others keep clear of it', () => {
  const doc = ieee14();
  const before = /** @type {any} */ (scene(doc, 'loadflow').labels).items.find((/** @type {any} */ l) => l.owner === 'B4' && l.slot === 'box');
  const bus = /** @type {any} */ (doc.elements.find(e => e.id === 'B4'));
  bus.labels = { box: [40, -90] };
  const list = scene(doc, 'loadflow');
  const after = /** @type {any} */ (list.labels).items.find((/** @type {any} */ l) => l.owner === 'B4' && l.slot === 'box');
  assert.deepEqual([after.rect.x0, after.rect.y0], [before.def.x + 40, before.def.y - 90]);
  assert.deepEqual(overlaps(list), []);
});

test('moving a label is a drawing edit: it never marks results as old or reaches the engine', () => {
  for (const c of Object.values(CLASSES)) assert.ok(c.fields.some(f => f.key === 'labels' && f.group === 'graphic'), c.cls);
  assert.ok(DRAWING_KEYS.has('labels'));
  const store = new DocumentStore(ieee14());
  /** @type {any[]} */
  const changes = [];
  store.subscribe(ch => changes.push(ch));
  store.transact('Move label', tx => tx.set('B4', 'labels', { box: [10, 10] }));
  assert.equal(changes.at(-1).network, false);
  assert.throws(() => store.transact('Move label', tx => tx.set('B4', 'labels', { corner: [1, 2] })), /not a label slot/);
});
