import { test } from 'node:test';
import assert from 'node:assert/strict';
import { align, distribute, sameLength, rotate, flip, spreadConnections } from '../src/core/diagram-ops.js';
import { Snapper } from '../src/ui/snap.js';
import { inRect, hitAll } from '../src/render/hittest.js';
import { bar, attachPoint } from '../src/render/geometry.js';
import { DocumentStore } from '../src/core/store.js';
import { makeElement } from '../src/core/catalog.js';
import { ieee14 } from '../src/samples/ieee14.js';

/** A horizontal busbar. @param {string} id @param {number} x @param {number} y @param {number} len */
const bus = (id, x, y, len = 120) => makeElement('bus', id, { name: id, vn: 20, x, y, len, orient: 'h' });

/** Applies changes to copies of elements. @param {any[]} els @param {Array<[string, string, unknown]>} changes */
function applied(els, changes) {
  const out = new Map(els.map(e => [e.id, { ...e }]));
  for (const [id, key, value] of changes) /** @type {any} */ (out.get(id))[key] = value;
  return out;
}

test('align lines busbars up with the first one, on every edge and centre', () => {
  const els = [bus('A', 0, 0, 200), bus('B', 330, 77, 80), bus('C', -45, 140, 120)];
  for (const [mode, of] of /** @type {const} */ ([['left', 'x0'], ['right', 'x1'], ['top', 'y0'], ['bottom', 'y1']])) {
    const out = applied(els, align(els, mode));
    for (const id of ['B', 'C']) assert.equal(bar(/** @type {any} */ (out.get(id)))[of], bar(els[0])[of], `${mode} ${id}`);
  }
  const centred = applied(els, align(els, 'centre'));
  for (const id of ['B', 'C']) assert.equal(/** @type {any} */ (centred.get(id)).x, 0);
  assert.equal(/** @type {any} */ (applied(els, align(els, 'middle')).get('B')).y, 0);
  assert.deepEqual(align([els[0]], 'left'), [], 'one busbar has nothing to line up with');
});

test('distribute leaves equal gaps and keeps the outermost busbars', () => {
  const els = [bus('A', 0, 0, 100), bus('B', 130, 0, 60), bus('C', 400, 0, 100), bus('D', 520, 0, 40)];
  const out = applied(els, distribute(els, 'x'));
  const g = ['A', 'B', 'C', 'D'].map(id => bar(/** @type {any} */ (out.get(id))));
  const gaps = g.slice(1).map((b, i) => b.x0 - g[i].x1);
  // Positions are rounded to a thousandth of a unit.
  for (const gap of gaps) assert.ok(Math.abs(gap - gaps[0]) < 0.01, String(gaps));
  assert.equal(g[0].x0, -50);
  assert.equal(g[3].x1, 540);
  assert.deepEqual(distribute(els.slice(0, 2), 'x'), [], 'two busbars have no gap between them to share');
});

test('same length, rotate and flip', () => {
  const els = [bus('A', 0, 0, 240), bus('B', 300, 0, 80)];
  assert.deepEqual(sameLength(els), [['B', 'len', 240]]);
  assert.deepEqual(rotate(els), [['A', 'orient', 'v'], ['B', 'orient', 'v']]);
  const load = makeElement('load', 'D', { bus: 'A', side: 'below' });
  assert.deepEqual(flip([load]), [['D', 'side', 'above']]);
});

test('spreading connections touches only the selected busbars', () => {
  const doc = ieee14();
  const b4 = /** @type {any} */ (doc.elements.find(e => e.id === 'B4'));
  const changes = spreadConnections(doc, [b4]);
  assert.ok(changes.length > 0);
  for (const [id, key] of changes) {
    const el = /** @type {any} */ (doc.elements.find(e => e.id === id));
    const onB4 = key === 'pos' || key === 'side' ? el.bus === 'B4' : el[{ fromPos: 'from', toPos: 'to', hvPos: 'hv', lvPos: 'lv' }[key] ?? ''] === 'B4';
    assert.ok(onB4, `${id}.${key}`);
  }
});

