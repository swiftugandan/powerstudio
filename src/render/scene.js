/** Builds the display list of the single-line diagram from the document, the result annotations and the editor state. */

import { DisplayList, withAlpha } from './displaylist.js';
import { bar, route, longestSegment, stub, routeHandles, branchKeys, bounds, BAR_WIDTH, SYMBOL } from './geometry.js';
import { conservativeMeasure } from './metrics.js';
import { SpatialHash, LabelIndex, COST, placeLabels, labelKey } from './labels.js';

/**
 * @typedef {import('./displaylist.js').RGBA} RGBA
 * @typedef {import('../core/catalog.js').Element} Element
 * @typedef {import('./labels.js').Rect} Rect
 * @typedef {import('./labels.js').Point} Point
 * @typedef {import('./labels.js').Slot} Slot
 * @typedef {import('./labels.js').Candidate} Candidate
 * @typedef {import('./labels.js').LabelRequest} LabelRequest
 * @typedef {{ kind: 'bar' | 'end' | 'along' | 'symbol', role: 'name' | 'box', g: import('./geometry.js').BarGeometry | null,
 *   pts: Point[] | null, reverse: boolean, seg: ReturnType<typeof longestSegment> | null, off: number, c: Point | null,
 *   d: Point | null }} Site
 *   where a label belongs: beside a bar (`g`), at a route's end (`pts`, from its last point when `reverse`), along its
 *   longest segment (`pts`, `seg`, at `off` from it), or beside a single-port symbol (`c`, its stub's direction `d`)
 * @typedef {{ type: 'box' | 'name', lines: string[], text: string, size: number, accent: RGBA | undefined, weight: 400 | 600,
 *   color: RGBA, minPx: number, halo: boolean, layer: number, from: number }} Look
 *   how a label is drawn: a result box of `lines`, or a name; `from` is the zoom from which its element shows
 * @typedef {LabelRequest & Site & Look} Label a label request with the scene's fields, as one flat record
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
 *   preview: Preview | null, guides?: import('../ui/snap.js').Guide[], zoom?: number, labels: { names: boolean, branchNames: boolean, boxes: boolean, disentangle?: boolean },
 *   measure?: import('./metrics.js').Measure }} SceneInput
 *   `measure` gives text widths; without it the scene uses widths that err wide (Node has no fonts); `disentangle`
 *   (on unless false) places labels clear of each other
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
/** Label groups, in the order they are placed after pinned labels and violations. */
const GROUP = { busName: 0, portName: 1, busBox: 2, portBox: 3, mid: 4, end: 5, branchName: 6 };
/** Text size of the flow boxes at branch ends. */
const END_SIZE = 9.5;
/** Steps between candidate positions along a route segment and along a bar, in world units. */
const SLIDE = 8, BAR_SLIDE = 20;
/** Half the side of the square a single-port symbol occupies, with its earthing or arrow. */
const SYMBOL_HALF = SYMBOL + 5;

/**
 * `buildScene` in steps: it pauses after every few thousand elements, so the viewport can spread the build of a
 * national diagram over several frames instead of holding the page. The first pass draws the elements and records
 * what labels must avoid; the second places the labels (`labels.js`) and draws them.
 * @param {SceneInput} input @returns {Generator<void, DisplayList, void>}
 */
