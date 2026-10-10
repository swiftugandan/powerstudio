# Test report

Numbers are copied from the runs; nothing here is estimated. Re-run the commands in [TESTING.md](TESTING.md) to
reproduce them. The first sections cover phase 5's wave D1 and phases 4, 3, 2 and 1 (local runs only: they have not
been pushed, so CI has not run them). The sections after it record release v0.1.0 (commit `6e803ce`), locally and in CI.

## Dynamics, phase 5 wave D1 (2026-10-10, local)

Same environment as phases 1 to 4. Local runs only. The suite figures are those of phase 4 plus the dynamics tests:
engine tests 89, Node tests 90, browser tests 50 passed (16 screenshot captures skipped), lints clean.

Agreement with ANDES 2.0.0 (`engine/crates/ps-study/tests/dynamics.rs`, ANDES at 0.25 ms, the engine at 1 ms). Worst
difference per quantity over every machine, bus and sample: rotor angle δ (rad), speed ω, active and reactive power
(p.u. on 100 MVA), field voltage vf and mechanical power Pm (p.u.), bus voltage |V| (p.u.). With ANDES's way across
events, compared everywhere but within 2 ms of an event:

| Case | δ | ω | P | Q | vf | Pm | \|V\| |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Kundur, classical, published line trip | 7.4e-5 | 8.0e-8 | 3.5e-5 | 1.2e-5 | 1.4e-7 | 5.4e-6 | 4.9e-7 |
| Kundur, classical, fault at bus 8 | 1.9e-5 | 3.8e-8 | 2.3e-5 | 8.7e-6 | 1.4e-7 | 5.4e-6 | 3.3e-7 |
| Kundur, GENROU EXDC2 TGOV1, published line trip | 2.7e-5 | 2.9e-8 | 1.0e-5 | 7.8e-6 | 1.6e-6 | 7.1e-6 | 4.4e-7 |
| Kundur, GENROU EXDC2 TGOV1, fault at bus 8 | 1.0e-3 | 1.3e-6 | 2.5e-4 | 3.1e-4 | 8.0e-4 | 8.7e-5 | 2.2e-5 |
| IEEE 14, published trip and reclosure | 1.9e-4 | 2.3e-7 | 9.5e-6 | 8.3e-6 | 2.8e-4 | 3.6e-6 | 9.4e-7 |
| IEEE 14, fault at bus 9 | 2.1e-5 | 6.4e-8 | 6.7e-6 | 1.2e-5 | 1.1e-3 | 6.4e-7 | 2.9e-6 |
| WECC 179, fault at bus 3 | 2.4e-5 | 2.3e-7 | 3.7e-4 | 2.3e-4 | 7.1e-4 | 3.6e-4 | 4.0e-6 |
| Kundur with SEXS, fault at bus 8 | 2.7e-5 | 4.3e-8 | 2.1e-5 | 7.7e-5 | 1.5e-6 | 7.4e-6 | 2.3e-6 |
| IEEE 14 with IEEET1 at bus 8, fault at bus 9 | 1.9e-5 | 6.2e-8 | 6.7e-6 | 1.2e-5 | 1.1e-3 | 6.3e-7 | 2.9e-6 |
| IEEE 14 with HYGOV at bus 8, line trip | 1.5e-6 | 3.2e-9 | 7.1e-7 | 2.5e-7 | 4.2e-5 | 2.3e-8 | 5.1e-8 |
| Tolerance | 2e-3 | 3e-6 | 1e-3 | 1e-3 | 2e-3 | 1e-3 | 5e-5 |

