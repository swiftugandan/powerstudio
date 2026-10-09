import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../src/render/scene.js';
import { SHAPE_STRIDE } from '../src/render/displaylist.js';
import { hitTest, inRect } from '../src/render/hittest.js';
import { route, bar } from '../src/render/geometry.js';
import { ieee14 } from '../src/samples/ieee14.js';

/** @type {any} */
const rgba = [0.5, 0.5, 0.5, 1];
const palette = /** @type {any} */ ({ bg: rgba, grid: rgba, ink: rgba, muted: rgba, select: rgba, hover: rgba, label: rgba, labelMuted: rgba, boxBg: rgba,
  boxBorder: rgba, boxText: rgba, kv: { ehv: rgba, hv: rgba, mv: rgba, lv: rgba }, fault: rgba, preview: rgba });

test('the scene has a bar for every busbar and a label for every name', () => {
  const doc = ieee14();
  const list = buildScene({ elements: doc.elements, palette, selection: new Set(), hover: '', overlay: null, preview: null, labels: { names: true, branchNames: false, boxes: true } });
  const busLayer = list.layers[2];
  assert.equal(busLayer.shapes.filter((_, i) => i % SHAPE_STRIDE === 0 && busLayer.shapes[i] === 0).length, 14);
  for (let n = 1; n <= 14; n++) assert.ok(busLayer.texts.some(t => t.text === `Bus ${n}`));
});

test('every route is orthogonal and ends on its busbars', () => {
  const doc = ieee14(), buses = new Map(doc.elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
  for (const el of doc.elements.filter(e => e.cls === 'line' || e.cls === 'trafo')) {
    const [a, b] = el.cls === 'line' ? [el.from, el.to] : [el.hv, el.lv];
    const pts = route(el, /** @type {any} */ (buses.get(/** @type {string} */ (a))), /** @type {any} */ (buses.get(/** @type {string} */ (b))));
    for (let i = 0; i < pts.length - 1; i++) assert.ok(pts[i].x === pts[i + 1].x || pts[i].y === pts[i + 1].y, `${el.id} segment ${i}`);
    const g = bar(/** @type {any} */ (buses.get(/** @type {string} */ (a))));
    assert.equal(pts[0].y, g.y0);
  }
});

test('hit testing finds busbars, symbols and branches, and the marquee selects whole elements', () => {
  const doc = ieee14();
  const b4 = /** @type {any} */ (doc.elements.find(e => e.id === 'B4'));
  assert.equal(hitTest(doc.elements, { x: b4.x, y: b4.y }, 1, new Set())?.id, 'B4');
  assert.equal(hitTest(doc.elements, { x: b4.x + b4.len / 2, y: b4.y }, 1, new Set(['B4']))?.part, 'end1');
  assert.equal(hitTest(doc.elements, { x: -10000, y: 0 }, 1, new Set()), null);
  const ids = inRect(doc.elements, { x0: -1000, y0: -1000, x1: 1000, y1: 1000 });
  assert.equal(ids.length, doc.elements.length);
});