export function* sceneSteps(input) {
  const { elements, palette: P, overlay, labels } = input;
  const measure = input.measure ?? conservativeMeasure;
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

  /** What labels avoid: bars, symbols and routes, on a grid over the drawing and the room its labels take. */
  const drawn = bounds(elements), margin = 600;
  const extent = { x0: drawn.x0 - margin, y0: drawn.y0 - margin, x1: drawn.x1 + margin, y1: drawn.y1 + margin };
  const obstacles = new SpatialHash(extent);
  // Labels in fixed places need no obstacles.
  const avoid = labels.disentangle ?? true;
  /** @type {Label[]} */
  const requests = [];
  /** @param {Element} el @param {Slot} slot @returns {[number, number] | null} */
  const pinOf = (el, slot) => {
    const v = /** @type {Record<string, unknown> | undefined} */ (el.labels)?.[slot];
    return Array.isArray(v) ? /** @type {[number, number]} */ (v) : null;
  };
  /** @type {Site} */
  const NOWHERE = { kind: 'bar', role: 'box', g: null, pts: null, reverse: false, seg: null, off: 0, c: null, d: null };
  /**
   * Adds a label as one flat record with every field present, so all half million share one shape.
   * @param {Element} el @param {Slot} slot @param {number} w @param {number} h @param {number} group @param {boolean} alert
   * @param {number} minZoom @param {Partial<Site>} site @param {Look} look
   */
  const add = (el, slot, w, h, group, alert, minZoom, site, look) => {
    const s = { ...NOWHERE, ...site };
    /** @type {Label} */
    const label = { owner: el.id, slot, w, h, group, alert, minZoom, pin: pinOf(el, slot), x: 0, y: 0, defX: 0, defY: 0, leader: null,
      kind: s.kind, role: s.role, g: s.g, pts: s.pts, reverse: s.reverse, seg: s.seg, off: s.off, c: s.c, d: s.d,
      type: look.type, lines: look.lines, text: look.text, size: look.size, accent: look.accent, weight: look.weight, color: look.color,
      minPx: look.minPx, halo: look.halo, layer: look.layer, from: look.from };
    requests.push(label);
  };
  /**
   * A result box: monospaced lines on a soft panel, from the zoom at which its text is 6.5 px on screen.
   * @param {Element} el @param {Slot} slot @param {string[]} lines @param {number} size @param {RGBA | undefined} accent
   * @param {number} group @param {boolean} alert @param {Partial<Site>} site
   */
  const boxLabel = (el, slot, lines, size, accent, group, alert, site) => {
    const w = Math.max(...lines.map(t => measure('mono', 400, size, t))) + 8, h = lines.length * size * 1.24 + 4, from = list.minZoom;
    add(el, slot, w, h, group, alert, Math.max(from, 6.5 / size), site,
      { type: 'box', lines, text: '', size, accent, weight: 400, color: P.boxText, minPx: 6.5, halo: false, layer: 3, from });
  };
  /**
   * A name: plain text, or on a halo of the background (busbars) so it stays legible where it crosses a line.
   * @param {Element} el @param {string} text @param {number} size @param {{ weight: 400 | 600, color: RGBA, minPx: number,
   *   halo: boolean, layer: number }} style @param {number} group @param {Partial<Site>} site
   */
  const nameLabel = (el, text, size, style, group, site) => {
    const w = measure('sans', style.weight, size, text) + (style.halo ? 6 : 0), h = size * 1.3, from = list.minZoom;
    add(el, 'name', w, h, group, false, Math.max(from, style.minPx / size), site,
      { type: 'name', lines: [], text, size, accent: undefined, from, ...style });
  };

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
    if (avoid) for (let i = 0; i < pts.length - 1; i++) obstacles.segment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, BRANCH_W, COST.line);
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
      if (avoid) for (const c of [c1, c2]) obstacles.add({ x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r }, COST.solid);
    }
    const a2 = ann.get(el.id);
    if (labels.branchNames && el.name) {
      nameLabel(el, el.name, 10, { weight: 400, color: P.labelMuted, minPx: 8, halo: false, layer: 1 }, GROUP.branchName, { kind: 'along', pts, seg, off: 16 });
    }
    if (a2 && labels.boxes) {
      if (a2.mid) boxLabel(el, 'mid', [a2.mid], MONO, a2.color, GROUP.mid, !!a2.alert, { kind: 'along', pts, seg, off: el.cls === 'trafo' ? 24 : 14 });
      if (a2.ends) {
        for (const [i, text] of a2.ends.entries()) {
          if (text) boxLabel(el, i === 0 ? 'endA' : 'endB', text.split('\n'), END_SIZE, undefined, GROUP.end, false, { kind: 'end', pts, reverse: i === 1 });
        }
      }
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
    if (avoid) {
      obstacles.segment(s.from.x, s.from.y, s.to.x, s.to.y, STUB_W, COST.line);
      obstacles.add({ x0: s.centre.x - SYMBOL_HALF, y0: s.centre.y - SYMBOL_HALF, x1: s.centre.x + SYMBOL_HALF, y1: s.centre.y + SYMBOL_HALF }, COST.solid);
    }
    if (labels.names && el.name) {
      const minPx = el.cls === 'gen' || el.cls === 'extgrid' ? 4 : 6;
      nameLabel(el, /** @type {string} */ (el.name), 12, { weight: 400, color: el.inService === false ? P.labelMuted : P.label, minPx, halo: false, layer: 1 },
        GROUP.portName, { kind: 'symbol', c: s.centre, d: s.dir, role: 'name' });
    }
    const a = ann.get(el.id);
    if (a?.box && labels.boxes) boxLabel(el, 'box', a.box, MONO, undefined, GROUP.portBox, false, { kind: 'symbol', c: s.centre, d: s.dir, role: 'box' });
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
    if (avoid) obstacles.segment(g.x0, g.y0, g.x1, g.y1, BAR_WIDTH, COST.solid);
    if (labels.names) nameLabel(el, el.name || el.id, 14, { weight: 600, color: P.label, minPx: 4, halo: true, layer: 2 }, GROUP.busName, { kind: 'bar', g, role: 'name' });
    const a = ann.get(el.id);
    if (a?.box && labels.boxes) boxLabel(el, 'box', a.box, MONO, a.color, GROUP.busBox, !!a.alert, { kind: 'bar', g, role: 'box' });
    list.minZoom = 0;
    if (overlay?.faultAt === el.id) bolt(list, g.horizontal ? (g.x0 + g.x1) / 2 : g.x0 + 18, g.horizontal ? g.y0 - 20 : (g.y0 + g.y1) / 2, P.fault);
  }

  // Labels, placed around everything drawn.
  const placed = yield* placeLabels(requests, obstacles, { disentangle: avoid, candidates: candidatesOf, anchor: anchorOf });
  const index = new LabelIndex(extent);
  // Leaders over the routes and under the busbars and labels: no label is crossed by another's leader, and a leader
  // never paints over a bar.
  list.layer(1);
  const ink = withAlpha(P.labelMuted, 0.8);
  for (const r of placed) {
    if (++done % STEP === 0) yield;
    if (!r.leader) continue;
    list.minZoom = r.minZoom;
    list.polyline(r.leader, 1, ink);
    list.circle(r.leader[0].x, r.leader[0].y, 1.8, ink, withAlpha(ink, 0), 0);
  }
  for (const r of placed) {
    if (++done % STEP === 0) yield;
    drawLabel(list, P, r);
    index.add(r);
  }
  list.minZoom = 0;
  list.labels = index;
  return list;
}

