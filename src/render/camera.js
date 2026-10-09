/** The view onto the diagram: a world-space centre and a zoom in CSS pixels per world unit. */

export class Camera {
  constructor() {
    this.cx = 0;
    this.cy = 0;
    this.zoom = 1;
    /** CSS pixel size of the viewport. */
    this.width = 1;
    this.height = 1;
  }

  /** @param {number} x @param {number} y CSS pixels relative to the viewport → world */
  toWorld(x, y) {
    return { x: (x - this.width / 2) / this.zoom + this.cx, y: (y - this.height / 2) / this.zoom + this.cy };
  }

  /** @param {number} x @param {number} y world → CSS pixels relative to the viewport */
  toScreen(x, y) {
    return { x: (x - this.cx) * this.zoom + this.width / 2, y: (y - this.cy) * this.zoom + this.height / 2 };
  }

  /** Zooms by a factor while keeping the world point under (sx, sy) fixed. @param {number} factor @param {number} sx @param {number} sy */
  zoomAt(factor, sx, sy) {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(8, Math.max(0.01, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }

  /** Fits a world rectangle into the viewport with a margin in CSS pixels.
   * @param {{ x0: number, y0: number, x1: number, y1: number }} box @param {number} [margin] */
  fit(box, margin = 48) {
    const w = Math.max(box.x1 - box.x0, 1), h = Math.max(box.y1 - box.y0, 1);
    this.zoom = Math.min(4, Math.max(0.01, Math.min((this.width - 2 * margin) / w, (this.height - 2 * margin) / h)));
    this.cx = (box.x0 + box.x1) / 2;
    this.cy = (box.y0 + box.y1) / 2;
  }
}