test('a moved busbar snaps to another bar\'s lines within six pixels, else to the grid, and not at all with Alt', () => {
  const other = bus('T', 400, 300, 200);
  const snapper = new Snapper([other], { grid: 20, zoom: 1 });
  const moving = [bus('M', 0, 0, 100)];
  // Its centre comes to 3 units of the other bar's start (x 300), and its y within 4 of the other's.
  const near = snapper.move(moving, 297, 304, false);
  assert.deepEqual([near.dx, near.dy], [300, 300]);
  assert.equal(near.guides.length, 2);
  const far = snapper.move(moving, 263, 211, false);
  assert.deepEqual([far.dx, far.dy], [260, 220]);
  assert.equal(far.guides.length, 0);
  assert.deepEqual(snapper.move(moving, 297.4, 304.6, true), { dx: 297, dy: 305, guides: [] });
  // Zoomed out, the same screen distance covers more of the drawing.
  assert.equal(new Snapper([other], { grid: 20, zoom: 0.25 }).move(moving, 285, 0, false).dx, 300);
});

test('a bar end, a new busbar and a connection snap to what lines up with them', () => {
  const other = bus('T', 400, 300, 200);
  const snapper = new Snapper([other], { grid: 20, zoom: 1 });
  assert.equal(snapper.end(bus('M', 0, 0, 100), 503, false).v, 500);
  assert.equal(snapper.end(bus('M', 0, 0, 100), 470, false).v, 480);
  assert.deepEqual(snapper.point({ x: 398, y: 1000 }, false).p, { x: 400, y: 1000 });
  const b = bus('B', 0, 0, 200);
  // Towards the far end of the branch at x 37: in line with it; near the centre: the centre; else 10-unit steps.
  const far = { x: 37, y: 300 };
  assert.equal(attachPoint(b, snapper.along(b, { x: 40, y: 0 }, false, [far]).pos).x, 37);
  assert.equal(snapper.along(b, { x: 4, y: 0 }, false).pos, 0);
  assert.equal(attachPoint(b, snapper.along(b, { x: 64, y: 0 }, false).pos).x, 60);
  assert.equal(attachPoint(b, snapper.along(b, { x: 64, y: 0 }, true).pos).x, 64);
});

test('a marquee dragged right selects what lies wholly inside; dragged left, what it touches', () => {
  const doc = ieee14();
  const g = bar(/** @type {any} */ (doc.elements.find(e => e.id === 'B4')));
  const box = { x0: g.x0 - 5, y0: g.y0 - 5, x1: (g.x0 + g.x1) / 2, y1: g.y0 + 5 };
  assert.ok(!inRect(doc.elements, box).includes('B4'), 'half the bar is not wholly inside');
  assert.ok(inRect(doc.elements, box, true).includes('B4'), 'but the marquee touches it');
  assert.ok(inRect(doc.elements, { ...box, x1: g.x1 + 5 }).includes('B4'));
});

test('clicking where elements stack lists them topmost first', () => {
  const doc = ieee14();
  const load = /** @type {any} */ (doc.elements.find(e => e.cls === 'load' && e.bus === 'B4'));
  const at = attachPoint(/** @type {any} */ (doc.elements.find(e => e.id === 'B4')), load.pos);
  const stack = hitAll(doc.elements, { x: at.x, y: at.y + 2 }, 1);
  assert.deepEqual(stack.slice(0, 2), [load.id, 'B4']);
});

test('a drag is one step however long it pauses, and Escape reverts it without a trace', () => {
  const store = new DocumentStore(ieee14());
  const before = store.get('B4')?.x;
  store.transact('Move busbar', tx => tx.set('B4', 'x', 0), { coalesce: 'drag-1', gesture: true });
  store.past[store.past.length - 1].time -= 60_000;
  store.transact('Move busbar', tx => tx.set('B4', 'x', 40), { coalesce: 'drag-1', gesture: true });
  assert.equal(store.past.length, 1);
  assert.ok(store.revert('drag-1'));
  assert.equal(store.get('B4')?.x, before);
  assert.equal(store.past.length, 0);
  assert.equal(store.future.length, 0);
  assert.ok(!store.revert('drag-1'));
});
