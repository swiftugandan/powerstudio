/** Builds the display list of the single-line diagram from the document, the result annotations and the editor state. */

import { DisplayList, withAlpha } from './displaylist.js';
import { bar, route, longestSegment, stub, bendHandle, branchKeys, BAR_WIDTH, SYMBOL } from './geometry.js';

/**
 * @typedef {import('./displaylist.js').RGBA} RGBA
 * @typedef {import('../core/catalog.js').Element} Element
 * @typedef {{ bg: RGBA, grid: RGBA, ink: RGBA, muted: RGBA, select: RGBA, hover: RGBA, label: RGBA, labelMuted: RGBA,
 *   boxBg: RGBA, boxBorder: RGBA, boxText: RGBA, kv: { ehv: RGBA, hv: RGBA, mv: RGBA, lv: RGBA }, fault: RGBA, preview: RGBA }} Palette
 * @typedef {{ color?: RGBA, box?: string[], ends?: [string, string], mid?: string, dim?: boolean, alert?: boolean }} Annotation
 *   `alert` marks a violation (an overload, a voltage outside its band), which shows at every zoom
 * @typedef {{ elements: Map<string, Annotation>, faultAt: string, deenergized: Set<string> }} Overlay
 * @typedef {{ kind: 'rubber', from: { x: number, y: number }, to: { x: number, y: number } }
 *   | { kind: 'marquee', x0: number, y0: number, x1: number, y1: number }
 *   | { kind: 'ghost-bus', x: number, y: number, len: number }
 *   | { kind: 'ghost-port', cls: string, bus: string, pos: number, side: 'above' | 'below' }} Preview
 * @typedef {{ elements: Element[], palette: Palette, selection: Set<string>, hover: string, overlay: Overlay | null,
 *   preview: Preview | null, labels: { names: boolean, branchNames: boolean, boxes: boolean } }} SceneInput
 */

const BRANCH_W = 2.2, STUB_W = 2;
const MONO = 11;
/** Elements from which a diagram draws its lower voltage levels only as the view comes closer. */
const LOD_FROM = 5000;
/** Screen pixels of line per pixel of drawing at which the next voltage level comes in. */
const LOD_DENSITY = 0.1;
/** On-screen radius in pixels from which symbols of a large diagram show. */
const SYMBOL_MIN_PX = 3;

/**
 * The zoom from which each voltage level of a large diagram shows, or null for a diagram drawn whole at every zoom.
 * Levels come in from the highest down: a level shows once the lines and busbars of it and every higher level would
 * cover no more than LOD_DENSITY of the drawing on screen. A branch belongs to the lower voltage of its ends, so it
 * never shows without both its busbars. The highest level shows at every zoom.
 * @param {Element[]} elements @param {Map<string, Element>} buses @returns {Map<number, number> | null}
 */
export function levelZooms(elements, buses) {
  if (elements.length < LOD_FROM) return null;
  /** @type {Map<number, number>} line length per voltage level */
  const ink = new Map();
  const add = (/** @type {number} */ kv, /** @type {number} */ len) => ink.set(kv, (ink.get(kv) ?? 0) + len);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const b of buses.values()) {
    const x = /** @type {number} */ (b.x), y = /** @type {number} */ (b.y);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    add(/** @type {number} */ (b.vn), /** @type {number} */ (b.len) || 0);
  }
  for (const el of elements) {
    if (el.cls !== 'line' && el.cls !== 'trafo') continue;
    const k = branchKeys(el), a = buses.get(/** @type {string} */ (el[k.a])), b = buses.get(/** @type {string} */ (el[k.b]));
    if (!a || !b) continue;
    // Routes are orthogonal, so their length is close to the distance along the axes.
    add(Math.min(/** @type {number} */ (a.vn), /** @type {number} */ (b.vn)), Math.abs(/** @type {number} */ (a.x) - /** @type {number} */ (b.x)) + Math.abs(/** @type {number} */ (a.y) - /** @type {number} */ (b.y)));
  }
  const area = Math.max(x1 - x0, 1) * Math.max(y1 - y0, 1);
  /** @type {Map<number, number>} */
  const zooms = new Map();
  let total = 0;
  for (const kv of [...ink.keys()].sort((p, q) => q - p)) {
    total += /** @type {number} */ (ink.get(kv));
    zooms.set(kv, zooms.size ? total / (area * LOD_DENSITY) : 0);
  }
  return zooms;
}

