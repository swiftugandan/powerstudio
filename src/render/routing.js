/** Routing branches around obstacles (docs/design/CAD.md, section 7.3).
 *
 * A route leaves each of its bars at right angles for a short stem, then finds the shortest orthogonal path between
 * the stems' ends that crosses no busbar or symbol, counting each bend as extra length, by the method of Wybrow,
 * Marriott and Stuckey (2009): a graph whose nodes are the crossings of the lines through the obstacles' padded edges
 * and the stems' ends, whose edges join neighbouring nodes in sight of each other, searched with A* over (node,
 * direction). The search covers the stems' surroundings, so its cost depends on the obstacles near the branch, not on
 * the size of the network. No DOM access. */

import { bar, stub, attachPoint, branchKeys, route, simplify } from './geometry.js';

/**
 * @typedef {import('../core/catalog.js').Element} Element
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect
 */

/** Clearance kept from busbars and symbols. */
const PAD = 14;
/** Length of the stem that leaves a bar at right angles before the route may turn. */
const STEM = 24;
/** How far around the stems the search looks, beyond the box they span. */
const MARGIN = 240;
/** What a bend costs, in units of length. */
const BEND = 40;
/** How much of a segment may lie in an obstacle before it counts as crossing it (a branch's own exit from its bar). */
const GRAZE = 4;

/** What a diagram's routes must avoid: busbars, and the stubs and symbols of single-port elements, padded.
 * @param {Element[]} elements @returns {Rect[]} */
export function obstaclesOf(elements) {
  const buses = new Map(elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
  /** @type {Rect[]} */
  const out = [];
  for (const b of buses.values()) {
    const g = bar(b);
    out.push({ x0: g.x0 - PAD, y0: g.y0 - PAD, x1: g.x1 + PAD, y1: g.y1 + PAD });
  }
  for (const el of elements) {
    if (el.cls === 'bus' || el.cls === 'line' || el.cls === 'trafo') continue;
    const b = buses.get(/** @type {string} */ (el.bus));
    if (!b) continue;
    const s = stub(el, b), r = 20;
    // The stub leaves the bar inside the bar's own padding; the symbol is the obstacle.
    out.push({ x0: s.centre.x - r - PAD / 2, y0: s.centre.y - r - PAD / 2, x1: s.centre.x + r + PAD / 2, y1: s.centre.y + r + PAD / 2 });
  }
  return out;
}

/** How long an orthogonal segment runs inside a rectangle. @param {Point} a @param {Point} b @param {Rect} r */
function inside(a, b, r) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const ox = Math.min(x1, r.x1) - Math.max(x0, r.x0), oy = Math.min(y1, r.y1) - Math.max(y0, r.y0);
  if (ox < 0 || oy < 0) return 0;
  return Math.max(ox, oy);
}

/**
 * Whether a route crosses an obstacle, its own bars included: running along a bar counts, leaving it at right angles
 * does not. Obstacles are compared unpadded. @param {Point[]} pts @param {Rect[]} obstacles
 */
export function blocked(pts, obstacles) {
  for (let i = 0; i < pts.length - 1; i++) {
    for (const o of obstacles) {
      const r = { x0: o.x0 + PAD - 3, y0: o.y0 + PAD - 3, x1: o.x1 - PAD + 3, y1: o.y1 - PAD + 3 };
      if (inside(pts[i], pts[i + 1], r) > GRAZE) return true;
    }
  }
  return false;
}

