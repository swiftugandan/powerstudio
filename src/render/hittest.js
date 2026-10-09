/** Hit testing on the diagram, in world coordinates, independent of the rendering backend. */

import { bar, route, stub, branchKeys, bendHandle, distToSegment, BAR_WIDTH, SYMBOL } from './geometry.js';

/** @typedef {import('../core/catalog.js').Element} Element
 * @typedef {{ id: string, part: 'body' | 'end0' | 'end1' | 'bend' | 'endA' | 'endB' }} Hit */

/**
 * Finds what is under a point. Handles of a single selected element win, then symbols, busbars and branches.
 * @param {Element[]} elements @param {{ x: number, y: number }} p @param {number} zoom @param {Set<string>} selection
 * @returns {Hit | null}
 */
export function hitTest(elements, p, zoom, selection) {
  const tol = 6 / zoom;
  const buses = new Map(elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
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
  for (const b of buses.values()) {
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
