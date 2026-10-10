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
 * Orthogonal route of a branch between its two bars. A manual route (corners in the element's `route`) keeps its
 * corners, repaired so it still leaves and enters its bars at right angles wherever they have moved (`orthogonal`).
 * An automatic one has its middle segment halfway between the bars, shifted by the element's bend offset.
 * @param {Element} el @param {Element} busA @param {Element} busB @returns {Point[]}
 */
export function route(el, busA, busB) {
  const k = branchKeys(el);
  const A = attachPoint(busA, /** @type {number} */ (el[k.pa])), B = attachPoint(busB, /** @type {number} */ (el[k.pb]));
  const ha = busA.orient !== 'v', hb = busB.orient !== 'v';
  const corners = /** @type {Array<[number, number]> | undefined} */ (el.route);
  if (corners?.length) return orthogonal(A, B, ha, hb, corners);
  const bend = /** @type {number} */ (el.bend) || 0;
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

/**
 * An orthogonal route from A to B through corners as near as can be to the ones given: it leaves A at right angles
 * to A's bar, turns at each corner, and enters B at right angles to B's bar. Each corner keeps the coordinate its
 * incoming segment leaves free, so when a bar moves the corners next to it slide along their segments; a corner is
 * added where the turns do not come out right, and corners that make no turn are dropped.
 * @param {Point} A @param {Point} B @param {boolean} aHorizontal @param {boolean} bHorizontal
 * @param {Array<[number, number]>} corners @returns {Point[]}
 */
export function orthogonal(A, B, aHorizontal, bHorizontal, corners) {
  const pts = [A];
  // Whether the next segment runs vertically: the first leaves a horizontal bar vertically.
  let vertical = aHorizontal, prev = A;
  for (const [x, y] of corners) {
    prev = vertical ? { x: prev.x, y } : { x, y: prev.y };
    // The first corner stands clear of A's bar, so the route never leaves along the bar; the corners after it take
    // their positions from it.
    if (pts.length === 1) prev = clear(prev, A, aHorizontal, { x, y });
    pts.push(prev);
    vertical = !vertical;
  }
  if (vertical === bHorizontal) {
    // The last segment runs the right way: line its start up with B across it (that coordinate is free).
    const last = pts[pts.length - 1];
    if (pts.length > 1) pts[pts.length - 1] = bHorizontal ? { x: B.x, y: last.y } : { x: last.x, y: B.y };
  } else {
    pts.push(bHorizontal ? { x: B.x, y: prev.y } : { x: prev.x, y: B.y });
  }
  // The last corner stands clear of B's bar too: the segment before it runs parallel to the bar, so it moves out as a
  // whole (a segment leaving A stays, as A's exit).
  const k = pts.length - 1;
  if (k >= 2) {
    const key = bHorizontal ? 'y' : 'x', moved = clear(pts[k], B, bHorizontal, pts[k - 1]);
    if (moved[key] !== pts[k][key]) { pts[k] = moved; pts[k - 1] = { ...pts[k - 1], [key]: moved[key] }; }
  }
  pts.push(B);
  // Corners that double back can cancel out, leaving a route that sets off along its bar: lift such an end clear.
  return lift(lift(simplify(pts), aHorizontal).reverse(), bHorizontal).reverse();
}

/**
 * A route whose first segment runs along its bar, moved out to STEM_MIN from the bar: it leaves the bar at right
 * angles, runs parallel, and rejoins where that segment ended. @param {Point[]} pts @param {boolean} horizontal
 * the first point's bar @returns {Point[]}
 */
function lift(pts, horizontal) {
  const [A, p1, p2] = pts, key = horizontal ? 'y' : 'x';
  if (!p1 || !p2 || Math.abs(p1[key] - A[key]) > 1e-9) return pts;
  const v = A[key] + (Math.sign(p2[key] - A[key]) || -1) * STEM_MIN;
  return simplify([A, { ...A, [key]: v }, { ...p1, [key]: v }, ...pts.slice(2)]);
}

/** Least distance between a bar and the corner where a route leaving it at right angles turns. */
const STEM_MIN = 10;

/**
 * A corner moved out to at least STEM_MIN from the bar through E, across the bar, towards `towards` when it lies on
 * the bar's line. @param {Point} c @param {Point} E @param {boolean} horizontal the bar's orientation @param {Point} towards
 */
function clear(c, E, horizontal, towards) {
  const key = horizontal ? 'y' : 'x', d = c[key] - E[key];
  if (Math.abs(d) >= STEM_MIN) return c;
  const out = { ...c };
  out[key] = E[key] + (Math.sign(d) || Math.sign(towards[key] - E[key]) || -1) * STEM_MIN;
  return out;
}

/** A polyline without repeated points or corners that make no turn (a route that doubles back loses the spike).
 * @param {Point[]} pts @returns {Point[]} */
export function simplify(pts) {
  const same = (/** @type {Point} */ a, /** @type {Point} */ b) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  const straight = (/** @type {Point} */ a, /** @type {Point} */ b, /** @type {Point} */ c) =>
    (Math.abs(a.x - b.x) < 1e-9 && Math.abs(b.x - c.x) < 1e-9) || (Math.abs(a.y - b.y) < 1e-9 && Math.abs(b.y - c.y) < 1e-9);
  /** @type {Point[]} */
  const out = [];
  for (const p of pts) {
    out.push(p);
    // Each removal can make the new tail repeat or run straight, so clean it until it is settled.
    for (let n = out.length; ; n = out.length) {
      if (n >= 2 && same(out[n - 1], out[n - 2])) out.splice(n - 2, 1);
      else if (n >= 3 && straight(out[n - 3], out[n - 2], out[n - 1])) out.splice(n - 2, 1);
      else break;
    }
  }
  return out;
}

/** Each segment's middle and the axis a drag moves it along (x for a vertical segment). @param {Point[]} pts
 * @returns {Array<{ index: number, x: number, y: number, axis: 'x' | 'y', length: number }>} */
export function segmentHandles(pts) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (length < 1e-9) continue;
    out.push({ index: i, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, axis: /** @type {'x' | 'y'} */ (Math.abs(a.x - b.x) < 1e-9 ? 'x' : 'y'), length });
  }
  return out;
}

