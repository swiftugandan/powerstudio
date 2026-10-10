/** The interface every diagram tool and gesture implements. The viewport owns the camera, the frames and the raw
 * pointer events; it hands each press, movement and release to the active tool as a `Pointer`, and a press that
 * starts a drag returns a gesture, which then receives the movements and the release. */

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ p: Point, sx: number, sy: number, shift: boolean, alt: boolean, mod: boolean, touch: boolean }} Pointer
 *   a pointer event in world (`p`) and viewport (`sx`, `sy`) coordinates; `mod` is Ctrl, or ⌘ on a Mac
 * @typedef {import('../../render/scene.js').Preview} Preview
 */

/** A drag under way. */
export class Gesture {
  constructor() {
    /** What the status bar shows while the drag runs (the movement, a length). */
    this.status = '';
  }

  /** Escape: undoes what the drag did. */
  cancel() {}

  /** @param {Pointer} _e */
  move(_e) {}
  /** @param {Pointer} _e */
  end(_e) {}
  /** What the gesture draws over the diagram while it runs. @returns {Preview | null} */
  preview() { return null; }
}

/** A tool: what a press on the diagram does. */
export class Tool {
  /** @param {import('../viewport.js').Viewport} vp */
  constructor(vp) {
    this.vp = vp;
  }

  /** The status hint while the tool is active (HTML, with keys as `kbd`). */
  get hint() { return ''; }

  /** The viewport's cursor family: 'select', 'pan' or 'place'. */
  get mode() { return 'place'; }

  /** A press; returns the gesture it starts, if any. @param {Pointer} _e @returns {Gesture | null} */
  down(_e) { return null; }

  /** The press ended (after its gesture, if any). @param {Pointer} _e */
  up(_e) {}

  /** The pointer moved with no gesture under way. @param {Pointer} _e */
  hover(_e) { this.vp.invalidate('overlay'); }

  /** What the tool draws under the pointer. @param {Point} _p @returns {Preview | null} */
  preview(_p) { return null; }

  /** Escape: drops a half-finished action; true if there was one. */
  cancel() { return false; }
}
