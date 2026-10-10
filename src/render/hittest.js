/** Hit testing on the diagram, in world coordinates, independent of the rendering backend. */

import { bar, route, stub, branchKeys, bendHandle, distToSegment, BAR_WIDTH, SYMBOL } from './geometry.js';

/** @typedef {import('../core/catalog.js').Element} Element
 * @typedef {{ id: string, part: 'body' | 'end0' | 'end1' | 'bend' | 'endA' | 'endB' }} Hit */

/**
 * Where elements are drawn, for finding the few near a point among a national network's. Everything on a single-line
 * diagram is orthogonal: busbars, branch routes and the stubs of single-port elements are horizontal or vertical
 * segments. Horizontal ones are kept sorted by height and vertical ones by position, so a point looks at the band of
 * segments near it. Built once per document revision.
 */
export class HitIndex {
  /** @param {Element[]} elements */
  constructor(elements) {
    this.elements = elements;
    /** @type {Map<string, Element>} */
    this.buses = new Map(elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
    const h = new SegmentList(), v = new SegmentList();
    /** @param {{ x: number, y: number }} p @param {{ x: number, y: number }} q @param {number} i */
    const add = (p, q, i) => {
      if (p.y === q.y) h.push(p.y, Math.min(p.x, q.x), Math.max(p.x, q.x), i);
      else if (p.x === q.x) v.push(p.x, Math.min(p.y, q.y), Math.max(p.y, q.y), i);
      else {
        // A slanted segment (not drawn by the editor, but possible in a document) is covered by its bounding box's
        // vertical extent at both ends' positions.
        v.push(p.x, Math.min(p.y, q.y), Math.max(p.y, q.y), i);
        v.push(q.x, Math.min(p.y, q.y), Math.max(p.y, q.y), i);
        h.push(p.y, Math.min(p.x, q.x), Math.max(p.x, q.x), i);
      }
    };
    elements.forEach((el, i) => {
      if (el.cls === 'bus') {
        const g = bar(el);
        add({ x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 }, i);
      } else if (el.cls === 'line' || el.cls === 'trafo') {
        const k = branchKeys(el), a = this.buses.get(/** @type {string} */ (el[k.a])), b = this.buses.get(/** @type {string} */ (el[k.b]));
        if (!a || !b) return;
        const pts = route(el, a, b);
        for (let j = 1; j < pts.length; j++) add(pts[j - 1], pts[j], i);
      } else {
        const b = this.buses.get(/** @type {string} */ (el.bus));
        if (b) { const s = stub(el, b); add(s.from, s.centre, i); }
      }
    });
    this.h = h.sorted();
    this.v = v.sorted();
  }

  /** The elements near a point, in document order. @param {{ x: number, y: number }} p @param {number} r */
  near(p, r) {
    const seen = new Set();
    // The margin covers a busbar's width, a symbol's radius, a transformer's circles and the quarter unit positions are
    // kept to.
    const m = r + SYMBOL + 12.25;
    for (const [list, along, across] of /** @type {const} */ ([[this.h, p.x, p.y], [this.v, p.y, p.x]])) {
      for (let k = list.lowerBound(across - m); k < list.n && list.pos[k] <= across + m; k++) {
        if (along >= list.from[k] - m && along <= list.to[k] + m) seen.add(list.el[k]);
      }
    }
    return [...seen].sort((a, b) => a - b).map(i => this.elements[i]);
  }
}

/** Axis-aligned segments in columns: position across the segment, its extent along it, and its element. */
class SegmentList {
  constructor() {
    /** @type {number[]} */
    this.raw = [];
    this.n = 0;
    this.pos = new Float64Array(0);
    this.from = new Float64Array(0);
    this.to = new Float64Array(0);
    this.el = new Int32Array(0);
  }

  /** @param {number} pos @param {number} from @param {number} to @param {number} el */
  push(pos, from, to, el) { this.raw.push(pos, from, to, el); }

  /** Sorts by position into the columns. Positions are kept to a quarter of a unit, which lets one native numeric
   * sort order them with their index packed in (a comparator sort of a national diagram's segments takes too long). */
  sorted() {
    const n = this.raw.length / 4, raw = this.raw, SLOTS = 1 << 21;
    let qmin = Infinity, qmax = -Infinity;
    for (let k = 0; k < n; k++) { const q = Math.round(raw[4 * k] * 4); qmin = Math.min(qmin, q); qmax = Math.max(qmax, q); }
    this.n = n;
    this.pos = new Float64Array(n); this.from = new Float64Array(n); this.to = new Float64Array(n); this.el = new Int32Array(n);
    /** @param {number} j @param {number} k @param {number} pos */
    const put = (j, k, pos) => { const o = 4 * k; this.pos[j] = pos; this.from[j] = raw[o + 1]; this.to[j] = raw[o + 2]; this.el[j] = raw[o + 3]; };
    if (n < SLOTS && (qmax - qmin + 1) * SLOTS < Number.MAX_SAFE_INTEGER) {
      const keys = new Float64Array(n);
      for (let k = 0; k < n; k++) keys[k] = (Math.round(raw[4 * k] * 4) - qmin) * SLOTS + k;
      keys.sort();
      for (let j = 0; j < n; j++) { const k = keys[j] % SLOTS; put(j, k, ((keys[j] - k) / SLOTS + qmin) / 4); }
    } else {
      // Beyond what the packed keys hold exactly: the slower comparator sort.
      const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => raw[4 * a] - raw[4 * b]);
      order.forEach((k, j) => put(j, k, raw[4 * k]));
    }
    this.raw = [];
    return this;
  }