/** Colour for a nominal voltage. @param {Palette} p @param {number} kv */
export function kvColor(p, kv) {
  return kv >= 200 ? p.kv.ehv : kv >= 60 ? p.kv.hv : kv >= 1 ? p.kv.mv : p.kv.lv;
}

/**
 * The diagram itself: elements, result colours, labels and result boxes. It does not depend on the zoom (result boxes
 * and halos carry the zoom at which they show) or on the selection, so panning, zooming and selecting never rebuild
 * it; `buildOverlay` draws what does change with them.
 * @param {SceneInput} input @returns {DisplayList}
 */
export function buildScene(input) {
  const steps = sceneSteps(input);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/** Elements built between two pauses of `sceneSteps`. */
const STEP = 2048;

/**
 * `buildScene` in steps: it pauses after every few thousand elements, so the viewport can spread the build of a
 * national diagram over several frames instead of holding the page.
 * @param {SceneInput} input @returns {Generator<void, DisplayList, void>}
 */
export function* sceneSteps(input) {
  const { elements, palette: P, overlay, labels } = input;
  let done = 0;
  const list = new DisplayList(4);
  const buses = new Map(elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
  const ann = overlay?.elements ?? new Map();
  const dead = overlay?.deenergized ?? new Set();
  /** @param {Element} el @param {RGBA} base */
  const colorOf = (el, base) => {
    if (el.inService === false) return P.muted;
    const a = ann.get(el.id);
    if (a?.dim) return P.muted;
    return a?.color ?? base;
  };
  const dash = (/** @type {Element} */ el) => (el.inService === false ? 6 : 0);
  // A large diagram draws its lower voltage levels, and its symbols, only once there is room for them; violations
  // show at every zoom.
  const lod = levelZooms(elements, buses);
  list.levels = lod;
  /** @param {Element} el @param {number} kv @param {number} [floor] */
  const showFrom = (el, kv, floor = 0) => (!lod || ann.get(el.id)?.alert ? 0 : Math.max(lod.get(kv) ?? 0, floor));
  const symbolFloor = SYMBOL_MIN_PX / SYMBOL;

  // Branches.
  list.layer(1);
  for (const el of elements) {
    if (++done % STEP === 0) yield;
    if (el.cls !== 'line' && el.cls !== 'trafo') continue;
    const k = branchKeys(el), a = buses.get(/** @type {string} */ (el[k.a])), b = buses.get(/** @type {string} */ (el[k.b]));
    if (!a || !b) continue;
    const pts = route(el, a, b);
    list.minZoom = showFrom(el, Math.min(/** @type {number} */ (a.vn), /** @type {number} */ (b.vn)));
    const ca = colorOf(el, kvColor(P, /** @type {number} */ (a.vn))), cb = colorOf(el, kvColor(P, /** @type {number} */ (b.vn)));
    const seg = longestSegment(pts);
    if (el.cls === 'line') {
      list.polyline(pts, BRANCH_W, ca, dash(el));
    } else {
      // The HV half of the route takes the HV colour, the LV half the LV colour, split at the symbol.
      const r = 9, off = 6;
      const c1 = { x: seg.mid.x - seg.dir.x * off, y: seg.mid.y - seg.dir.y * off }, c2 = { x: seg.mid.x + seg.dir.x * off, y: seg.mid.y + seg.dir.y * off };
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        if (i < seg.index) list.segment(p.x, p.y, q.x, q.y, BRANCH_W, ca, dash(el));
        else if (i > seg.index) list.segment(p.x, p.y, q.x, q.y, BRANCH_W, cb, dash(el));
        else { list.segment(p.x, p.y, seg.mid.x, seg.mid.y, BRANCH_W, ca, dash(el)); list.segment(seg.mid.x, seg.mid.y, q.x, q.y, BRANCH_W, cb, dash(el)); }
      }
      list.circle(c1.x, c1.y, r, P.bg, ca, 2);
      list.circle(c2.x, c2.y, r, withAlpha(P.bg, 0), cb, 2);
    }
    const a2 = ann.get(el.id);
    if (labels.branchNames && el.name) {
      const nx = -seg.dir.y, ny = seg.dir.x;
      list.text(seg.mid.x + nx * 16, seg.mid.y + ny * 16, el.name, 10, P.labelMuted, { align: Math.abs(nx) > 0.5 ? (nx > 0 ? 0 : 1) : 0.5, minPx: 8 });
    }
    if (a2 && labels.boxes) {
      list.layer(3);
      if (a2.mid) {
        const nx = -seg.dir.y, ny = seg.dir.x, side = Math.abs(nx) > 0.5 ? (nx > 0 ? 0 : 1) : 0.5;
        box(list, P, seg.mid.x + nx * 14 + (el.cls === 'trafo' ? nx * 10 : 0), seg.mid.y + ny * 14 + (el.cls === 'trafo' ? ny * 10 : 0), [a2.mid], side, a2.color);
      }
      if (a2.ends) {
        for (const [i, text] of a2.ends.entries()) {
          if (!text) continue;
          const p = i === 0 ? pts[0] : pts[pts.length - 1], q = i === 0 ? pts[1] : pts[pts.length - 2];
          const l = Math.hypot(q.x - p.x, q.y - p.y) || 1, dx = (q.x - p.x) / l, dy = (q.y - p.y) / l;
          const lines = text.split('\n');
          const hb = lines.length * 9.5 * 1.24 + 4;
          box(list, P, p.x + dx * 12 + (Math.abs(dy) > 0.5 ? 5 : 0), p.y + dy * (12 + hb / 2) + (Math.abs(dx) > 0.5 ? -hb / 2 - 4 : 0), lines, 0, undefined, 9.5);
        }
      }
      list.layer(1);
    }
    list.minZoom = 0;
  }

  // Single-port elements.
  for (const el of elements) {
    if (++done % STEP === 0) yield;
    if (el.cls === 'bus' || el.cls === 'line' || el.cls === 'trafo') continue;
    const b = buses.get(/** @type {string} */ (el.bus));
    if (!b) continue;
    const s = stub(el, b);
    const c = colorOf(el, el.cls === 'gen' || el.cls === 'extgrid' ? P.ink : kvColor(P, /** @type {number} */ (b.vn)));
    list.minZoom = showFrom(el, /** @type {number} */ (b.vn), symbolFloor);
    list.segment(s.from.x, s.from.y, s.to.x, s.to.y, STUB_W, c, dash(el));
    drawSymbol(list, P, el.cls, s.centre, s.dir, c, /** @type {number} */ (el.q));
    const lx = s.centre.x + (b.orient === 'v' ? 0 : SYMBOL + 8), ly = s.centre.y + (b.orient === 'v' ? SYMBOL + 12 : 0);
    if (labels.names && el.name) list.text(lx, ly, el.name, 12, el.inService === false ? P.labelMuted : P.label, { align: b.orient === 'v' ? 0.5 : 0, minPx: el.cls === 'gen' || el.cls === 'extgrid' ? 4 : 6 });
    const a = ann.get(el.id);
    if (a?.box && labels.boxes) {
      list.layer(3);
      const hb = a.box.length * MONO * 1.24 + 4;
      box(list, P, lx, ly + 9 + hb / 2, a.box, 0, undefined);
      list.layer(1);
    }
    list.minZoom = 0;
  }

  // Busbars on top of the connections that end on them.
  list.layer(2);
  for (const el of elements) {
    if (++done % STEP === 0) yield;
    if (el.cls !== 'bus') continue;
    const g = bar(el);
    const c = dead.has(el.id) ? P.muted : colorOf(el, kvColor(P, /** @type {number} */ (el.vn)));
    list.minZoom = showFrom(el, /** @type {number} */ (el.vn));
    list.segment(g.x0, g.y0, g.x1, g.y1, BAR_WIDTH, c);
    if (labels.names) {
      // Names sit above the start of the bar on a soft halo, clear of connections that leave the bar ends.
      if (g.horizontal) halo(list, P, g.x0, g.y0 - 15, el.name || el.id, 14, 0);
      else halo(list, P, g.x0 + 10, g.y0 + 4, el.name || el.id, 14, 0);
    }
    const a = ann.get(el.id);
    if (a?.box && labels.boxes) {
      list.layer(3);
      const hBox = a.box.length * MONO * 1.24 + 4;
      if (g.horizontal) box(list, P, g.x1, g.y1 + 9 + hBox / 2, a.box, 1, a.color);
      else box(list, P, g.x1 + 10, g.y1 - hBox / 2, a.box, 0, a.color);
      list.layer(2);
    }
    list.minZoom = 0;
    if (overlay?.faultAt === el.id) bolt(list, g.horizontal ? (g.x0 + g.x1) / 2 : g.x0 + 18, g.horizontal ? g.y0 - 20 : (g.y0 + g.y1) / 2, P.fault);
  }

  return list;
}

/**
 * What changes with the editor's state: highlights of the selection and the hovered element (drawn under the
 * diagram, layer 0) and the selection's handles and the tool's preview (drawn over it, layer 1).
 * @param {SceneInput} input @returns {DisplayList}
 */
export function buildOverlay(input) {
  const { elements, palette: P, selection, hover, preview } = input;
  const list = new DisplayList(2);
  const marked = selection.size + (hover ? 1 : 0);
  // Only the elements involved are looked at, so a large selection on a large network stays cheap.
  const involved = marked ? elements.filter(e => selection.has(e.id) || e.id === hover) : [];
  /** @type {Set<unknown>} the busbars the highlights and the preview need */
  const needs = new Set(involved.flatMap(e => (e.cls === 'line' || e.cls === 'trafo' ? [e[branchKeys(e).a], e[branchKeys(e).b]] : [e.bus])));
  if (preview?.kind === 'ghost-port') needs.add(preview.bus);
  const buses = new Map(needs.size ? elements.filter(e => e.cls === 'bus' && needs.has(e.id)).map(b => [b.id, b]) : []);
  list.layer(0);
  for (const el of involved) {
    const sel = selection.has(el.id), hov = hover === el.id;
    if (!sel && !hov) continue;
    const c = sel ? withAlpha(P.select, 0.32) : withAlpha(P.hover, 0.22), w = sel ? 14 : 11;
    if (el.cls === 'bus') { const g = bar(el); list.segment(g.x0, g.y0, g.x1, g.y1, BAR_WIDTH + w, c); }
    else if (el.cls === 'line' || el.cls === 'trafo') {
      const k = branchKeys(el), a = buses.get(/** @type {string} */ (el[k.a])), b = buses.get(/** @type {string} */ (el[k.b]));
      if (a && b) list.polyline(route(el, a, b), BRANCH_W + w, c);
    } else {
      const b = buses.get(/** @type {string} */ (el.bus));
      if (b) { const s = stub(el, b); list.segment(s.from.x, s.from.y, s.to.x, s.to.y, STUB_W + w, c); list.circle(s.centre.x, s.centre.y, SYMBOL + w / 2, c, c, 0); }
    }
  }

  list.layer(1);
  for (const el of selection.size === 1 ? involved.filter(e => selection.has(e.id)) : []) {
    if (el.cls === 'bus') {
      const g = bar(el);
      for (const [x, y] of [[g.x0, g.y0], [g.x1, g.y1]]) list.rect(x - 4.5, y - 4.5, 9, 9, P.bg, P.select, 1.6, 1.5);
    } else if (el.cls === 'line' || el.cls === 'trafo') {
      const k = branchKeys(el), a = buses.get(/** @type {string} */ (el[k.a])), b = buses.get(/** @type {string} */ (el[k.b]));
      if (!a || !b) continue;
      const pts = route(el, a, b), h = bendHandle(pts);
      for (const p of [pts[0], pts[pts.length - 1]]) list.circle(p.x, p.y, 4.5, P.bg, P.select, 1.6);
      if (h) list.rect(h.x - 4.5, h.y - 4.5, 9, 9, P.bg, P.select, 1.6, 4.5);
    }
  }
  if (preview) drawPreview(list, P, preview, buses);
  return list;
}

/**
 * A label on a halo of the diagram background so it stays legible where it crosses a line.
 * @param {DisplayList} list @param {Palette} P @param {number} x @param {number} y @param {string} text @param {number} size @param {number} align
 */
function halo(list, P, x, y, text, size, align) {
  // It shows once its text is 4 px on screen, as the text itself does.
  const w = text.length * size * 0.56 + 6, h = size * 1.3, from = list.minZoom;
  list.minZoom = Math.max(from, 4 / size);
  list.rect(x - align * w - 3, y - h / 2, w, h, withAlpha(P.bg, 0.86), withAlpha(P.bg, 0), 0, 3);
  list.minZoom = from;
  list.text(x - align * (w - 6), y, text, size, P.label, { align, weight: 600, minPx: 4 });
}

/**
 * A result box: monospaced lines on a soft panel, anchored at its left (0), centre (0.5) or right (1) edge.
 * @param {DisplayList} list @param {Palette} P @param {number} x @param {number} y @param {string[]} lines
 * @param {number} align @param {RGBA | undefined} accent @param {number} [size]
 */
function box(list, P, x, y, lines, align, accent, size = MONO) {
  // It shows once its text is 6.5 px on screen, readable.
  const lh = size * 1.24, w = Math.max(...lines.map(l => l.length)) * size * 0.6 + 8, h = lines.length * lh + 4;
  const x0 = x - align * w, y0 = y - h / 2, from = list.minZoom;
  list.minZoom = Math.max(from, 6.5 / size);
  list.rect(x0, y0, w, h, P.boxBg, accent ? withAlpha(accent, 0.9) : P.boxBorder, accent ? 1.2 : 0.8, 3);
  list.minZoom = from;
  lines.forEach((t, i) => list.text(x0 + 4, y0 + 2 + lh * (i + 0.5), t, size, P.boxText, { font: 'mono', minPx: 6.5 }));
}

/**
 * Draws the symbol of a single-port element centred at c, with its stub arriving from direction −dir.
 * @param {DisplayList} list @param {Palette} P @param {string} cls @param {{ x: number, y: number }} c
 * @param {{ x: number, y: number }} dir @param {RGBA} color @param {number} q
 */
export function drawSymbol(list, P, cls, c, dir, color, q = 1) {
  const r = SYMBOL, px = -dir.y, py = dir.x;
  if (cls === 'gen') {
    list.circle(c.x, c.y, r, P.bg, color, 2);
    // A sine wave across the circle.
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, u = (t - 0.5) * r * 1.2, v = -Math.sin(t * Math.PI * 2) * r * 0.32;
      pts.push({ x: c.x + px * u + dir.x * v, y: c.y + py * u + dir.y * v });
    }
    list.polyline(pts, 1.8, color);
  } else if (cls === 'extgrid') {
    const w = r * 2.6, h = r * 1.5;
    const ax = Math.abs(px) > 0.5 ? w : h, ay = Math.abs(px) > 0.5 ? h : w;
    list.rect(c.x - ax / 2, c.y - ay / 2, ax, ay, P.bg, color, 2, 1);
    // Hatching: diagonal strokes clipped to the box.
    for (let i = -3; i <= 3; i++) {
      const o = i * 7;
      const pts = clipDiagonal(c.x - ax / 2 + 2, c.y - ay / 2 + 2, ax - 4, ay - 4, o);
      if (pts) list.segment(pts[0], pts[1], pts[2], pts[3], 1.3, withAlpha(color, 0.75));
    }
  } else if (cls === 'load') {
    const tipX = c.x + dir.x * 4, tipY = c.y + dir.y * 4, baseX = c.x - dir.x * 12, baseY = c.y - dir.y * 12;
    list.segment(c.x - dir.x * r, c.y - dir.y * r, baseX, baseY, 2, color);
    list.triangle(tipX, tipY, baseX + px * 8, baseY + py * 8, baseX - px * 8, baseY - py * 8, color);
  } else if (cls === 'shunt') {
    const s0 = { x: c.x - dir.x * r, y: c.y - dir.y * r };
    if (q >= 0) {
      // Capacitor: two plates, then earth.
      const p1 = { x: c.x - dir.x * 4, y: c.y - dir.y * 4 }, p2 = { x: c.x + dir.x * 3, y: c.y + dir.y * 3 };
      list.segment(s0.x, s0.y, p1.x, p1.y, 2, color);
      list.segment(p1.x - px * 11, p1.y - py * 11, p1.x + px * 11, p1.y + py * 11, 2.6, color);
      list.segment(p2.x - px * 11, p2.y - py * 11, p2.x + px * 11, p2.y + py * 11, 2.6, color);
      list.segment(p2.x, p2.y, c.x + dir.x * 12, c.y + dir.y * 12, 2, color);
    } else {
      // Reactor: a coil drawn as three loops.
      list.segment(s0.x, s0.y, c.x - dir.x * 9, c.y - dir.y * 9, 2, color);
      for (let i = -1; i <= 1; i++) list.circle(c.x + dir.x * i * 6, c.y + dir.y * i * 6, 4, withAlpha(P.bg, 0), color, 1.8);
      list.segment(c.x + dir.x * 9, c.y + dir.y * 9, c.x + dir.x * 12, c.y + dir.y * 12, 2, color);
    }
    const e = { x: c.x + dir.x * 12, y: c.y + dir.y * 12 };
    for (const [k, w] of [[0, 9], [4, 6], [8, 3]]) {
      const ex = e.x + dir.x * k, ey = e.y + dir.y * k;
      list.segment(ex - px * w, ey - py * w, ex + px * w, ey + py * w, 1.8, color);
    }
  }
}

