/** The drags of the diagram: panning, the marquee, and the edits the Select tool makes by dragging. Each edit drag
 * writes through `store.transact` with one coalescing key, so the whole drag is one step in the history. */

import { Gesture } from './tool.js';
import { bar, branchKeys, attachPoint, route, moveSegment } from '../../render/geometry.js';
import { inRect } from '../../render/hittest.js';

/**
 * @typedef {import('./tool.js').Pointer} Pointer
 * @typedef {import('./tool.js').Point} Point
 * @typedef {import('../../core/catalog.js').Element} Element
 * @typedef {import('../viewport.js').Viewport} Viewport
 */

/** Moves the view with the pointer. */
export class PanGesture extends Gesture {
  /** @param {Viewport} vp @param {Pointer} e */
  constructor(vp, e) {
    super();
    this.vp = vp;
    this.sx = e.sx; this.sy = e.sy;
    this.cx = vp.camera.cx; this.cy = vp.camera.cy;
    vp.host.classList.add('panning');
  }

  /** @override @param {Pointer} e */
  move(e) {
    const c = this.vp.camera;
    c.cx = this.cx - (e.sx - this.sx) / c.zoom;
    c.cy = this.cy - (e.sy - this.sy) / c.zoom;
    this.vp.invalidate('view');
  }

  /** @override */
  end() { this.vp.host.classList.remove('panning'); }
}

/** Selects what lies in a rectangle, adding to the selection with Shift, Ctrl or ⌘. */
export class MarqueeGesture extends Gesture {
  /** @param {Viewport} vp @param {Pointer} e */
  constructor(vp, e) {
    super();
    this.vp = vp;
    this.x0 = this.x1 = e.p.x;
    this.y0 = this.y1 = e.p.y;
    this.additive = e.shift || e.mod;
    if (!this.additive) vp.app.setSelection([]);
  }

  /** @override @param {Pointer} e */
  move(e) { this.x1 = e.p.x; this.y1 = e.p.y; this.vp.invalidate('overlay'); }

  /** @override */
  end() {
    const app = this.vp.app;
    const ids = inRect(app.store.doc.elements, this, this.x1 < this.x0);
    if (Math.hypot(this.x1 - this.x0, this.y1 - this.y0) * this.vp.camera.zoom > 3) app.setSelection(this.additive ? [...app.selection, ...ids] : ids);
    this.vp.invalidate('overlay');
  }

  /** @override @returns {import('./tool.js').Preview} */
  preview() { return { kind: 'marquee', x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1 }; }
}

/** Base of the drags that edit the document: one coalescing key per drag, so the whole drag is one step however
 * slowly it moves, and Escape reverts it. */
class EditGesture extends Gesture {
  /** @param {Viewport} vp */
  constructor(vp) {
    super();
    this.vp = vp;
    this.key = `drag-${++vp.dragSeq}`;
  }

  get store() { return this.vp.app.store; }

  /** Writes the drag's edit so far. @param {string} label @param {(tx: import('../../core/store.js').Tx) => void} fn */
  write(label, fn) { this.store.transact(label, fn, { coalesce: this.key, gesture: true }); }

  /** @override */
  cancel() { this.store.revert(this.key); }
}

/** @param {number} v */
const signed = v => (v < 0 ? `−${Math.abs(v)}` : `${v}`);

/** Moves every selected busbar as one; their connections follow. The bar under the pointer leads the snapping. */
export class MoveGesture extends EditGesture {
  /** @param {Viewport} vp @param {Point} start @param {string} lead the busbar the drag started on, if any */
  constructor(vp, start, lead = '') {
    super(vp);
    this.start = start;
    this.moved = false;
    /** The selected busbars as they were, the lead first. @type {Element[]} */
    this.bars = [];
    for (const id of vp.app.selection) {
      const el = vp.app.store.get(id);
      if (el?.cls === 'bus') this.bars.push({ ...el });
    }
    this.bars.sort((a, b) => +(b.id === lead) - +(a.id === lead));
    const moving = new Set(this.bars.map(b => b.id));
    this.snapper = vp.snapper(moving);
    /** Routes shaped by hand between two moving busbars, which move with them. @type {Array<[string, Array<[number, number]>]>} */
    this.routes = [];
    for (const el of vp.app.store.doc.elements) {
      if (el.cls !== 'line' && el.cls !== 'trafo') continue;
      const k = branchKeys(el), corners = /** @type {Array<[number, number]>} */ (el.route);
      if (corners.length && moving.has(/** @type {string} */ (el[k.a])) && moving.has(/** @type {string} */ (el[k.b]))) this.routes.push([el.id, corners]);
    }
  }

