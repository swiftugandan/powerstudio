/** Entry point: reads preferences and query parameters, starts the calculation worker and boots the app. */

import { App } from './app.js';
import { DocumentLibrary, loadPrefs } from './ui/persistence.js';

const params = new URLSearchParams(location.search);
const prefs = loadPrefs();
const forced = params.get('renderer');
const renderer = forced === 'canvas' || forced === 'webgpu' ? forced : prefs.renderer;

const app = new App({
  workerFactory: () => new Worker(new URL('./worker/engine.worker.js', import.meta.url), { type: 'module' }),
  prefs,
  library: new DocumentLibrary(),
  renderer,
});

/** Read-only facts for end-to-end tests and support: which backend is drawing and whether the app is ready. */
Object.defineProperty(window, 'powerstudio', {
  value: Object.freeze({
    get ready() { return document.getElementById('app')?.dataset.state === 'ready'; },
    get backend() { return app.viewport.backend; },
    get backendDetail() { return app.viewport.renderer?.detail ?? ''; },
    get fallbackReason() { return app.viewport.fallbackReason; },
    get frames() { return app.viewport.frames; },
    /** Each worker's busy time in the last parallel contingency analysis, ms. */
    get contingencyChunks() { return [...app.engine.lastChunks]; },
    /** The phases of the last parallel contingency analysis, ms. */
    get contingencyPhases() { return { ...app.engine.lastPhases }; },
    /** Page coordinates (CSS px) of a diagram point, for automation that needs to aim at a handle. */
    toPage: (/** @type {number} */ x, /** @type {number} */ y) => {
      const r = /** @type {HTMLElement} */ (document.getElementById('viewport')).getBoundingClientRect(), p = app.viewport.camera.toScreen(x, y);
      return { x: r.left + p.x, y: r.top + p.y };
    },
    /** The current frame read back from the active renderer, as a PNG data URL. */
    snapshot: () => app.viewport.snapshotPNG(),
  }),
});

app.boot({ sample: params.get('sample') ?? undefined }).catch(error => {
  console.error(error);
  document.getElementById('app')?.setAttribute('data-state', 'error');
  const msg = document.createElement('p');
  msg.className = 'noscript';
  msg.textContent = `PowerStudio could not start: ${error instanceof Error ? error.message : error}`;
  document.body.prepend(msg);
});
