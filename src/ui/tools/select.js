/** The Select tool: selects, and drags what it presses on (busbars, their ends, connections, route segments, branch
 * ends), or draws a marquee from empty space. */

import { Tool } from './tool.js';
import { PanGesture, MarqueeGesture, MoveGesture, SlideGesture, ResizeGesture, BendGesture, ReconnectGesture } from './gestures.js';
import { hitTest } from '../../render/hittest.js';
import { route, branchKeys, bendHandle } from '../../render/geometry.js';

/**
 * @typedef {import('./tool.js').Pointer} Pointer
 * @typedef {import('../../core/catalog.js').Element} Element
 */

export class SelectTool extends Tool {
  /** @override */
  get mode() { return 'select'; }

  /** @override @param {Pointer} e */
  down(e) {
    const vp = this.vp, app = vp.app;
    const hit = hitTest(app.store.doc.elements, e.p, vp.camera.zoom, app.selection, vp.index());
    if (!hit) {
      // On a touch screen, a drag over empty space moves the view.
      if (e.touch) { if (!e.shift) app.setSelection([]); return new PanGesture(vp, e); }
      return new MarqueeGesture(vp, e);
    }
    if (hit.part === 'body') {
      if (e.shift || e.mod) { app.toggleSelection(hit.id); return null; }
      if (!app.selection.has(hit.id)) app.setSelection([hit.id]);
    }
    const el = /** @type {Element} */ (app.store.get(hit.id));
    if (hit.part === 'end0' || hit.part === 'end1') return new ResizeGesture(vp, el, hit.part === 'end0' ? 0 : 1);
    if (hit.part === 'endA' || hit.part === 'endB') return new ReconnectGesture(vp, el.id, hit.part === 'endA' ? 'A' : 'B');
    if (hit.part === 'bend') return new BendGesture(vp, el, this.bendAxis(el) ?? 'y', e.p);
    if (el.cls === 'gen' || el.cls === 'extgrid' || el.cls === 'load' || el.cls === 'shunt') {
      return app.selection.size === 1 ? new SlideGesture(vp, el.id) : new MoveGesture(vp, e.p);
    }
    if (el.cls === 'line' || el.cls === 'trafo') {
      // Dragging the only selected branch reroutes it; in a larger selection it moves the busbars.
      const axis = this.bendAxis(el);
      return app.selection.size === 1 && axis ? new BendGesture(vp, el, axis, e.p) : new MoveGesture(vp, e.p);
    }
    return new MoveGesture(vp, e.p);
  }

  /** The axis a branch's middle segment moves on, or null for a route without one. @param {Element} el */
  bendAxis(el) {
    const store = this.vp.app.store, k = branchKeys(el);
    const a = store.get(/** @type {string} */ (el[k.a])), b = store.get(/** @type {string} */ (el[k.b]));
    const hb = a && b ? bendHandle(route(el, a, b)) : null;
    return hb ? /** @type {'x' | 'y'} */ (hb.axis) : null;
  }

  /** @override @param {Pointer} e */
  hover(e) {
    const vp = this.vp, app = vp.app;
    const hit = hitTest(app.store.doc.elements, e.p, vp.camera.zoom, app.selection, vp.index());
    vp.host.dataset.hover = !hit ? '' : hit.part === 'body' ? 'element' : 'handle';
    if ((hit?.id ?? '') !== app.hover) app.setHover(hit?.id ?? '');
  }
}

/** The Pan tool: every drag moves the view. */
export class PanTool extends Tool {
  /** @override */
  get mode() { return 'pan'; }
  /** @override */
  get hint() { return 'Drag to move the view'; }

  /** @override @param {Pointer} e */
  down(e) { return new PanGesture(this.vp, e); }

  /** @override */
  hover() {}
}