  /** @override @param {Pointer} e */
  move(e) {
    const dx = e.p.x - this.start.x, dy = e.p.y - this.start.y;
    if (!this.moved && Math.hypot(dx, dy) * this.vp.camera.zoom < 3) return;
    this.moved = true;
    const to = this.snapper.move(this.bars, dx, dy, e.alt);
    this.vp.setGuides(to.guides);
    this.status = `Δx ${signed(to.dx)}  Δy ${signed(to.dy)}`;
    this.write(this.bars.length > 1 ? 'Move busbars' : 'Move busbar', tx => {
      for (const b of this.bars) { tx.set(b.id, 'x', /** @type {number} */ (b.x) + to.dx); tx.set(b.id, 'y', /** @type {number} */ (b.y) + to.dy); }
      for (const [id, corners] of this.routes) tx.set(id, 'route', corners.map(([x, y]) => [x + to.dx, y + to.dy]));
    });
  }
}

/** Slides a machine, grid, load or shunt along its busbar, and across it to the other side. */
export class SlideGesture extends EditGesture {
  /** @param {Viewport} vp @param {string} id */
  constructor(vp, id) {
    super(vp);
    this.id = id;
    this.snapper = vp.snapper();
  }

  /** @override @param {Pointer} e */
  move(e) {
    const el = /** @type {Element} */ (this.store.get(this.id)), bus = this.store.get(/** @type {string} */ (el.bus));
    if (!bus) return;
    const at = this.snapper.along(bus, e.p, e.alt);
    this.vp.setGuides(at.guides);
    this.write('Move connection', tx => { tx.set(this.id, 'pos', at.pos); tx.set(this.id, 'side', this.vp.sideOf(bus, e.p)); });
  }
}

/** Drags one end of a busbar: the other end stays. */
export class ResizeGesture extends EditGesture {
  /** @param {Viewport} vp @param {Element} bus @param {0 | 1} end */
  constructor(vp, bus, end) {
    super(vp);
    const g = bar(bus);
    this.bus = { ...bus };
    this.which = end;
    this.x0 = g.horizontal ? g.x0 : g.y0;
    this.x1 = g.horizontal ? g.x1 : g.y1;
    this.snapper = vp.snapper(new Set([bus.id]));
  }

  /** @override @param {Pointer} e */
  move(e) {
    const id = this.bus.id, horizontal = this.bus.orient !== 'v';
    const at = this.snapper.end(this.bus, horizontal ? e.p.x : e.p.y, e.alt);
    const lo = this.which === 0 ? Math.min(at.v, this.x1 - 40) : this.x0, hi = this.which === 1 ? Math.max(at.v, this.x0 + 40) : this.x1;
    this.vp.setGuides(at.guides);
    this.status = `Length ${hi - lo}`;
    this.write('Resize busbar', tx => { tx.set(id, 'len', hi - lo); tx.set(id, horizontal ? 'x' : 'y', (lo + hi) / 2); });
  }
}

/** Moves one segment of a branch's route across itself, shaping the route by hand (a jog where it meets a bar). */
export class SegmentGesture extends EditGesture {
  /** @param {Viewport} vp @param {Element} el @param {number} index @param {Point} start */
  constructor(vp, el, index, start) {
    super(vp);
    const k = branchKeys(el), store = vp.app.store;
    this.id = el.id;
    this.index = index;
    this.start = start;
    this.pts = route(el, /** @type {Element} */ (store.get(/** @type {string} */ (el[k.a]))), /** @type {Element} */ (store.get(/** @type {string} */ (el[k.b]))));
    const a = this.pts[index], b = this.pts[index + 1];
    this.axis = Math.abs(a.x - b.x) < 1e-9 ? 'x' : 'y';
  }

  /** @override @param {Pointer} e */
  move(e) {
    const raw = this.axis === 'x' ? e.p.x - this.start.x : e.p.y - this.start.y;
    const d = e.alt ? Math.round(raw) : Math.round(raw / 10) * 10;
    this.status = `Segment ${signed(d)}`;
    this.write('Shape route', tx => tx.set(this.id, 'route', d ? moveSegment(this.pts, this.index, d) : /** @type {Element} */ (this.store.get(this.id)).route));
  }
}

