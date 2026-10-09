# Test report

Everything below was executed on 2026-10-09 for commit `d6cc360`. Numbers are
copied from the runs; nothing here is estimated. Re-run the commands in [TESTING.md](TESTING.md) to reproduce them.

## Environments

| Environment | Details |
| --- | --- |
| Local | macOS 26.7.1 (25G241), Apple M5 Pro, Node.js v26.0.0, Playwright 1.64.0 with Chromium 156.0.8078.4 (Chrome for Testing) and Chromium headless shell 156.0.8078.4 |
| CI | GitHub Actions `ubuntu-24.04`, Node.js v22.23.3, the same Playwright and Chromium builds; [run 37953787556](https://github.com/swiftugandan/powerstudio/actions/runs/37953787556) |
| Oracles | Python 3.12 (uv), pandapower 3.5.6, PYPOWER 5.1.21, numpy 2.4.6, scipy 1.18.1, run locally to produce `tests/oracle/golden/` |

## Results

| Suite | Local (macOS) | CI (Ubuntu) |
| --- | --- | --- |
| Type checking (`npm run check`, both configs) | passed | passed |
| Unit and engine tests (`npm test`) | 61 passed, 0 failed, 152 ms | 61 passed, 0 failed, 792 ms |
| Browser tests, `webgpu` project | 14 passed, 0 failed | 14 passed, 0 failed |
| Browser tests, `canvas` project | 14 passed, 0 failed | 14 passed, 0 failed |
| Browser suite wall time | 10.2 s | 24.0 s |

The browser tests cover the WebGPU and fallback backends, the load flow against MATPOWER, inspector editing with
undo and redo, drawing a network with the insert tools, copy and paste, switching in and out of service, keyboard
nudging, marquee selection, resizing, rerouting and reconnecting with the diagram handles, reload persistence, short
circuit, contingency and stability runs, MATPOWER import, JSON export and re-import, the theme switch, forcing Canvas
2D, network isolation and the phone layout.

The 8 skipped tests per project are the documentation screenshot captures, which run only with `PS_SCREENSHOTS=1`.
They were run locally (8 passed) to produce `docs/screenshots/`.

## Which renderer was tested where

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

## Agreement with independent solvers

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

## Build and deployment

| Check | Result |
| --- | --- |
| Build determinism | Two builds of the same source are byte-identical (`tests/build.test.mjs`); the local build (Node 26) and the CI build (Node 22) of this commit have the same SHA-256 |
| Build output | `dist/PowerStudio.html`, 539.3 KiB, sha256 `1a23924cbfbf47d64ff9b7b96db653778bdbfaa73ada2c639cdc16c02cbf0a56` |
| Published page | The workflow's verify job fetched https://swiftugandan.github.io/powerstudio/ and got the same SHA-256 on the first attempt |
| Independent check | `curl` of the live page from this machine after deployment returned the same SHA-256 |
| Live page in a browser | Opened from the Pages origin in local Chromium (build `1a23924c…`): it drew with WebGPU (Apple, metal-3), the IEEE 14 load flow converged in 3 iterations, and the only requests were the page itself and the worker's `blob:` URL |
| Opened from disk | `dist/PowerStudio.html` over `file://` in local Chromium drew with WebGPU, solved the load flow and saved to IndexedDB |

## Not verified

- Firefox, Safari and Chromium on Windows; WebGPU on Linux with a real GPU.
- Touch and pinch gestures on a real phone (the phone layout was tested at 390 × 844 in Chromium).
- Screen readers.
- The short-circuit method against the text of IEC 60909-0 or its TR 60909-4 examples (only against pandapower).
- Networks larger than MATPOWER case118.
