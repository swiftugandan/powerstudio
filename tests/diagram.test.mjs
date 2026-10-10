import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene, levelZooms } from '../src/render/scene.js';
import { SHAPE_STRIDE, SHAPE_MIN_ZOOM } from '../src/render/displaylist.js';
import { hitTest, inRect, HitIndex } from '../src/render/hittest.js';
import { route, bar } from '../src/render/geometry.js';
import { ieee14 } from '../src/samples/ieee14.js';
import { riverside } from '../src/samples/riverside.js';

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

test('a large diagram brings its voltage levels in from the highest, and shows violations at every zoom', () => {
  // A 60 × 60 grid of 33 kV busbars under a 400 kV row: large enough for levels of detail.
  /** @type {import('../src/core/catalog.js').Element[]} */
  const elements = [];
  for (let r = 0; r < 60; r++) for (let c = 0; c < 60; c++) {
    elements.push({ id: `B${r}-${c}`, cls: 'bus', name: '', vn: r ? 33 : 400, x: c * 300, y: r * 240, len: 120, orient: 'h' });
    if (c) elements.push({ id: `L${r}-${c}`, cls: 'line', name: '', from: `B${r}-${c - 1}`, to: `B${r}-${c}`, fromPos: 0, toPos: 0 });
  }
  const buses = new Map(elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
  const zooms = /** @type {Map<number, number>} */ (levelZooms(elements, buses));
  assert.equal(zooms.get(400), 0);
  assert.ok(/** @type {number} */ (zooms.get(33)) > 0, 'the lower level waits for room');
  assert.equal(levelZooms(ieee14().elements, new Map()), null, 'a small diagram is drawn whole');
  const overlay = { elements: new Map([['L5-5', { alert: true }]]), faultAt: '', deenergized: new Set() };
  const list = buildScene({ elements, palette, selection: new Set(), hover: '', overlay, preview: null, labels: { names: false, branchNames: false, boxes: false } });
  const branches = list.layers[1].shapes, count = branches.length / SHAPE_STRIDE;
  const from = Array.from({ length: count }, (_, k) => branches[k * SHAPE_STRIDE + SHAPE_MIN_ZOOM]);
  // Branch shapes follow the document, each route the same number of segments: the 400 kV row's 59 lines first.
  const per = count / elements.filter(e => e.cls === 'line').length, top = 59 * per;
  assert.ok(from.slice(0, top).every(z => z === 0));
  const lower = from.slice(top);
  assert.equal(lower.filter(z => z === 0).length, per, 'only the overloaded line shows at every zoom');
  assert.ok(lower.filter(z => z > 0).every(z => z === Math.fround(/** @type {number} */ (zooms.get(33)))));
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

test('the hit index finds exactly what a full scan finds, at every zoom and with a selection', () => {
  for (const doc of [ieee14(), riverside()]) {
    const index = new HitIndex(doc.elements);
    const xs = doc.elements.filter(e => e.cls === 'bus').flatMap(b => [Number(b.x), Number(b.x) + Number(b.len) / 2]);
    const ys = doc.elements.filter(e => e.cls === 'bus').map(b => Number(b.y));
    const [x0, x1, y0, y1] = [Math.min(...xs) - 200, Math.max(...xs) + 200, Math.min(...ys) - 200, Math.max(...ys) + 200];
    let checked = 0, found = 0;
    for (let i = 0; i < 4000; i++) {
      // A deterministic scatter over the diagram.
      const p = { x: x0 + ((i * 7919) % 1000) / 1000 * (x1 - x0), y: y0 + ((i * 104729) % 997) / 997 * (y1 - y0) };
      for (const zoom of [0.2, 1, 3]) {
        const selection = new Set(i % 3 ? [] : [doc.elements[i % doc.elements.length].id]);
        const full = hitTest(doc.elements, p, zoom, selection), indexed = hitTest(doc.elements, p, zoom, selection, index);
        assert.deepEqual(indexed, full, `${doc.name} at ${p.x}, ${p.y} zoom ${zoom}`);
        checked++;
        if (full) found++;
      }
    }
    assert.ok(found > checked / 20, `${doc.name}: ${found} of ${checked} points hit something`);
  }
});