  /** The first segment at or beyond a position. @param {number} x */
  lowerBound(x) {
    let lo = 0, hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pos[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
}



/**
 * Finds what is under a point. Handles of a single selected element win, then symbols, busbars and branches. With an
 * index, only the elements near the point are looked at.
 * @param {Element[]} elements @param {{ x: number, y: number }} p @param {number} zoom @param {Set<string>} selection
 * @param {HitIndex} [index]
 * @returns {Hit | null}
 */
export function hitTest(elements, p, zoom, selection, index) {
  const tol = 6 / zoom;
  const buses = index?.buses ?? new Map(elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
  if (index) elements = index.near(p, tol + 16);
  if (selection.size === 1) {
    const el = elements.find(e => selection.has(e.id));
    if (el?.cls === 'bus') {
      const g = bar(el);
      if (Math.hypot(p.x - g.x0, p.y - g.y0) < tol + 4) return { id: el.id, part: 'end0' };
      if (Math.hypot(p.x - g.x1, p.y - g.y1) < tol + 4) return { id: el.id, part: 'end1' };
    } else if (el && (el.cls === 'line' || el.cls === 'trafo')) {
      const k = branchKeys(el), a = buses.get(/** @type {string} */ (el[k.a])), b = buses.get(/** @type {string} */ (el[k.b]));
      if (a && b) {
        const pts = route(el, a, b), hb = bendHandle(pts);
        if (hb && Math.hypot(p.x - hb.x, p.y - hb.y) < tol + 4) return { id: el.id, part: 'bend' };
        if (Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < tol + 3) return { id: el.id, part: 'endA' };
        const z = pts[pts.length - 1];
        if (Math.hypot(p.x - z.x, p.y - z.y) < tol + 3) return { id: el.id, part: 'endB' };
      }
    }
  }
  // Symbols first: they sit on top of stubs and bars.
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.cls === 'bus' || el.cls === 'line' || el.cls === 'trafo') continue;
    const b = buses.get(/** @type {string} */ (el.bus));
    if (!b) continue;
    const s = stub(el, b);
    if (Math.hypot(p.x - s.centre.x, p.y - s.centre.y) < SYMBOL + tol || distToSegment(p, s.from, s.to) < tol) return { id: el.id, part: 'body' };
  }
  for (const b of index ? elements.filter(e => e.cls === 'bus') : buses.values()) {
    const g = bar(b);
    if (distToSegment(p, { x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 }) < BAR_WIDTH / 2 + tol) return { id: b.id, part: 'body' };
  }
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.cls !== 'line' && el.cls !== 'trafo') continue;
    const k = branchKeys(el), a = buses.get(/** @type {string} */ (el[k.a])), b = buses.get(/** @type {string} */ (el[k.b]));
    if (!a || !b) continue;
    const pts = route(el, a, b);
    for (let j = 0; j < pts.length - 1; j++) if (distToSegment(p, pts[j], pts[j + 1]) < tol + 2) return { id: el.id, part: 'body' };
  }
  return null;
}

/** Elements whose anchor lies inside a world rectangle (marquee selection). @param {Element[]} elements
 * @param {{ x0: number, y0: number, x1: number, y1: number }} r @returns {string[]} */
export function inRect(elements, r) {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  const inside = (/** @type {{ x: number, y: number }} */ p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const buses = new Map(elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
  const out = [];
  for (const el of elements) {
    if (el.cls === 'bus') { if (inside({ x: /** @type {number} */ (el.x), y: /** @type {number} */ (el.y) })) out.push(el.id); continue; }
    if (el.cls === 'line' || el.cls === 'trafo') {
      const k = branchKeys(el), a = buses.get(/** @type {string} */ (el[k.a])), b = buses.get(/** @type {string} */ (el[k.b]));
      if (!a || !b) continue;
      const pts = route(el, a, b);
      if (pts.every(inside)) out.push(el.id);
      continue;
    }
    const b = buses.get(/** @type {string} */ (el.bus));
    if (b && inside(stub(el, b).centre)) out.push(el.id);
  }
  return out;
}
