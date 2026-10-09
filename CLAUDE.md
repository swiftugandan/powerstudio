# PowerStudio: notes for agents

PowerStudio is a browser-based power system analysis workbench: a single-line diagram editor with load flow,
IEC 60909-style short circuit, N-1 contingency and classical-model stability. Read README.md for features and limits,
docs/ARCHITECTURE.md for the structure and docs/ENGINE.md for what every calculation computes.

## Commands

- `npm start`: dev server at http://127.0.0.1:8770/ (modular source, no build step).
- `npm run check`: strict `tsc --checkJs`, two configs (page with DOM and WebGPU types; worker and core).
- `npm test`: Node test runner over `tests/*.test.mjs`.
- `npm run test:browser`: Playwright against `dist/PowerStudio.html` (it builds first); projects `webgpu` and `canvas`.
- `npm run build`: `dist/PowerStudio.html` plus its SHA-256.
- `PS_SCREENSHOTS=1 npx playwright test screenshots --project=webgpu`: refreshes `docs/screenshots/`.

## Rules

- `src/core/` has no DOM access; Node tests and the worker import it directly.
- Every solver change keeps the oracle tests green. Never edit `tests/oracle/golden/` by hand: change a sample, run
  `node scripts/export-oracle-inputs.mjs`, then the oracle (docs/TESTING.md). Never type a reference value from
  memory; record where it came from in docs/research/sources.md.
- The short-circuit calculation is "IEC 60909-style". Do not call it compliant or certified anywhere.
- Element fields are defined once, in `src/core/catalog.js`; the inspector and the import gate read them from there.
- Every document edit goes through `store.transact` so undo, redo, autosave and staleness work.
- Buttons get behaviour from `data-cmd` and a registered command; never attach click handlers to command buttons.
- The bundler supports only single-line `import { … } from '…'` and `export function|class|const|let`. Keep the one
  `new Worker(new URL('./worker/engine.worker.js', import.meta.url), { type: 'module' })` in `main.js` as written.
- Both renderers draw the same `DisplayList`; add a primitive to both (and to `svg.js`) or to neither.
- Shortcuts: never bind keys the browser owns (F5, F11, Ctrl+N, Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+1…9).
- UI copy: British English, plain verbs, sentence case.
- Look at the screenshots after UI changes; hold the UI to a pixel-perfect standard in both themes and at phone width.

## Browser testing locally

- The dev server's Content-Security-Policy blocks Playwright's string evaluation; ad-hoc scripts against port 8770
  need `bypassCSP: true`. The test suite serves `dist/` without that header (the build carries its own CSP meta tag).
- WebGPU in headless Chromium needs `channel: 'chromium'` and `--enable-unsafe-webgpu`; the headless shell has no
  adapter, which is how the `canvas` project exercises the fallback.
