# Test report

Numbers are copied from the runs; nothing here is estimated. Re-run the commands in [TESTING.md](TESTING.md) to
reproduce them. The first section covers the Rust engine (commit `18ac5c7`, local runs only: it has not been pushed,
so CI has not run it). The sections after it record release v0.1.0 (commit `6e803ce`), locally and in CI.

## Rust engine, phase 1 (commit `18ac5c7`, 2026-10-09, local)

Environment: macOS 26.7.1, Apple M5 Pro, Node.js v26.0.0, Rust 1.96.0 (`engine/rust-toolchain.toml`), Playwright
1.64.0 with Chromium 156.0.8078.4.

| Suite | Result |
| --- | --- |
| Type checking (`npm run check`, both configs) | passed |
| Engine format and lints (`npm run lint:engine`) | passed, no warnings |
| Engine tests, native (`npm run test:engine`) | 39 passed, 0 failed |
| Node tests on the WebAssembly engine (`npm test`) | 62 passed, 0 failed, 1092 ms |
| Browser tests (`npm run test:browser`), both projects | 28 passed, 0 failed, 16 skipped (screenshot captures), 10.5 s |
| Native against WebAssembly (`tests/engine.test.mjs`) | every study on every oracle input: largest relative difference 1.1e-12; 39,564 of 41,102 numbers bit-identical |
| Determinism | repeated requests on one instance and on a fresh instance give identical reports |
| Opened from disk | `dist/PowerStudio.html` over `file://` in Chromium drew with WebGPU and ran the load flow, the parallel N-1 analysis and the stability simulation with no page errors |
| Development server | under its own Content-Security-Policy (not bypassed), the engine loaded as `/src/engine/powerstudio-engine.wasm` and the load flow and N-1 analysis gave the same results as the build |

Build outputs: `src/engine/powerstudio-engine.wasm` 930,644 bytes (315,597 gzip-compressed), sha256
`6f5325e25c18d8c243e7fb0fcbf1e1198416742f8c69cd8e255ab7bf0ab71058`; `dist/PowerStudio.html` 817.8 KiB, sha256
`5741b13dbc4e7f0dc5c04386efdfdc95e86dd66df465a69ccc620a5c9f4f5375`.

Agreement with the oracles through the WebAssembly engine (`node scripts/oracle-agreement.mjs`):

| Comparison | Reference | Largest difference |
| --- | --- | --- |
| Load flow, MATPOWER case14 (14 buses, import and solve 10.4 ms) | PYPOWER 5.1.21 | 6.7e-16 p.u., 1.8e-14° |
| Load flow, MATPOWER case30 (30 buses, import and solve 3.7 ms) | PYPOWER 5.1.21 | 8.9e-12 p.u., 6.4e-10° |
| Load flow, MATPOWER case118 (118 buses, import and solve 23.7 ms) | PYPOWER 5.1.21 | 2.4e-14 p.u., 1.6e-12° |
| Load flow, ieee14 | pandapower 3.5.6 | 4.4e-16 p.u., 3.6e-13 MW or Mvar |
| Load flow, riverside | pandapower 3.5.6 | 6.7e-16 p.u., 5.4e-13 MW or Mvar |
| Load flow, riverside, reactive limits | pandapower 3.5.6 | 6.7e-16 p.u., 5.4e-13 MW or Mvar |
| Load flow, ieee14-qlim, reactive limits | pandapower 3.5.6 | 2.2e-16 p.u., 3.7e-13 MW or Mvar |
| Short circuit, ieee14, 3ph, max and min: Ik″, ip, Ith | pandapower 3.5.6 | 7.2e-16 relative |
| Short circuit, ieee14, 2ph, max and min: Ik″, ip, Ith | pandapower 3.5.6 | 6.6e-16 relative |
| Short circuit, ieee14, 1ph, max and min: Ik″ | pandapower 3.5.6 | 1.7e-8 relative |
| Short circuit, riverside, 3ph, max and min: Ik″, ip, Ith | pandapower 3.5.6 | 1.1e-15 relative |
| Short circuit, riverside, 2ph, max and min: Ik″, ip, Ith | pandapower 3.5.6 | 1.3e-15 relative |
| Short circuit, riverside, 1ph, max and min: Ik″ | pandapower 3.5.6 | 5.4e-11 relative |

