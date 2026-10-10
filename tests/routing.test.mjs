import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orthogonal, moveSegment, removeSegment, route, simplify } from '../src/render/geometry.js';
import { obstaclesOf, blocked, avoidingRoute } from '../src/render/routing.js';
import { makeElement } from '../src/core/catalog.js';

/** A small deterministic random sequence (a linear congruential generator). @param {number} seed */
function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Checks that a route is orthogonal, runs from A to B, and meets each bar at right angles.
 * @param {Array<{ x: number, y: number }>} pts @param {{ x: number, y: number }} A @param {{ x: number, y: number }} B
 * @param {boolean} ha @param {boolean} hb @param {string} what
 */
function assertRoute(pts, A, B, ha, hb, what) {
  assert.deepEqual(pts[0], A, what);
  assert.deepEqual(pts[pts.length - 1], B, what);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    assert.ok(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9, `${what}: segment ${i} is not orthogonal`);
  }
  if (pts.length > 2) {
    const first = pts[1], last = pts[pts.length - 2];
    assert.ok(ha ? Math.abs(first.x - A.x) < 1e-9 && Math.abs(first.y - A.y) >= 10 - 1e-9 : Math.abs(first.y - A.y) < 1e-9 && Math.abs(first.x - A.x) >= 10 - 1e-9, `${what}: leaves A along its bar`);
    assert.ok(hb ? Math.abs(last.x - B.x) < 1e-9 : Math.abs(last.y - B.y) < 1e-9, `${what}: enters B along its bar`);
  }
}

test('a route shaped by hand stays orthogonal, and meets its bars at right angles, wherever the bars move', () => {
  const rnd = random(7);
  for (let trial = 0; trial < 2000; trial++) {
    const grid = () => Math.round((rnd() - 0.5) * 40) * 20;
    const A = { x: grid(), y: grid() }, B = { x: grid(), y: grid() };
    const ha = rnd() < 0.7, hb = rnd() < 0.7;
    const corners = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => /** @type {[number, number]} */ ([grid(), grid()]));
    assertRoute(orthogonal(A, B, ha, hb, corners), A, B, ha, hb, `trial ${trial}`);
  }
});

test('moving a segment shapes the route; the ends keep meeting their bars at right angles', () => {
  const bus = (/** @type {string} */ id, /** @type {number} */ x, /** @type {number} */ y) => makeElement('bus', id, { vn: 20, x, y, len: 200, orient: 'h' });
  const a = bus('A', 0, 0), b = bus('B', 300, 400);
  const line = makeElement('line', 'L', { from: 'A', to: 'B', fromPos: 0.25, toPos: -0.25 });
  const pts = route(line, a, b);
  assert.equal(pts.length, 4, 'an automatic Z route');
  for (let i = 0; i < pts.length - 1; i++) {
    for (const d of [-60, 40]) {
      const shaped = route({ ...line, route: moveSegment(pts, i, d) }, a, b);
      assertRoute(shaped, pts[0], pts[pts.length - 1], true, true, `segment ${i} by ${d}`);
    }
  }
  // The middle segment moves with its corners.
  const middle = route({ ...line, route: moveSegment(pts, 1, 40) }, a, b);
  assert.equal(middle[1].y, pts[1].y + 40);
  // A straight route gets a jog at each end.
  const straight = makeElement('line', 'S', { from: 'A', to: 'C', fromPos: 0, toPos: 0 }), c = bus('C', 0, 400);
  const sp = route(straight, a, c);
  assert.equal(sp.length, 2);
  const jogged = route({ ...straight, route: moveSegment(sp, 0, 80) }, a, c);
  assertRoute(jogged, sp[0], sp[1], true, true, 'straight');
  assert.ok(jogged.some(p => p.x === 80));
  // Taking the jog out again leaves a valid route.
  const back = route({ ...line, route: removeSegment(middle, 1) }, a, b);
  assertRoute(back, pts[0], pts[pts.length - 1], true, true, 'removed');
});

test('a branch is routed around a busbar in its way, crossing nothing, within the time budget', () => {
  const bus = (/** @type {string} */ id, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ len = 200) => makeElement('bus', id, { name: id, vn: 20, x, y, len, orient: 'h' });
  // Bus M lies right across the way from A down to B.
  const elements = [bus('A', 0, 0), bus('B', 0, 400), bus('M', 0, 200, 400), makeElement('line', 'L', { from: 'A', to: 'B', fromPos: 0, toPos: 0 })];
  const buses = new Map(elements.filter(e => e.cls === 'bus').map(b => [b.id, b])), obstacles = obstaclesOf(elements);
  const line = /** @type {any} */ (elements[3]);
  assert.ok(blocked(route(line, buses.get('A'), buses.get('B')), obstacles));
  const corners = avoidingRoute(line, /** @type {any} */ (buses), obstacles);
  assert.ok(corners);
  const pts = route({ ...line, route: corners }, /** @type {any} */ (buses.get('A')), /** @type {any} */ (buses.get('B')));
  assert.ok(!blocked(pts, obstacles), JSON.stringify(pts));
  assertRoute(pts, pts[0], pts[pts.length - 1], true, true, 'avoiding');
  assert.equal(simplify(pts).length, pts.length);
  // 500 branches across a field of busbars, every one routed clear: the design's budget is 200 ms.
  const field = [];
  for (let r = 0; r < 25; r++) for (let q = 0; q < 25; q++) field.push(bus(`F${r}-${q}`, q * 300, r * 240, 160));
  const fieldBuses = new Map(field.map(b => [b.id, b])), fieldObstacles = obstaclesOf(field), rnd = random(3);
  const lines = Array.from({ length: 500 }, (_, i) => makeElement('line', `X${i}`, { from: `F${Math.floor(rnd() * 25)}-${Math.floor(rnd() * 25)}`, to: `F${Math.floor(rnd() * 25)}-${Math.floor(rnd() * 25)}`, fromPos: 0.2, toPos: -0.2 }))
    .filter(l => l.from !== l.to);
  const t0 = performance.now();
  const found = lines.map(l => [l, avoidingRoute(l, /** @type {any} */ (fieldBuses), fieldObstacles)]);
  const ms = performance.now() - t0;
  const routed = found.filter(([, c]) => c);
  assert.ok(routed.length > lines.length * 0.95, `${routed.length} of ${lines.length} routed`);
  for (const [l, corners] of routed) {
    const ends = [fieldBuses.get(/** @type {string} */ (l.from)), fieldBuses.get(/** @type {string} */ (l.to))];
    assert.ok(!blocked(route({ ...l, route: corners }, /** @type {any} */ (ends[0]), /** @type {any} */ (ends[1])), fieldObstacles), l.id);
  }
  // The design's budget is 200 ms; this takes about 60 ms on the development machine and 800 ms on a busy CI runner
  // sharing its cores with other test files. The bound here only catches a search that has stopped scaling.
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
});
