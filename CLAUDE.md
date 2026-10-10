# PowerStudio: notes for agents

PowerStudio is a browser-based power system analysis workbench: a single-line diagram editor with load flow,
IEC 60909-style short circuit, N-1 contingency and stability simulation with machine controls. Read README.md for
features and limits, docs/ARCHITECTURE.md for the structure and docs/ENGINE.md for what every calculation computes.

## Commands

- `npm run build:engine`: compiles the Rust engine (`engine/`) to `src/engine/powerstudio-engine.wasm`. `npm test`,
  `npm run build` and the Playwright web server run it first. Needs rustup; the toolchain is pinned in
  `engine/rust-toolchain.toml`, which rustup only reads when cargo runs from `engine/`.
- `npm run test:engine` and `npm run lint:engine`: the engine's native tests, and rustfmt plus Clippy (warnings
  denied). `engine/target/release/ps study <kind> <document.json>` runs any study natively; `ps bench <case.m>` times
  a MATPOWER load flow.
- `npm start`: dev server at http://127.0.0.1:8770/ (modular source, no build step; build the engine first).
- `npm run check`: strict `tsc --checkJs`, two configs (page with DOM and WebGPU types; worker and core).
- `npm test`: Node test runner over `tests/*.test.mjs`, including the native-versus-WebAssembly comparison.
- `npm run test:browser`: Playwright against `dist/PowerStudio.html` (it builds first); projects `webgpu` and `canvas`.
- `npm run build`: `dist/PowerStudio.html` plus its SHA-256. `npm run build:pages`: `_site/` (website at `/`, app at
  `/app/`, download). The website's numbers come from the engine at build time; never type them into `site/index.html`.
- Releases: bump `version` in `package.json` and `src/core/version.js` together (a test checks), tag `vX.Y.Z`, and
  attach `dist/PowerStudio.html` and its `.sha256` to the GitHub release.
- `PS_SCREENSHOTS=1 npx playwright test screenshots --project=webgpu`: refreshes `docs/screenshots/`.

## Rules

- `src/core/` and `src/engine/` have no DOM access; Node tests and the worker import them directly.
- All calculations live in the Rust engine. Engine rules: no `unsafe` outside the exported functions of `ps-wasm`;
  no `unwrap`, `expect` or `panic` outside tests (errors become messages); every conversion to per unit goes in
  `ps-net`; the report field names are the interface, so a change to a report in `ps-study` changes the typedefs in
  `src/engine/reports.js` with it. Engine tests read the goldens from `tests/oracle/` by path; never copy values.
- Every solver change keeps the oracle tests green, natively (`npm run test:engine`) and in WebAssembly (`npm test`).
  Never edit `tests/oracle/golden/` by hand: change a sample, run `node scripts/export-oracle-inputs.mjs`, then the
  oracle (docs/TESTING.md). Never type a reference value from memory; record where it came from in
  docs/research/sources.md.
- The short-circuit calculation is "IEC 60909-style". Do not call it compliant or certified anywhere.
- Element fields are defined once, in `src/core/catalog.js`; the inspector and the import gate read them from there.
  The control models (`CONTROLLERS`) mirror `ControllerKind` in `engine/crates/ps-model/src/dynamics.rs`: names,
  parameter order and typical values; `tests/dynamics.test.mjs` keeps them equal through the engine's `library` op.
- A new dynamic model is written once over `ps_dyn::scalar::Scalar` (its Jacobian comes from dual numbers) and is
  validated against ANDES before it ships: a case in `tests/oracle/dyn-cases.json`, `scripts/oracle/andes_dyn.py`,
  then `engine/crates/ps-study/tests/dynamics.rs` (docs/TESTING.md).
  The engine's document writer (`ps-io/src/powerstudio_write.rs`) mirrors `VECTOR_GROUPS`; a test keeps them equal.
- Other tools' files (CGMES, PSS/E RAW, MATPOWER) open through the engine (`src/engine/exchange.js`); there is no
  importer in JavaScript.
- Every document edit goes through `store.transact` so undo, redo, autosave and staleness work.
- Buttons get behaviour from `data-cmd` and a registered command; never attach click handlers to command buttons.
- The bundler supports only single-line `import { … } from '…'` and `export function|function*|class|const|let`.
  Keep the one `new Worker(new URL('./worker/engine.worker.js', import.meta.url), { type: 'module' })` in `main.js`
  as written.
- Both renderers draw the same `DisplayList`; add a primitive to both (and to `svg.js`) or to neither.
- Shortcuts: never bind keys the browser owns (F5, F11, Ctrl+N, Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+1…9).
- UI copy: British English, plain verbs, sentence case.
- Look at the screenshots after UI changes; hold the UI to a pixel-perfect standard in both themes and at phone width.

## Browser testing locally

- The dev server's Content-Security-Policy blocks Playwright's string evaluation; ad-hoc scripts against port 8770
  need `bypassCSP: true`. The test suite serves `dist/` without that header (the build carries its own CSP meta tag).
- WebGPU in headless Chromium needs `channel: 'chromium'` and `--enable-unsafe-webgpu`; the headless shell has no
  adapter, which is how the `canvas` project exercises the fallback.