Load flow at scale is in [ENGINE.md](ENGINE.md#numerical-methods-and-scale) and the design's phase 0 and phase 1
results.

## Release v0.1.0 (commit `6e803ce`)

Everything in this section was executed on 2026-10-09.

### Environments

| Environment | Details |
| --- | --- |
| Local | macOS 26.7.1 (25G241), Apple M5 Pro, Node.js v26.0.0, Playwright 1.64.0 with Chromium 156.0.8078.4 (Chrome for Testing) and Chromium headless shell 156.0.8078.4 |
| CI | GitHub Actions `ubuntu-24.04`, Node.js v22.23.3, the same Playwright and Chromium builds; [run 37955865278](https://github.com/swiftugandan/powerstudio/actions/runs/37955865278) |
| Oracles | Python 3.12 (uv), pandapower 3.5.6, PYPOWER 5.1.21, numpy 2.4.6, scipy 1.18.1, run locally to produce `tests/oracle/golden/` |

### Results

| Suite | Local (macOS) | CI (Ubuntu) |
| --- | --- | --- |
| Type checking (`npm run check`, both configs) | passed | passed |
| Unit and engine tests (`npm test`) | 63 passed, 0 failed, 309 ms | 63 passed, 0 failed, 1316 ms |
| Browser tests, `webgpu` project | 14 passed, 0 failed | 14 passed, 0 failed |
| Browser tests, `canvas` project | 14 passed, 0 failed | 14 passed, 0 failed |
| Browser suite wall time | 9.7 s | 23.4 s |

The browser tests cover the WebGPU and fallback backends, the load flow against MATPOWER, inspector editing with
undo and redo, drawing a network with the insert tools, copy and paste, switching in and out of service, keyboard
nudging, marquee selection, resizing, rerouting and reconnecting with the diagram handles, reload persistence, short
circuit, contingency and stability runs, MATPOWER import, JSON export and re-import, the theme switch, forcing Canvas
2D, network isolation and the phone layout.

The 8 skipped tests per project are the documentation screenshot captures, which run only with `PS_SCREENSHOTS=1`.
They were run locally (8 passed) to produce `docs/screenshots/`.

### Which renderer was tested where

| Environment and project | Backend the app used | How it was established |
| --- | --- | --- |
| macOS, `webgpu` (Chromium, `--enable-unsafe-webgpu`) | **WebGPU**, Apple adapter, `metal-3` | The test requires WebGPU here, reads the frame back from the GPU and finds the diagram's 132 kV and 33 kV colours, and finds the same colours in a screenshot of the page |
| macOS, `canvas` (headless shell) | Canvas 2D, reason "No WebGPU adapter is available." | Same pixel checks on the Canvas 2D frame and the screenshot |
| Ubuntu CI, `webgpu` | Canvas 2D, reason "WebGPU device lost: A valid external Instance reference no longer exists." | WebGPU is optional there (`PS_WEBGPU=optional`); the test checks that the badge reports the backend actually in use and that the frame and the screenshot show the diagram. The device-loss recovery path ran in this job. |
| Ubuntu CI, `canvas` | Canvas 2D, reason "No WebGPU adapter is available." | Same as macOS |

**WebGPU on GitHub's Ubuntu runners does not work.** `scripts/webgpu-probe.mjs` was run there through the "WebGPU
probe" workflow ([run 37952121882](https://github.com/swiftugandan/powerstudio/actions/runs/37952121882)) with
eleven Chromium flag sets, headless and headed under Xvfb. Chromium either offered no adapter or offered a SwiftShader
adapter whose instance was gone within seconds ("A valid external Instance reference no longer exists" on
`requestDevice`, on `mapAsync` or as a lost device), and in no case did a WebGPU frame reach a screenshot. On macOS
the same probe draws correctly with both the Metal adapter and the SwiftShader adapter. Because of this, the app now
self-tests a new WebGPU device (clear a texel, read it back within 3 s) before using it, and it switches to Canvas 2D
when the device is lost later or a GPU read-back fails. In the CI run above, the device passed the self-test and was
lost moments later; the app recovered to Canvas 2D and the test confirmed the badge and the drawing.

The WebGPU rendering path is therefore verified on macOS (Metal and SwiftShader) only. Firefox, Safari, Windows and
real GPUs on Linux were not tested.

### Agreement with independent solvers

From `node scripts/oracle-agreement.mjs` (largest difference over every bus, branch and case):

| Comparison | Reference | Largest difference |
| --- | --- | --- |
| Load flow, MATPOWER case14 (14 buses, import and solve 5.7 ms) | PYPOWER 5.1.21 | 6.7e-16 p.u., 3.4e-14° |
| Load flow, MATPOWER case30 (30 buses, import and solve 2.7 ms) | PYPOWER 5.1.21 | 8.9e-12 p.u., 6.4e-10° |
| Load flow, MATPOWER case118 (118 buses, import and solve 24.3 ms) | PYPOWER 5.1.21 | 2.4e-14 p.u., 1.5e-12° |
| Load flow, ieee14 | pandapower 3.5.6 | 2.2e-16 p.u., 3.9e-13 MW or Mvar |
| Load flow, riverside | pandapower 3.5.6 | 1.3e-15 p.u., 8.9e-13 MW or Mvar |
| Load flow, riverside, reactive limits | pandapower 3.5.6 | 1.3e-15 p.u., 8.9e-13 MW or Mvar |
| Load flow, ieee14-qlim, reactive limits | pandapower 3.5.6 | 8.9e-16 p.u., 2.6e-13 MW or Mvar |
| Short circuit, ieee14, 3ph, max and min: Ik″, ip, Ith | pandapower 3.5.6 | 1.9e-15 relative |
| Short circuit, ieee14, 2ph, max and min: Ik″, ip, Ith | pandapower 3.5.6 | 2.1e-15 relative |
| Short circuit, ieee14, 1ph, max and min: Ik″ | pandapower 3.5.6 | 1.7e-8 relative |
| Short circuit, riverside, 3ph, max and min: Ik″, ip, Ith | pandapower 3.5.6 | 1.4e-15 relative |
| Short circuit, riverside, 2ph, max and min: Ik″, ip, Ith | pandapower 3.5.6 | 8.7e-16 relative |
| Short circuit, riverside, 1ph, max and min: Ik″ | pandapower 3.5.6 | 5.4e-11 relative |

Earth-fault ip and Ith have no external reference (pandapower does not report them). The stability simulation was
checked against closed-form results instead: clearing a terminal fault 2 % before the equal-area critical clearing
time keeps a single machine in step and clearing it 2 % after does not, and small oscillations match the linearised
swing frequency within 1 % (`tests/rms.test.mjs`).

### Build and deployment

| Check | Result |
| --- | --- |
| Build determinism | Two builds of the same source are byte-identical (`tests/build.test.mjs`); the local build (Node 26) and the CI build (Node 22) of this commit have the same SHA-256 |
| Build output | `dist/PowerStudio.html`, 539.8 KiB, sha256 `1d52de7e4181ddc5ae68093cf6138d73363d98c3487ebc79b8a0d790bbef8eee` |
| Published site | The workflow's verify job fetched https://swiftugandan.github.io/powerstudio/app/ and `/PowerStudio.html` and got the build's SHA-256 for both on the first attempt; the website at `/` answered 200 |
| Independent check | The release asset `PowerStudio.html` of v0.1.0, downloaded from GitHub, passes `shasum -a 256 -c` against its published checksum, and equals the local build |
| Live site in a browser | Opened https://swiftugandan.github.io/powerstudio/ in local Chromium: the website showed the build-time figures (13.393 MW, 27.35 kA, 10 of 20, stays in step); its "Open PowerStudio" button opened `/app/`, which drew with WebGPU (Apple, metal-3) and converged the IEEE 14 load flow in 3 iterations, with no page errors |
| Opened from disk | `dist/PowerStudio.html` over `file://` in local Chromium drew with WebGPU, solved the load flow and saved to IndexedDB |

## Not verified (as of phase 1)

- Firefox, Safari and Chromium on Windows; WebGPU on Linux with a real GPU.
- Touch and pinch gestures on a real phone (the phone layout was tested at 390 × 844 in Chromium).
- Screen readers.
- The short-circuit method against the text of IEC 60909-0 or its TR 60909-4 examples (only against pandapower).
- The editor with networks larger than MATPOWER case118 (the engine alone was run on cases up to 70,000 buses).
- The engine build in CI, and its reproducibility on a second machine.