/** @param {number} v */
const round3 = v => Math.round(v * 1000) / 1000;

/** Corners for a branch's `route`. @param {Point[]} corners @returns {Array<[number, number]>} */
const stored = corners => corners.map(p => /** @type {[number, number]} */ ([round3(p.x), round3(p.y)]));

/** How far a jog sits from the bar it leaves, at most. */
const JOG = 20;

/**
 * The corners of a route after moving segment `i` by `d` across itself. An inner segment moves with its two corners
 * and the segments either side stretch; the first or last segment, which must meet its bar at right angles, gets a
 * jog: a short stem from the bar, a step across, and the rest moved.
 * @param {Point[]} pts the route, ends included @param {number} i @param {number} d @returns {Array<[number, number]>}
 */
export function moveSegment(pts, i, d) {
  const P = pts.map(p => ({ ...p })), n = P.length - 1;
  const a = P[i], b = P[i + 1], key = Math.abs(a.x - b.x) < 1e-9 ? 'x' : 'y', along = key === 'x' ? 'y' : 'x';
  if (i > 0 && i < n - 1) {
    a[key] += d; b[key] += d;
    return stored(P.slice(1, -1));
  }
  /** A stem from end E towards point T, and the step across from it. @param {Point} E @param {Point} T */
  const jog = (E, T) => {
    const span = T[along] - E[along], stem = { ...E };
    stem[along] = E[along] + Math.sign(span || 1) * Math.min(JOG, Math.abs(span) / 2);
    const across = { ...stem };
    across[key] += d;
    return [stem, across];
  };
  if (n === 1) {
    const [s1, a1] = jog(P[0], P[1]), [s2, a2] = jog(P[1], P[0]);
    return stored([s1, a1, a2, s2]);
  }
  if (i === 0) {
    const next = { ...P[1] };
    next[key] += d;
    return stored([...jog(P[0], P[1]), next, ...P.slice(2, -1)]);
  }
  const prev = { ...P[n - 1] };
  prev[key] += d;
  const [stem, across] = jog(P[n], P[n - 1]);
  return stored([...P.slice(1, n - 1), prev, across, stem]);
}

/**
 * The corners of a route without segment `i`: its corners are dropped and the route repaired around them, which
 * takes out a jog. @param {Point[]} pts @param {number} i @returns {Array<[number, number]>}
 */
export function removeSegment(pts, i) {
  // Corner k is point k + 1; the ends are not corners, so a first or last segment loses only its inner corner.
  return stored(pts.slice(1, -1).filter((_, k) => k + 1 !== i && k + 1 !== i + 1));
}

/**
 * The handles a selected branch shows on its route: one in the middle of each segment long enough to hold one at
 * this zoom. On an automatic route the middle segment's handle sets the bend offset (`bend`); every other handle
 * shapes the route by hand. @param {Element} el @param {Point[]} pts @param {number} zoom
 */
export function routeHandles(el, pts, zoom) {
  const automatic = !(/** @type {unknown[] | undefined} */ (el.route)?.length);
  return segmentHandles(pts).filter(h => h.length * zoom >= 24).map(h => ({ ...h, bend: automatic && pts.length === 4 && h.index === 1 }));
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