With the engine's own way across events (the app's), compared from 0.3 s after each event, the worst are 1.0e-3 rad,
2.1e-6, 2.1e-3 p.u. power (WECC's slack machine), 4.2e-4 p.u. field voltage and 1.8e-5 p.u. voltage, within three
times the tolerance. The load flows agree to 5.4e-9 p.u. (IEEE 14), 2.5e-7 (Kundur) and 1.8e-6 (WECC). The four
largest figures have measured causes (docs/TESTING.md): ANDES's anti-windup error in Kundur's fault (at 1 ms ANDES is
8.5e-3 rad from the engine, at 0.25 ms 1.0e-3), the engine's 1 ms step on EXST1 during a fault (7e-5 at 0.25 ms),
WECC's load flow difference at its slack machine, and IEEE 14's machine at bus 6, whose TGOV1 valve starts exactly at
its lower limit, so whether the limit holds after the trip depends on rounding.

Other checks: every model's dual-number Jacobian equals central differences to 1e-6 relative; every model and every
published case starts and stays in equilibrium (5 s without events, drift under 1e-7); the classical model meets the
equal-area critical clearing time within 2 % and the linearised swing frequency within 1 %; a RAW and DYR import,
an exciter edit and a simulation pass in the browser at 1440 and 390 px.

Speed (Node, one WebAssembly engine): ACTIVSg2000 with classical machines and a fault, 5 s simulated in 2.8 s at a
1 ms step and 0.9 s at 5 ms; ACTIVSg10k in 11.6 s and 3.1 s.

Not verified by the comparison: HYGOV's conversion between machine and system bases and its r·Tr integrator (the
case has a machine rated at the system base and r = Tr = 1); ESDC2A's transducer (set aside in both programs);
saturation of GENROU with S(1.2) = 0 and S(1.0) ≠ 0, which ANDES reads differently; stabiliser signals from remote
busbars, bus frequency and the voltage's derivative, which the engine refuses; machines rated off the system base for
SEXS, IEEET1 and HYGOV (only WECC has such machines, with other models).

## Workspace at scale, phase 4 (commit `bc56afe`, 2026-10-10, local)

Same environment as phases 1 to 3 (Apple M5 Pro, Chromium 156, Node 26). Local runs only: phase 4 has not been
pushed, so CI has not run it.

| Suite | Result |
| --- | --- |
| Type checking (`npm run check`, both configs) | passed |
| Engine format and lints (`npm run lint:engine`) | passed, no warnings |
| Engine tests, native (`npm run test:engine`) | 78 passed, 0 failed |
| Node tests on the WebAssembly engine (`npm test`) | 87 passed, 0 failed |
| Browser tests (`npm run test:browser`), both projects | 46 passed, 0 failed, 16 skipped (screenshot captures) |
| Pages build (`npm run build:pages`) | built; `dist/PowerStudio.html` 1,763,487 bytes, sha256 `0c63c366b718ea9a91a966630f132b620158ec835e914b3ad5e8456a20dc5cb6` |

The engine module is 2,324,754 bytes (747,808 gzip-compressed), sha256
`055bdc59fe55997da94e0b7ea7a30f01fc1a5d16b09c0aeeee49f8e1e3be3d92`.

New checks in phase 4:

| Check | Result |
| --- | --- |
| CGMES SSH export read back (`cgmes_ssh.rs`), eleven configurations | an unchanged document gives no SSH; an edited load, voltage target, tap and line read back exactly; a load flow from the exported SV stays within 2.7e-12 p.u. |
| CGMES SSH export read by PowSyBl (`scripts/oracle/ssh_check.py`) | every edited value found on all eleven (three loads are boundary injections PowSyBl folds into dangling lines) |
| Run record hashes (`engine.test.mjs`) | the same request gives the same hashes; moving a busbar leaves the model hash, a load change moves it |
| Engine-held document (`engine.test.mjs`) | every study on the document held open and edited equals the study on the edited document sent whole |
| Projects (`project.test.mjs`) | edits routed to the base, a variant, the scenario and the study case; variants replay over a base changed since |
| Fixed-shape Jacobian | every oracle and PowSyBl agreement test unchanged; the same 2,830 Newton iterations on a 600-outage ACTIVSg10k sample |

Scale in Chromium (the app on the built file, unless named):