/** Moves the middle segment of a branch's route across its axis. */
export class BendGesture extends EditGesture {
  /** @param {Viewport} vp @param {Element} el @param {'x' | 'y'} axis @param {Point} start */
  constructor(vp, el, axis, start) {
    super(vp);
    this.id = el.id;
    this.axis = axis;
    this.orig = /** @type {number} */ (el.bend) || 0;
    this.start = start;
  }

  /** @override @param {Pointer} e */
  move(e) {
    const delta = this.axis === 'y' ? e.p.y - this.start.y : e.p.x - this.start.x;
    const bend = e.alt ? Math.round(this.orig + delta) : Math.round((this.orig + delta) / 10) * 10;
    this.status = `Route offset ${signed(bend)}`;
    this.write('Reroute', tx => tx.set(this.id, 'bend', bend));
  }
}

/** Drags one end of a branch along its busbar, or onto another busbar to reconnect it there. */
export class ReconnectGesture extends EditGesture {
  /** @param {Viewport} vp @param {string} id @param {'A' | 'B'} end */
  constructor(vp, id, end) {
    super(vp);
    this.id = id;
    this.which = end;
    this.snapper = vp.snapper();
  }

  /** The bus and position keys of the dragged end. @param {Element} el */
  keys(el) {
    const k = branchKeys(el);
    return this.which === 'A' ? [k.a, k.pa] : [k.b, k.pb];
  }

  /** @override @param {Pointer} e */
  move(e) {
    const el = /** @type {Element} */ (this.store.get(this.id));
    const bus = this.vp.busAt(e.p), [busKey, posKey] = this.keys(el);
    if (bus && bus.id === el[busKey]) {
      // The end snaps in line with the branch's other end, so the route runs straight.
      const at = this.snapper.along(bus, e.p, e.alt, [this.farEnd(el)]);
      this.vp.setGuides(at.guides);
      this.write('Move connection', tx => tx.set(this.id, posKey, at.pos));
    } else {
      this.vp.setGuides([]);
    }
    this.vp.invalidate();
  }

  /** Where the branch's other end is. @param {Element} el @returns {Point} */
  farEnd(el) {
    const k = branchKeys(el), [busKey, posKey] = this.which === 'A' ? [k.b, k.pb] : [k.a, k.pa];
    const bus = this.store.get(/** @type {string} */ (el[busKey]));
    return bus ? attachPoint(bus, /** @type {number} */ (el[posKey])) : { x: NaN, y: NaN };
  }

  /** @override @param {Pointer} e */
  end(e) {
    const app = this.vp.app, el = this.store.get(this.id), bus = this.vp.busAt(e.p);
    if (!el || !bus) return;
    const [busKey, posKey] = this.keys(el);
    if (bus.id === el[busKey]) return;
    try {
      const at = this.snapper.along(bus, e.p, e.alt, [this.farEnd(el)]);
      this.store.transact('Reconnect', tx => { tx.set(this.id, busKey, bus.id); tx.set(this.id, posKey, at.pos); }, { coalesce: this.key, gesture: true });
      app.log('info', `${el.name || el.id} now connects to ${bus.name || bus.id}.`);
    } catch (error) {
      app.toast('warn', error instanceof Error ? error.message : String(error));
    }
  }
}

/** Drags a label away from where the diagram put it; it keeps that offset from its default position (pinned). */
export class LabelGesture extends EditGesture {
  /** @param {Viewport} vp @param {import('../../render/labels.js').LabelIndex['items'][number]} label @param {Point} start */
  constructor(vp, label, start) {
    super(vp);
    this.label = label;
    this.start = start;
    this.moved = false;
  }

  /** @override @param {Pointer} e */
  move(e) {
    const dx = e.p.x - this.start.x, dy = e.p.y - this.start.y;
    if (!this.moved && Math.hypot(dx, dy) * this.vp.camera.zoom < 3) return;
    this.moved = true;
    const { owner, slot, rect, def } = this.label, el = this.store.get(owner);
    if (!el) return;
    const offset = [Math.round(rect.x0 + dx - def.x), Math.round(rect.y0 + dy - def.y)];
    this.status = `Label Δx ${signed(offset[0])}  Δy ${signed(offset[1])}`;
    this.write('Move label', tx => tx.set(owner, 'labels', { .../** @type {object} */ (el.labels), [slot]: offset }));
  }
}

