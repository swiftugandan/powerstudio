/** Picks the drawing backend: WebGPU when the browser provides an adapter and a device, Canvas 2D otherwise.
 * The choice reported to the user is the backend that was actually created, with the reason for any fallback. */

import { WebGPURenderer } from './webgpu.js';
import { Canvas2DRenderer } from './canvas2d.js';

/** @typedef {WebGPURenderer | Canvas2DRenderer} Renderer */

/**
 * Creates a renderer on a fresh canvas inside the host. `preference` comes from the ?renderer= query parameter or the
 * user's setting: 'auto' tries WebGPU first, 'canvas' skips it.
 * @param {HTMLElement} host @param {'auto' | 'webgpu' | 'canvas'} preference
 * @returns {Promise<{ renderer: Renderer, fallbackReason: string }>}
 */
export async function createRenderer(host, preference) {
  host.querySelector('canvas.viewport-canvas')?.remove();
  let fallbackReason = '';
  if (preference !== 'canvas') {
    const canvas = makeCanvas(host);
    try {
      return { renderer: await WebGPURenderer.create(canvas), fallbackReason: '' };
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      canvas.remove(); // a canvas that asked for a webgpu context cannot hand out a 2d one
    }
  } else {
    fallbackReason = 'Canvas 2D was chosen in the settings.';
  }
  return { renderer: new Canvas2DRenderer(makeCanvas(host)), fallbackReason };
}

/** @param {HTMLElement} host */
function makeCanvas(host) {
  const canvas = document.createElement('canvas');
  canvas.className = 'viewport-canvas';
  canvas.setAttribute('aria-label', 'Single-line diagram');
  canvas.tabIndex = 0;
  host.prepend(canvas);
  return canvas;
}
