/** Operations that arrange a selection on the diagram (docs/design/CAD.md, section 6.3). Each returns the field
 * changes it makes, as [id, key, value]; the app applies them in one transaction, so each is one undoable step.
 * The first busbar given is the reference the others line up with or take after. No DOM access. */

import { bar } from '../render/geometry.js';
import { connectionPlaces } from './layout.js';

/**
 * @typedef {import('./catalog.js').Element} Element
 * @typedef {import('./document.js').PowerDocument} PowerDocument
 * @typedef {Array<[string, string, unknown]>} Changes
 * @typedef {'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom'} AlignMode
 */

/** A coordinate rounded to a thousandth of a unit, so arranged positions print cleanly. @param {number} v */
const tidy = v => Math.round(v * 1000) / 1000;

/**
 * Lines busbars up with the first one: their left, centre or right x, or their top, middle or bottom y.
 * @param {Element[]} buses @param {AlignMode} mode @returns {Changes}
 */
export function align(buses, mode) {
  const [ref, ...rest] = buses;
  if (!ref) return [];
  const r = bar(ref);
  /** The coordinate of a bar the mode lines up. @param {ReturnType<typeof bar>} g */
  const at = g => ({ left: g.x0, centre: (g.x0 + g.x1) / 2, right: g.x1, top: g.y0, middle: (g.y0 + g.y1) / 2, bottom: g.y1 })[mode];
  const key = mode === 'left' || mode === 'centre' || mode === 'right' ? 'x' : 'y';
  /** @type {Changes} */
  const out = [];
  for (const b of rest) {
    const shift = at(r) - at(bar(b));
    if (Math.abs(shift) > 1e-9) out.push([b.id, key, tidy(/** @type {number} */ (b[key]) + shift)]);
  }
  return out;
}

/**
 * Spaces busbars evenly along an axis, keeping the outermost two: equal gaps between their extents.
 * @param {Element[]} buses @param {'x' | 'y'} axis @returns {Changes}
 */
export function distribute(buses, axis) {
  if (buses.length < 3) return [];
  const lo = axis === 'x' ? 'x0' : 'y0', hi = axis === 'x' ? 'x1' : 'y1';
  const items = buses.map(b => ({ b, g: bar(b) })).sort((p, q) => (p.g[lo] + p.g[hi]) - (q.g[lo] + q.g[hi]));
  const first = items[0].g, last = items[items.length - 1].g;
  const sizes = items.reduce((s, it) => s + it.g[hi] - it.g[lo], 0);
  const gap = (last[hi] - first[lo] - sizes) / (items.length - 1);
  /** @type {Changes} */
  const out = [];
  let cursor = first[hi] + gap;
  for (const { b, g } of items.slice(1, -1)) {
    const shift = cursor - g[lo];
    if (Math.abs(shift) > 1e-9) out.push([b.id, axis, tidy(/** @type {number} */ (b[axis]) + shift)]);
    cursor += g[hi] - g[lo] + gap;
  }
  return out;
}

/** Gives every busbar the first one's length, about its own centre. @param {Element[]} buses @returns {Changes} */
export function sameLength(buses) {
  const [ref, ...rest] = buses;
  return ref ? rest.filter(b => b.len !== ref.len).map(b => [b.id, 'len', ref.len]) : [];
}

/**
 * Turns busbars between horizontal and vertical about their centres; connections keep their places along the bar.
 * @param {Element[]} buses @returns {Changes}
 */
export function rotate(buses) {
  return buses.map(b => [b.id, 'orient', b.orient === 'v' ? 'h' : 'v']);
}

/** Moves machines, grids, loads and shunts to the other side of their busbars. @param {Element[]} ports @returns {Changes} */
export function flip(ports) {
  return ports.filter(p => 'side' in p).map(p => [p.id, 'side', p.side === 'above' ? 'below' : 'above']);
}

/**
 * Spreads the connections of some busbars evenly along them, branch ends towards the far busbar, machines and grids
 * above, loads and shunts below (as Arrange does for the whole diagram, without moving anything else).
 * @param {PowerDocument} doc @param {Element[]} buses @returns {Changes}
 */
export function spreadConnections(doc, buses) {
  const byId = new Map(doc.elements.map(e => [e.id, e]));
  return connectionPlaces(doc, new Set(buses.map(b => b.id))).filter(([id, key, value]) => byId.get(id)?.[key] !== value);
}
