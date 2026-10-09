/** Single-line diagram geometry, shared by the scene builder, hit testing and SVG export.
 *
 * Busbars are bars of a given length, horizontal or vertical. Branches leave a bar at right angles, run an orthogonal
 * route with an adjustable middle segment and enter the other bar at right angles. Single-port elements (machines,
 * grids, loads, shunts) sit on a short stub on one side of their bar. All values are in world units; the grid step
 * is 20. */

/**
 * @typedef {import('../core/catalog.js').Element} Element
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ bus: Element, x0: number, y0: number, x1: number, y1: number, horizontal: boolean }} BarGeometry
 */

export const BAR_WIDTH = 6;
export const STUB = 44;
export const SYMBOL = 15;
const LOOP = 60;

/** @param {Element} bus @returns {BarGeometry} */
export function bar(bus) {
  const x = /** @type {number} */ (bus.x), y = /** @type {number} */ (bus.y), half = /** @type {number} */ (bus.len) / 2;
  const horizontal = bus.orient !== 'v';
  return horizontal ? { bus, x0: x - half, y0: y, x1: x + half, y1: y, horizontal } : { bus, x0: x, y0: y - half, x1: x, y1: y + half, horizontal };
}

/** Point at a relative position (−0.5 … 0.5) along a bar. @param {Element} bus @param {number} pos @returns {Point} */
export function attachPoint(bus, pos) {
  const p = Math.max(-0.5, Math.min(0.5, pos)) * /** @type {number} */ (bus.len);
  return bus.orient === 'v' ? { x: /** @type {number} */ (bus.x), y: /** @type {number} */ (bus.y) + p } : { x: /** @type {number} */ (bus.x) + p, y: /** @type {number} */ (bus.y) };
}

/** Relative position along a bar nearest to a world point. @param {Element} bus @param {Point} p */
export function positionOn(bus, p) {
  const len = /** @type {number} */ (bus.len);
  const d = bus.orient === 'v' ? p.y - /** @type {number} */ (bus.y) : p.x - /** @type {number} */ (bus.x);
  return Math.max(-0.5, Math.min(0.5, d / len));
}

/** The two bus keys and position keys of a branch. @param {Element} el */
export function branchKeys(el) {
  return el.cls === 'line' ? { a: 'from', b: 'to', pa: 'fromPos', pb: 'toPos' } : { a: 'hv', b: 'lv', pa: 'hvPos', pb: 'lvPos' };
}

/**
 * Orthogonal route of a branch between its two bars. The middle segment sits halfway between the bars, shifted by
 * the element's bend offset.
 * @param {Element} el @param {Element} busA @param {Element} busB @returns {Point[]}
 */
export function route(el, busA, busB) {
  const k = branchKeys(el);
  const A = attachPoint(busA, /** @type {number} */ (el[k.pa])), B = attachPoint(busB, /** @type {number} */ (el[k.pb]));
  const bend = /** @type {number} */ (el.bend) || 0;
  const ha = busA.orient !== 'v', hb = busB.orient !== 'v';
  if (ha && hb) {
    if (Math.abs(A.y - B.y) < 1e-6) {
      const y = A.y - LOOP + bend;
      return [A, { x: A.x, y }, { x: B.x, y }, B];
    }
    if (Math.abs(A.x - B.x) < 1e-6 && !bend) return [A, B];
    const y = (A.y + B.y) / 2 + bend;
    return [A, { x: A.x, y }, { x: B.x, y }, B];
  }
  if (!ha && !hb) {
    if (Math.abs(A.x - B.x) < 1e-6) {
      const x = A.x - LOOP + bend;
      return [A, { x, y: A.y }, { x, y: B.y }, B];
    }
    if (Math.abs(A.y - B.y) < 1e-6 && !bend) return [A, B];
    const x = (A.x + B.x) / 2 + bend;
    return [A, { x, y: A.y }, { x, y: B.y }, B];
  }
  return ha ? [A, { x: A.x, y: B.y }, B] : [A, { x: B.x, y: A.y }, B];
}

/** Index of the longest segment of a polyline, and its midpoint and unit direction. @param {Point[]} pts */
export function longestSegment(pts) {
  let best = 0, len = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (l > len) { len = l; best = i; }
  }
  const a = pts[best], b = pts[best + 1] ?? a, l = Math.max(len, 1e-9);
  return { index: best, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l }, length: len };
}

/** Where the middle segment's drag handle sits and which axis it moves on. @param {Point[]} pts */
export function bendHandle(pts) {
  if (pts.length < 4) return null;
  const a = pts[1], b = pts[2];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, axis: Math.abs(a.y - b.y) < 1e-6 ? 'y' : 'x' };
}

/**
 * Stub and symbol centre of a single-port element. "above" means up for a horizontal bar and left for a vertical one.
 * @param {Element} el @param {Element} bus
 */
export function stub(el, bus) {
  const p = attachPoint(bus, /** @type {number} */ (el.pos));
  const sign = el.side === 'above' ? -1 : 1;
  const d = bus.orient === 'v' ? { x: sign, y: 0 } : { x: 0, y: sign };
  const end = { x: p.x + d.x * STUB, y: p.y + d.y * STUB };
  const centre = { x: p.x + d.x * (STUB + SYMBOL), y: p.y + d.y * (STUB + SYMBOL) };
  return { from: p, to: end, centre, dir: d };
}

/** Distance from a point to a segment. @param {Point} p @param {Point} a @param {Point} b */
export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Bounding box of the drawing. @param {Element[]} elements */
export function bounds(elements) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of elements) {
    if (el.cls !== 'bus') continue;
    const g = bar(el);
    x0 = Math.min(x0, g.x0); x1 = Math.max(x1, g.x1);
    y0 = Math.min(y0, g.y0 - 110); y1 = Math.max(y1, g.y1 + 110);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: -400, y0: -300, x1: 400, y1: 300 };
}