/** @param {Rect} r @returns {Point} */
const centre = r => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

/** Height of a single-port element's name, for placing its box where there is no name. */
const PORT_NAME_H = 12 * 1.3;

/** A label's positions, the default first. @param {LabelRequest} r @param {Map<string, Rect>} placed @returns {Candidate[]} */
function candidatesOf(r, placed) {
  const s = /** @type {Label} */ (r);
  switch (s.kind) {
    case 'bar': return besideBar(/** @type {import('./geometry.js').BarGeometry} */ (s.g), s.role, r.w, r.h);
    case 'end': return besideEnd(/** @type {Point[]} */ (s.pts), s.reverse, r.w, r.h);
    case 'along': return alongSegment(/** @type {ReturnType<typeof longestSegment>} */ (s.seg), s.off, r.w, r.h);
    case 'symbol': {
      const c = /** @type {Point} */ (s.c), d = /** @type {Point} */ (s.d);
      if (s.role === 'name') return besideSymbol(c, d, r.w, r.h);
      // The box goes with the name: under it, wherever the placer put it.
      const at = besideSymbol(c, d, 0, PORT_NAME_H)[0];
      const name = placed.get(labelKey(r.owner, 'name')) ?? { x0: at.x, y0: at.y, x1: at.x, y1: at.y + PORT_NAME_H };
      return boxBesideName(c, d, name, r.w, r.h);
    }
  }
}