/** A 45° stroke v = u + o (box-local, centred) clipped to a w × h rectangle at (x, y).
 * @param {number} x @param {number} y @param {number} w @param {number} h @param {number} o
 * @returns {[number, number, number, number] | null} */
function clipDiagonal(x, y, w, h, o) {
  const k = o + (h - w) / 2;
  const u0 = Math.max(0, -k), u1 = Math.min(w, h - k);
  if (u1 - u0 < 1) return null;
  return [x + u0, y + u0 + k, x + u1, y + u1 + k];
}

/** Fault marker: a lightning bolt. @param {DisplayList} list @param {number} x @param {number} y @param {RGBA} c */
function bolt(list, x, y, c) {
  list.triangle(x + 2, y - 14, x - 7, y + 2, x + 1, y + 1, c);
  list.triangle(x - 1, y - 1, x + 7, y - 2, x - 2, y + 14, c);
}

/** @param {DisplayList} list @param {Palette} P @param {Preview} pv @param {Map<string, Element>} buses */
function drawPreview(list, P, pv, buses) {
  if (pv.kind === 'rubber') list.segment(pv.from.x, pv.from.y, pv.to.x, pv.to.y, 2, P.preview, 5);
  else if (pv.kind === 'marquee') {
    const x = Math.min(pv.x0, pv.x1), y = Math.min(pv.y0, pv.y1);
    list.rect(x, y, Math.abs(pv.x1 - pv.x0), Math.abs(pv.y1 - pv.y0), withAlpha(P.select, 0.08), withAlpha(P.select, 0.8), 1, 0);
  } else if (pv.kind === 'ghost-bus') {
    list.segment(pv.x - pv.len / 2, pv.y, pv.x + pv.len / 2, pv.y, BAR_WIDTH, withAlpha(P.preview, 0.7));
  } else if (pv.kind === 'ghost-port') {
    const b = buses.get(pv.bus);
    if (!b) return;
    const s = stub(/** @type {Element} */ ({ id: '', cls: 'load', name: '', pos: pv.pos, side: pv.side }), b);
    const c = withAlpha(P.preview, 0.85);
    list.segment(s.from.x, s.from.y, s.to.x, s.to.y, STUB_W, c);
    drawSymbol(list, P, pv.cls, s.centre, s.dir, c);
  }
}