| Measurement | Result | Bar |
| --- | --- | --- |
| ACTIVSg70k, every step of the session (import, open, pan, zoom, select, tree, load flow, table) | no frame over 100 ms | no frame over 100 ms: met |
| ACTIVSg70k data sheet (open, scroll, edit, filter, sort, change class) | no frame over 50 ms | met |
| ACTIVSg10k N-1 with reactive limits, 12,899 outages, 8 workers | 116 to 117 s (193 s at the start of the phase) | under 2 min: met |
| The page during that N-1 | 6,952 frames, none over 100 ms (the longest 50 ms) | no frame over 100 ms: met |
| ACTIVSg70k load flow after an edit, with reactive limits (engine) | 0.56 to 0.67 s, 1 or 2 iterations | under 0.5 s: missed |
| ACTIVSg70k edit to result in the app | 1.05 to 1.13 s, with the 250 ms recalculate-on-edit delay | |
| ACTIVSg70k re-solve without reactive limits (`browser-bench.mjs --resolve`) | 345 ms, 2 iterations | under 0.5 s: met |
| ACTIVSg70k layout | median branch 660 units (19,840 before), none over a tenth of the drawing; 2.7 s in the worker | |
| Engine memory at 70,000 buses | 478 MB reading the document whole, 618 MB holding it open | |

## Steady-state completeness, phase 3 (commit `48a21f6`, 2026-10-10, local)

Same environment as phases 1 and 2 (Apple M5 Pro, Chromium 156, Node 26). Local runs only: phase 3 has not been
pushed, so CI has not run it.

| Suite | Result |
| --- | --- |
| Type checking (`npm run check`, both configs) | passed |
| Engine format and lints (`npm run lint:engine`) | passed, no warnings |
| Engine tests, native (`cargo test --release --workspace`) | 72 passed, 0 failed |
| Node tests on the WebAssembly engine (`npm test`) | 72 passed, 0 failed |
| Browser tests (`npm run test:browser`), both projects | 32 passed, 0 failed, 16 skipped (screenshot captures) |
| Pages build (`npm run build:pages`) | built; `dist/PowerStudio.html` 1,404,730 bytes, sha256 `21d0084110869d0d1c6731ecedd06203dca6bd56d0535914ff5a5de04524e561` |

The engine module is 1,947,569 bytes (636,313 gzip-compressed), sha256
`ff3e77d52724b9e9b496fb41763ada78199bff2ee28eabb8e7066e6220cefe8d`.

Agreement, by the engine tests in `engine/crates/ps-study/tests/`:

| Comparison | Cases | Worst agreement |
| --- | --- | --- |
| Load flow controls against OpenLoadFlow (`controls.rs`) | 323 variants: each control alone, all together, stressed targets, on the PSS/E cases, ACTIVSg2000 and 10k | 2.9e-9 p.u., 9.2e-4 MW |
| Contingencies against PowSyBl security analysis (`security.rs`) | every single-element outage of 22 PSS/E cases and ACTIVSg2000 (5,819 outages; 74 left out where OpenLoadFlow does not solve or the outage cuts its slack bus off) | 5.6e-6 MW, 1.5e-8 p.u. (the goldens' nine digits) |
| PTDFs against PowSyBl DC sensitivity analysis (`sensitivity.rs`) | IEEE 14, 39, 118 | 5.0e-11 |
| Screening against full AC (`contingency.rs`) | 22 PSS/E cases and ACTIVSg2000, plain and with reactive limits and ZIP loads; IEEE 14 with each element parked at its limit | no outage that full AC flags is missed; estimates within 0.0005 % and 3.4e-6 p.u. |
| Area interchange against its definition (`interchange.rs`) | IEEE 300, two-area, IEEE 300 through the editor's document | every controlled area within its tolerance or at its slack machines' limits |

Scale in Chromium 156 (`scripts/browser-bench.mjs`, and the app on the built file):

| Measurement | Result | Bar |
| --- | --- | --- |
| ACTIVSg25k load flow, cold start | 210 ms, 4 iterations | under 2 s: met |
| ACTIVSg70k load flow from stored voltages | 747 ms, 6 iterations, 377 MB | under 0.5 s: missed (phase 4) |
| ACTIVSg70k load flow, cold start | does not converge (nor in OpenLoadFlow) | under 2 s: missed |
| ACTIVSg10k N-1, 12,899 contingencies, 8 workers, plain settings | 81 s in full, 62 s with screening | under 2 min: met |
| ACTIVSg10k N-1 as the file opens (reactive limits on) | 199 s, 208 s with screening | under 2 min: missed (phase 4) |

## Data exchange, phase 2 (commit `4d9926d`, 2026-10-09, local)

Same environment as phase 1. Local runs only: phase 2 has not been pushed, so CI has not run it.

| Suite | Result |
| --- | --- |
| Type checking (`npm run check`, both configs) | passed |
| Engine format and lints (`npm run lint:engine`) | passed, no warnings |
| Engine tests, native (`npm run test:engine`) | 53 passed, 0 failed |
| Node tests on the WebAssembly engine (`npm test`) | 64 passed, 0 failed |
| Browser tests (`npm run test:browser`), both projects | 30 passed, 0 failed, 16 skipped (screenshot captures) |
| Pages build (`npm run build:pages`) | built; `dist/PowerStudio.html` 1,147,568 bytes, sha256 `84c9c56fca386631b5dc509841711c4c312edcc2dedbe2bbceae3775cdbccf33` |

The engine module is 1,559,111 bytes (508,608 gzip-compressed), sha256
`8566083a4c8e502850bef20697d50a970c2462678b6f9a25b8c1acf20c6fe237`.

Agreement with PowSyBl (pypowsybl 1.16.1, OpenLoadFlow), by the engine tests in `engine/crates/ps-study/tests/`:

| Comparison | Cases | Worst agreement |
| --- | --- | --- |
| CGMES import and load flow (`cgmes.rs`) | 12 conformity configurations (11 solved, FullGrid import only) | 1.1e-11 p.u., 2.1e-8 MW (Svedala) |
| PSS/E RAW import and load flow (`psse.rs`) | 23 files, versions 33 and 35 (22 solved; one file's data cannot be solved by either tool) | 1.9e-12 p.u., 8.9e-9 MW (IEEE 300) |
| Large MATPOWER cases (`matpower.rs`) | ACTIVSg 2k, 10k, 25k, 70k; PEGASE 2869, 9241, 13659 | 1.1e-10 p.u. (PEGASE 9241); ACTIVSg70k 5.4e-12 p.u. |
| RAW export read back by PowerStudio (`roundtrip.rs`) | every reference model, versions 33 and 35 | 1.5e-14 p.u. |
| RAW export read by PowSyBl (`scripts/oracle/export_check.py`) | 32 cases × 2 versions = 64 files | 4.2e-11 p.u. |
| CGMES SV export read back by PowerStudio (`cgmes_sv.rs`) | 11 configurations | exact; a restart from the SV needs no iteration |
| CGMES SV export read by PowSyBl (`scripts/oracle/sv_check.py`) | 11 configurations | every exported flow taken without difference |
| The editor's document against the imported model (`document.rs`) | every reference model, up to ACTIVSg70k | 1.8e-12 p.u. |

Imports in the app (Chromium 156, built file, Apple M5 Pro): the MicroGrid 3.0 configuration (12 files) shows its
import dialog after 0.13 s, South Carolina 500 after 0.18 s, ACTIVSg2000 after 0.8 s and ACTIVSg10k after 2.9 s; the
first load flow from the imported voltages took 0.03, 0.1, 0.46 and 2.2 s.

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

## Not verified (as of phase 4)

- Firefox, Safari and Chromium on Windows; WebGPU on Linux with a real GPU.
- Touch and pinch gestures on a real phone (the phone layout was tested at 390 × 844 in Chromium).
- Screen readers.
- The short-circuit method against the text of IEC 60909-0 or its TR 60909-4 examples (only against pandapower).
- Drawing by hand on a national network's diagram: ACTIVSg70k is laid out, drawn by level of detail and edited
  through the data sheet in the measurements, but no one has drawn new equipment on it at that scale.
- Real operators' CGMES and RAW files: only the ENTSO-E conformity configurations, PowSyBl's test files and public
  test systems were read.
- PSS/E itself: RAW files written by PowerStudio were read by PowerStudio and by PowSyBl, not by PSS/E.
- The engine build in CI, and its reproducibility on a second machine.
- Area interchange against PSS/E itself: it is tested against the area record's definition only.
- CGMES contingency data, which no conformity configuration carries.
- Real operators' study practice with projects (variants, scenarios, study cases): the behaviour is tested, the
  workflow has not been tried by an operator.