/** A binary heap of [cost, value] by cost. */
class Heap {
  constructor() {
    /** @type {Array<[number, number]>} */
    this.a = [];
  }
  get size() { return this.a.length; }
  /** @param {number} cost @param {number} value */
  push(cost, value) {
    const a = this.a;
    a.push([cost, value]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = /** @type {[number, number]} */ (a.pop());
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The shortest orthogonal path from S to E that enters no obstacle, counting bends, or null when none exists in
 * the searched area. @param {Point} S @param {Point} E @param {Rect[]} obstacles @returns {Point[] | null}
 */
export function orthogonalPath(S, E, obstacles) {
  const box = { x0: Math.min(S.x, E.x) - MARGIN, y0: Math.min(S.y, E.y) - MARGIN, x1: Math.max(S.x, E.x) + MARGIN, y1: Math.max(S.y, E.y) + MARGIN };
  const near = obstacles.filter(o => o.x1 > box.x0 && o.x0 < box.x1 && o.y1 > box.y0 && o.y0 < box.y1);
  const uniq = (/** @type {number[]} */ v) => [...new Set(v.map(x => Math.round(x * 1000) / 1000))].sort((p, q) => p - q);
  const xs = uniq([S.x, E.x, box.x0, box.x1, ...near.flatMap(o => [o.x0, o.x1])]).filter(x => x >= box.x0 && x <= box.x1);
  const ys = uniq([S.y, E.y, box.y0, box.y1, ...near.flatMap(o => [o.y0, o.y1])]).filter(y => y >= box.y0 && y <= box.y1);
  const nx = xs.length, ny = ys.length;
  // Every obstacle's edges are grid lines, so what it blocks is a range of indices: nodes strictly inside it, and
  // the grid edges whose middle lies inside it. Marked once, they make each test in the search a lookup.
  const blockedNode = new Uint8Array(nx * ny), blockedRight = new Uint8Array(nx * ny), blockedDown = new Uint8Array(nx * ny);
  /** The index of a coordinate in a sorted list (it is there). @param {number[]} v @param {number} x */
  const at = (v, x) => { let lo = 0, hi = v.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < x - 1e-6) lo = m + 1; else hi = m; } return lo; };
  for (const o of near) {
    const i0 = at(xs, Math.max(o.x0, box.x0)), i1 = at(xs, Math.min(o.x1, box.x1)), j0 = at(ys, Math.max(o.y0, box.y0)), j1 = at(ys, Math.min(o.y1, box.y1));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const n = j * nx + i, innerX = i > i0 && i < i1, innerY = j > j0 && j < j1;
        if (innerX && innerY) blockedNode[n] = 1;
        // The edge to the right runs inside when it starts within the obstacle's x range and lies strictly within y.
        if (i < i1 && innerY) blockedRight[n] = 1;
        if (j < j1 && innerX) blockedDown[n] = 1;
      }
    }
  }
  const node = (/** @type {number} */ i, /** @type {number} */ j) => j * nx + i;
  const si = xs.indexOf(Math.round(S.x * 1000) / 1000), sj = ys.indexOf(Math.round(S.y * 1000) / 1000);
  const ei = xs.indexOf(Math.round(E.x * 1000) / 1000), ej = ys.indexOf(Math.round(E.y * 1000) / 1000);
  if (si < 0 || sj < 0 || ei < 0 || ej < 0) return null;
  // States: node × direction of arrival (0 east, 1 west, 2 south, 3 north, 4 none at the start).
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const cost = new Float64Array(nx * ny * 5).fill(Infinity), from = new Int32Array(nx * ny * 5).fill(-1);
  const heap = new Heap(), start = node(si, sj) * 5 + 4;
  const h = (/** @type {number} */ i, /** @type {number} */ j) => Math.abs(xs[i] - E.x) + Math.abs(ys[j] - E.y);
  cost[start] = 0;
  heap.push(h(si, sj), start);
  let goal = -1;
  while (heap.size) {
    const [, st] = heap.pop(), n = Math.floor(st / 5), d = st % 5, i = n % nx, j = Math.floor(n / nx);
    if (i === ei && j === ej) { goal = st; break; }
    for (let k = 0; k < 4; k++) {
      const ii = i + DIRS[k][0], jj = j + DIRS[k][1];
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const nn = node(ii, jj);
      // The edge between n and nn: stored on its left or upper node.
      if (blockedNode[nn] || (k < 2 ? blockedRight[k === 0 ? n : nn] : blockedDown[k === 2 ? n : nn])) continue;
      const step = Math.abs(xs[ii] - xs[i]) + Math.abs(ys[jj] - ys[j]) + (d !== 4 && d !== k ? BEND : 0);
      const ns = nn * 5 + k, c = cost[st] + step;
      if (c < cost[ns] - 1e-9) { cost[ns] = c; from[ns] = st; heap.push(c + h(ii, jj), ns); }
    }
  }
  if (goal < 0) return null;
  const path = [];
  for (let st = goal; st >= 0; st = from[st]) { const n = Math.floor(st / 5); path.push({ x: xs[n % nx], y: ys[Math.floor(n / nx)] }); }
  return simplify(path.reverse());
}

/**
 * A route for a branch that avoids the obstacles, as the corners to store in its `route`, or null when the search
 * finds none. Each end leaves its bar at right angles on the side the current route leaves it.
 * @param {Element} el @param {Map<string, Element>} buses @param {Rect[]} obstacles @returns {Array<[number, number]> | null}
 */
export function avoidingRoute(el, buses, obstacles) {
  const k = branchKeys(el), a = buses.get(/** @type {string} */ (el[k.a])), b = buses.get(/** @type {string} */ (el[k.b]));
  if (!a || !b) return null;
  const A = attachPoint(a, /** @type {number} */ (el[k.pa])), B = attachPoint(b, /** @type {number} */ (el[k.pb]));
  const now = route(el, a, b);
  /** The stem's end: out of the bar at right angles, towards where the route goes now (or the other end).
   * @param {Point} P @param {Element} bus @param {Point} next @param {Point} other */
  const stem = (P, bus, next, other) => {
    const horizontal = bus.orient !== 'v';
    const towards = horizontal ? Math.sign(next.y - P.y) || Math.sign(other.y - P.y) || -1 : Math.sign(next.x - P.x) || Math.sign(other.x - P.x) || -1;
    return horizontal ? { x: P.x, y: P.y + towards * STEM } : { x: P.x + towards * STEM, y: P.y };
  };
  const S = stem(A, a, now[1] ?? B, B), E = stem(B, b, now[now.length - 2] ?? A, A);
  const path = orthogonalPath(S, E, obstacles);
  if (!path) return null;
  const pts = simplify([A, S, ...path.slice(1, -1), E, B]);
  return pts.slice(1, -1).map(p => /** @type {[number, number]} */ ([Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]));
}