/** Where a leader from a label at `at` ends: the nearest point of what the label belongs to.
 * @param {LabelRequest} r @param {Rect} at @returns {Point} */
function anchorOf(r, at) {
  const s = /** @type {Label} */ (r), pts = /** @type {Point[]} */ (s.pts);
  switch (s.kind) {
    case 'bar': { const g = /** @type {import('./geometry.js').BarGeometry} */ (s.g); return nearestOnSegment({ x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 }, centre(at)); }
    case 'end': return s.reverse ? pts[pts.length - 1] : pts[0];
    case 'along': { const i = /** @type {ReturnType<typeof longestSegment>} */ (s.seg).index; return nearestOnSegment(pts[i], pts[i + 1] ?? pts[i], centre(at)); }
    case 'symbol': return towards(/** @type {Point} */ (s.c), centre(at), SYMBOL);
  }
}

/** Draws a placed label. @param {DisplayList} list @param {Palette} P @param {LabelRequest} r */
function drawLabel(list, P, r) {
  const look = /** @type {Label} */ (r), { w, h, minZoom } = r, x0 = r.x, y0 = r.y;
  if (look.type === 'box') {
    list.layer(3);
    list.minZoom = minZoom;
    list.rect(x0, y0, w, h, P.boxBg, look.accent ? withAlpha(look.accent, 0.9) : P.boxBorder, look.accent ? 1.2 : 0.8, 3);
    list.minZoom = look.from;
    const lh = look.size * 1.24;
    look.lines.forEach((t, i) => list.text(x0 + 4, y0 + 2 + lh * (i + 0.5), t, look.size, P.boxText, { font: 'mono', minPx: 6.5 }));
    return;
  }
  list.layer(look.layer);
  if (look.halo) {
    list.minZoom = minZoom;
    list.rect(x0, y0, w, h, withAlpha(P.bg, 0.86), withAlpha(P.bg, 0), 0, 3);
  }
  list.minZoom = look.from;
  list.text(x0 + (look.halo ? 3 : 0), y0 + h / 2, look.text, look.size, look.color, { align: 0, weight: look.weight, minPx: look.minPx });
}

/** The point of segment ab nearest to p. @param {Point} a @param {Point} b @param {Point} p @returns {Point} */
function nearestOnSegment(a, b, p) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** The point at distance r from c towards p. @param {Point} c @param {Point} p @param {number} r @returns {Point} */
function towards(c, p, r) {
  const l = Math.hypot(p.x - c.x, p.y - c.y) || 1;
  return { x: c.x + (p.x - c.x) / l * r, y: c.y + (p.y - c.y) / l * r };
}

/**
 * Positions beside a busbar: a name above its start (the default), above its end, then below; a result box below its
 * end (the default), below its start, above, then sliding along the bar. A vertical bar has them to its right first.
 * @param {import('./geometry.js').BarGeometry} g @param {'name' | 'box'} kind @param {number} w @param {number} h
 * @returns {Candidate[]}
 */
