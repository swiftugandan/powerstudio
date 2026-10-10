/** The drags of the diagram: panning, the marquee, and the edits the Select tool makes by dragging. Each edit drag
 * writes through `store.transact` with one coalescing key, so the whole drag is one step in the history. */

import { Gesture } from './tool.js';
import { bar, branchKeys } from '../../render/geometry.js';
import { inRect } from '../../render/hittest.js';
import { snap } from '../../core/layout.js';

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
    const ids = inRect(app.store.doc.elements, this);
    if (Math.hypot(this.x1 - this.x0, this.y1 - this.y0) * this.vp.camera.zoom > 3) app.setSelection(this.additive ? [...app.selection, ...ids] : ids);
    this.vp.invalidate('overlay');
  }

  /** @override @returns {import('./tool.js').Preview} */
  preview() { return { kind: 'marquee', x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1 }; }
}

/** Base of the drags that edit the document: one coalescing key per drag. */
class EditGesture extends Gesture {
  /** @param {Viewport} vp */
  constructor(vp) {
    super();
    this.vp = vp;
    this.key = `drag-${++vp.dragSeq}`;
  }

  get store() { return this.vp.app.store; }
}

/** Moves every selected busbar; their connections follow. */
export class MoveGesture extends EditGesture {
  /** @param {Viewport} vp @param {Point} start */
  constructor(vp, start) {
    super(vp);
    this.start = start;
    this.moved = false;
    /** @type {Map<string, Point>} */
    this.orig = new Map();
    for (const id of vp.app.selection) {
      const el = vp.app.store.get(id);
      if (el?.cls === 'bus') this.orig.set(id, { x: /** @type {number} */ (el.x), y: /** @type {number} */ (el.y) });
    }
  }

  /** @override @param {Pointer} e */
  move(e) {
    const dx = e.p.x - this.start.x, dy = e.p.y - this.start.y;
    if (!this.moved && Math.hypot(dx, dy) * this.vp.camera.zoom < 3) return;
    this.moved = true;
    this.store.transact(this.orig.size > 1 ? 'Move busbars' : 'Move busbar', tx => {
      for (const [id, o] of this.orig) { tx.set(id, 'x', snap(o.x + dx)); tx.set(id, 'y', snap(o.y + dy)); }
    }, { coalesce: this.key });
  }
}

/** Slides a machine, grid, load or shunt along its busbar, and across it to the other side. */
export class SlideGesture extends EditGesture {
  /** @param {Viewport} vp @param {string} id */
  constructor(vp, id) {
    super(vp);
    this.id = id;
  }

  /** @override @param {Pointer} e */
  move(e) {
    const el = /** @type {Element} */ (this.store.get(this.id)), bus = this.store.get(/** @type {string} */ (el.bus));
    if (!bus) return;
    this.store.transact('Move connection', tx => { tx.set(this.id, 'pos', this.vp.snapPos(bus, e.p)); tx.set(this.id, 'side', this.vp.sideOf(bus, e.p)); }, { coalesce: this.key });
  }
}

/** Drags one end of a busbar: the other end stays. */
export class ResizeGesture extends EditGesture {
  /** @param {Viewport} vp @param {Element} bus @param {0 | 1} end */
  constructor(vp, bus, end) {
    super(vp);
    const g = bar(bus);
    this.id = bus.id;
    this.which = end;
    this.x0 = g.horizontal ? g.x0 : g.y0;
    this.x1 = g.horizontal ? g.x1 : g.y1;
  }

  /** @override @param {Pointer} e */
  move(e) {
    const el = /** @type {Element} */ (this.store.get(this.id)), horizontal = el.orient !== 'v';
    const v = snap(horizontal ? e.p.x : e.p.y);
    const lo = this.which === 0 ? Math.min(v, this.x1 - 40) : this.x0, hi = this.which === 1 ? Math.max(v, this.x0 + 40) : this.x1;
    this.store.transact('Resize busbar', tx => { tx.set(this.id, 'len', hi - lo); tx.set(this.id, horizontal ? 'x' : 'y', (lo + hi) / 2); }, { coalesce: this.key });
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
    this.store.transact('Reroute', tx => tx.set(this.id, 'bend', Math.round((this.orig + delta) / 10) * 10), { coalesce: this.key });
  }
}

/** Drags one end of a branch along its busbar, or onto another busbar to reconnect it there. */
export class ReconnectGesture extends EditGesture {
  /** @param {Viewport} vp @param {string} id @param {'A' | 'B'} end */
  constructor(vp, id, end) {
    super(vp);
    this.id = id;
    this.which = end;
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
    if (bus && bus.id === el[busKey]) this.store.transact('Move connection', tx => tx.set(this.id, posKey, this.vp.snapPos(bus, e.p)), { coalesce: this.key });
    this.vp.invalidate();
  }

  /** @override @param {Pointer} e */
  end(e) {
    const app = this.vp.app, el = this.store.get(this.id), bus = this.vp.busAt(e.p);
    if (!el || !bus) return;
    const [busKey, posKey] = this.keys(el);
    if (bus.id === el[busKey]) return;
    try {
      this.store.transact('Reconnect', tx => { tx.set(this.id, busKey, bus.id); tx.set(this.id, posKey, this.vp.snapPos(bus, e.p)); });
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
    this.store.transact('Move label', tx => tx.set(owner, 'labels', { .../** @type {object} */ (el.labels), [slot]: offset }), { coalesce: this.key });
  }
}