function besideBar(g, kind, w, h) {
  if (kind === 'name') {
    if (g.horizontal) {
      const above = g.y0 - 15 - h / 2, below = g.y0 + 15 - h / 2;
      return [{ x: g.x0 - 3, y: above }, { x: g.x1 + 3 - w, y: above }, { x: g.x0 - 3, y: below }, { x: g.x1 + 3 - w, y: below }];
    }
    const right = g.x0 + 7, left = g.x0 - 7 - w, top = g.y0 + 4 - h / 2, bottom = g.y1 - 4 - h / 2;
    return [{ x: right, y: top }, { x: left, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  }
  /** @type {Candidate[]} */
  const out = [];
  if (g.horizontal) {
    const below = g.y0 + 9, above = g.y0 - 9 - h;
    out.push({ x: g.x1 - w, y: below }, { x: g.x0, y: below }, { x: g.x1 - w, y: above }, { x: g.x0, y: above });
    for (const y of [below, above]) for (let x = g.x1 - w - BAR_SLIDE; x > g.x0; x -= BAR_SLIDE) out.push({ x, y });
  } else {
    const right = g.x0 + 10, left = g.x0 - 10 - w;
    out.push({ x: right, y: g.y1 - h }, { x: left, y: g.y1 - h }, { x: right, y: g.y0 }, { x: left, y: g.y0 });
    for (const x of [right, left]) for (let y = g.y1 - h - BAR_SLIDE; y > g.y0; y -= BAR_SLIDE) out.push({ x, y });
  }
  return out;
}

/**
 * Positions beside the end of a route where it leaves its bar: next to the first segment, to the right of a vertical
 * one or above a horizontal one first, then the other side, sliding away from the bar. On a straight route the end
 * takes half the segment (the other end has the rest); on a bent one, the whole first segment, then the start of the
 * second.
 * @param {Point[]} pts the route @param {boolean} reverse the end is the route's last point @param {number} w @param {number} h
 * @returns {Candidate[]}
 */
function besideEnd(pts, reverse, w, h) {
  const at = (/** @type {number} */ k) => (reverse ? pts[pts.length - 1 - k] : pts[k]);
  /** @type {Candidate[]} */
  const out = [];
  const segments = pts.length > 2 ? 2 : 1;
  for (let k = 0; k < segments; k++) {
    const p = at(k), q = at(k + 1), len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 1) continue;
    const d = { x: (q.x - p.x) / len, y: (q.y - p.y) / len }, vertical = Math.abs(d.y) > 0.5, s0 = vertical ? 1 : -1;
    const ext = vertical ? h : w, first = k === 0 ? 12 : 6;
    const reach = pts.length === 2 ? len / 2 - ext : k === 0 ? len - ext - 6 : len / 3 - ext;
    for (let t = first; t <= Math.max(first, reach) + 1e-9; t += SLIDE) {
      for (const s of [s0, -s0]) {
        out.push(vertical
          ? { x: s > 0 ? p.x + 5 : p.x - 5 - w, y: d.y > 0 ? p.y + t : p.y - t - h }
          : { x: d.x > 0 ? p.x + t : p.x - t - w, y: s > 0 ? p.y + 4 : p.y - 4 - h });
      }
    }
  }
  return out;
}

/**
 * Positions beside a route's longest segment at a distance `off` from it: the middle on the left of the direction of
 * travel first (below a rightward segment), the other side, then sliding towards both ends up to 40 % of the segment.
 * @param {{ mid: Point, dir: Point, length: number }} seg @param {number} off @param {number} w @param {number} h
 * @returns {Candidate[]}
 */
function alongSegment(seg, off, w, h) {
  const n = { x: -seg.dir.y, y: seg.dir.x }, vertical = Math.abs(n.x) > 0.5;
  const reach = Math.max(0, 0.4 * seg.length - (vertical ? h : w) / 2);
  const ts = [0];
  for (let t = SLIDE; t <= reach; t += SLIDE) ts.push(t, -t);
  /** @type {Candidate[]} */
  const out = [];
  for (const t of ts) {
    for (const s of [1, -1]) {
      const q = { x: seg.mid.x + n.x * s * off + seg.dir.x * t, y: seg.mid.y + n.y * s * off + seg.dir.y * t };
      out.push(vertical ? { x: n.x * s > 0 ? q.x : q.x - w, y: q.y - h / 2 } : { x: q.x - w / 2, y: q.y - h / 2 });
    }
  }
  return out;
}

/**
 * Positions for a name beside a single-port symbol whose stub leaves its bar in direction d: to the right of the
 * symbol on a horizontal bar (below it on a vertical one), then the other side, then beyond the symbol.
 * @param {Point} c @param {Point} d @param {number} w @param {number} h @returns {Candidate[]}
 */
function besideSymbol(c, d, w, h) {
  if (Math.abs(d.y) > 0.5) {
    return [{ x: c.x + SYMBOL + 8, y: c.y - h / 2 }, { x: c.x - SYMBOL - 8 - w, y: c.y - h / 2 },
      { x: c.x - w / 2, y: d.y > 0 ? c.y + SYMBOL_HALF + 4 : c.y - SYMBOL_HALF - 4 - h }];
  }
  return [{ x: c.x - w / 2, y: c.y + SYMBOL + 12 - h / 2 }, { x: c.x - w / 2, y: c.y - SYMBOL - 12 - h / 2 },
    { x: d.x > 0 ? c.x + SYMBOL_HALF + 4 : c.x - SYMBOL_HALF - 4 - w, y: c.y - h / 2 }];
}

/**
 * Positions for a single-port element's result box, following where its name went: under the name, above it, on the
 * other side of the symbol, then beyond the symbol.
 * @param {Point} c @param {Point} d @param {Rect} name @param {number} w @param {number} h @returns {Candidate[]}
 */
function boxBesideName(c, d, name, w, h) {
  const horizontalBar = Math.abs(d.y) > 0.5, nameLeft = (name.x0 + name.x1) / 2 < c.x - 1;
  const x = nameLeft ? name.x1 - w : horizontalBar ? name.x0 : (name.x0 + name.x1) / 2;
  const nameBelow = (name.y0 + name.y1) / 2 > c.y;
  const other = horizontalBar
    ? { x: nameLeft ? c.x + SYMBOL + 8 : c.x - SYMBOL - 8 - w, y: c.y - h / 2 }
    : { x: c.x - w / 2, y: nameBelow ? c.y - SYMBOL - 8 - h : c.y + SYMBOL + 8 };
  const beyond = horizontalBar
    ? { x: c.x - w / 2, y: d.y > 0 ? c.y + SYMBOL_HALF + 4 : c.y - SYMBOL_HALF - 4 - h }
    : { x: d.x > 0 ? c.x + SYMBOL_HALF + 4 : c.x - SYMBOL_HALF - 4 - w, y: c.y - h / 2 };
  return [{ x, y: name.y1 + 1.2 }, { x, y: name.y0 - 1.2 - h }, other, beyond];
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
      const pts = route(el, a, b);
      for (const p of [pts[0], pts[pts.length - 1]]) list.circle(p.x, p.y, 4.5, P.bg, P.select, 1.6);
      for (const h of routeHandles(el, pts, input.zoom ?? 1)) list.rect(h.x - 4.5, h.y - 4.5, 9, 9, P.bg, P.select, 1.6, h.bend ? 4.5 : 1.5);
    }
  }
  if (preview) drawPreview(list, P, preview, buses);
  // Snapping's guides: dashed alignment lines and square markers on the points snapped to, the same size on screen
  // at every zoom.
  const guide = withAlpha(P.select, 0.95), px = 1 / (input.zoom ?? 1);
  for (const g of input.guides ?? []) {
    if (g.kind === 'line') list.segment(g.x0, g.y0, g.x1, g.y1, 1.25 * px, guide, 5 * px);
    else list.rect(g.x - 4.5 * px, g.y - 4.5 * px, 9 * px, 9 * px, withAlpha(P.bg, 0), guide, 1.5 * px, 1.5 * px);
  }
  return list;
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
    // Dragged leftwards it selects what it touches (crossing), drawn dashed; rightwards what lies wholly inside.
    const x0 = Math.min(pv.x0, pv.x1), y0 = Math.min(pv.y0, pv.y1), x1 = Math.max(pv.x0, pv.x1), y1 = Math.max(pv.y0, pv.y1);
    const crossing = pv.x1 < pv.x0, edge = withAlpha(P.select, 0.8);
    list.rect(x0, y0, x1 - x0, y1 - y0, withAlpha(P.select, crossing ? 0.05 : 0.08), crossing ? withAlpha(P.select, 0) : edge, 1, 0);
    if (crossing) for (const [a, b, c, d] of [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]]) list.segment(a, b, c, d, 1, edge, 5);
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

