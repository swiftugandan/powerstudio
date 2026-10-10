# Testing

## Everyday checks

```sh
npm ci
npm run check          # strict type checking (tsc --checkJs), page and worker configs
npm run lint:engine    # rustfmt and Clippy on the engine, warnings denied
node scripts/fetch-reference.mjs  # once: the CGMES, PSS/E and MATPOWER files the engine tests read (checksums pinned)
npm run test:engine    # the engine's tests, native: oracle goldens, CGMES, PSS/E and large MATPOWER cases against PowSyBl
npm test               # builds the WebAssembly engine, then the Node test runner (see below)
npm run test:browser   # Playwright against dist/PowerStudio.html over HTTP (builds first)
```

The oracle checks run twice, once in each build of the engine: natively in `engine/crates/ps-study/tests/` and as
WebAssembly in `tests/*.test.mjs`, with the same goldens and tolerances. `tests/engine.test.mjs` then runs every
study on every oracle input through both builds and requires their reports to agree to 1e-9 relative (native code
may fuse multiply-adds that WebAssembly rounds twice), and requires repeated runs, on one engine instance and on a
fresh one, to give identical reports.

`npm run test:browser` needs Playwright's Chromium: `npx playwright install chromium`. It runs every scenario twice:

- **webgpu** launches full Chromium with `--enable-unsafe-webgpu` (and on Linux `--use-webgpu-adapter=swiftshader`).
  The first test fails if the app does not end up drawing with WebGPU, so this project proves the WebGPU path, not
  just the badge.
- **canvas** launches Chromium's headless shell, which offers no WebGPU adapter. The app must fall back to Canvas 2D
  and say why.

Pixel checks decode Playwright screenshots (`tests/browser/png.mjs`) and look for the diagram's voltage-level colours,
so a blank canvas fails.

## Documentation screenshots

```sh
PS_SCREENSHOTS=1 npx playwright test screenshots --project=webgpu
```

writes `docs/screenshots/*.png` and `docs/screenshots/manifest.json`, which records the backend each capture was
drawn with.

## Oracle goldens

The oracle tests compare against results produced by two independent programs (see `docs/research/sources.md`).
The goldens are committed; CI compares against them but does not regenerate them. To regenerate after changing a
sample:

```sh
node scripts/export-oracle-inputs.mjs           # samples → tests/oracle/inputs/*.json
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r scripts/oracle/requirements.txt
.venv/bin/python scripts/oracle/oracle.py       # → tests/oracle/golden/*.json
```

The CGMES goldens come from PowSyBl through pypowsybl (same environment):

```sh
.venv/bin/python scripts/oracle/cgmes.py            # every case in tests/oracle/cgmes-cases.json
.venv/bin/python scripts/oracle/cgmes.py minigrid-3 # one case
.venv/bin/python scripts/oracle/psse.py             # every case in tests/oracle/psse-cases.json
.venv/bin/python scripts/oracle/psse.py ieee300     # one case
.venv/bin/python scripts/oracle/matpower.py         # every case in tests/oracle/matpower-cases.json
.venv/bin/python scripts/oracle/controls.py         # load flow controls, one at a time and together
.venv/bin/python scripts/oracle/security.py         # every single-element outage (security analysis)
.venv/bin/python scripts/oracle/sensitivity.py      # DC power transfer distribution factors
```

Both use the OpenLoadFlow settings in `scripts/oracle/olf.py`: a plain Newton-Raphson with every control off, so the
comparison tests the network model rather than control strategies. Where PowSyBl's import departs from the format's
definition, the script corrects PowSyBl's network and records the correction in the golden (`removed` for CGMES,
`corrected` for PSS/E); docs/research/sources.md cites the source for each. The comparison tests
(`engine/crates/ps-study/tests/cgmes.rs`, `psse.rs` and `matpower.rs`) check voltages to 1e-6 p.u. and 1e-4°, flows to 1e-3 MW or
Mvar and imported data to 1e-9 relative, and print the worst difference per quantity with `--nocapture`:

```sh
cd engine && cargo test --release -p ps-study --test psse -- --nocapture
```

The PSS/E RAW export is checked both ways. `engine/crates/ps-study/tests/roundtrip.rs` (part of `npm run test:engine`)
writes every reference model as RAW 33 and 35, reads it back with PowerStudio's importer and compares every node's
voltage. `scripts/oracle/export_check.py` has PowSyBl read the same files and compares its load flow with
PowerStudio's; it needs the release `ps` program and writes nothing into the repository:

```sh
cd engine && cargo build --release -p ps-cli && cd ..
.venv/bin/python scripts/oracle/export_check.py    # every CGMES and PSS/E case, both versions
```

Opening other tools' files in the app is checked by `engine/crates/ps-study/tests/document.rs`, which converts every
reference model into the editor's document and requires its load flow to reproduce the model's, and by
`tests/import.test.mjs`, which imports MATPOWER and RAW files through the WebAssembly engine
(`tests/fixtures/case14.raw` is MATPOWER case14 written by `ps export --raw 33`) and lays out a 600-bus network.

CGMES state variables export is checked the same two ways: `engine/crates/ps-study/tests/cgmes_sv.rs` reads every
exported SV back with PowerStudio's importer, and `scripts/oracle/sv_check.py` has PowSyBl read it in place of each
configuration's own SV and compares the flows it takes with PowerStudio's. CGMES SSH export is checked by
`engine/crates/ps-study/tests/cgmes_ssh.rs`, which edits each configuration's operating point and reads it back, and
by `scripts/oracle/ssh_check.py`, which has PowSyBl read the files that test writes when `PS_SSH_DIR` is set.

A case whose files no load flow can solve is marked `"loadflow": false` with the reason in `why`; its import is
still compared. `ps cgmes <files>` and `ps psse <file.raw>` print an import's report, validation and, with `--lf`,
a load flow, which is the quickest way to look at a case that fails.

`tests/oracle.test.mjs` fails when the committed inputs no longer match the samples, so a sample cannot drift away
from its goldens unnoticed. Moving a busbar on the diagram changes the inputs but not the goldens.

## Stability against ANDES

The stability goldens (`tests/oracle/golden/dyn-*.json`) come from ANDES 2.0.0 (GPL-3.0), run on its own published
PSS/E RAW and DYR files, which `node scripts/fetch-reference.mjs` downloads from ANDES's repository at a pinned commit
into `.cache/reference` (they are never copied into the repository). `tests/oracle/dyn-cases.json` lists the cases:
the files, the events, ANDES's step (`tstep`), the engine's (`step`), the sampling, and for models no published DYR case
uses, a `replace` entry giving a machine another control. ANDES is in the oracle environment
(`scripts/oracle/requirements.txt`):

```sh
.venv/bin/python scripts/oracle/andes_dyn.py                 # every case → tests/oracle/golden/dyn-*.json
.venv/bin/python scripts/oracle/andes_dyn.py ieee14-fault    # one case
.venv/bin/python scripts/oracle/andes_dyn.py --tstep 0.0005 --out /tmp/half   # ANDES at another step, elsewhere
cd engine && PS_DYN_REPORT=1 cargo test --release -p ps-study --test dynamics -- --nocapture
```

The script removes ANDES's own `Toggle` records from the DYR files, adds the case's events, runs ANDES's load flow to
1e-12 and its fixed-step trapezoidal simulation to a Newton tolerance of 1e-10, and records ANDES's load flow, every
model's variables after initialisation, and the traces at the steps nearest the sample times. It corrects ANDES in two
places where its per-unit handling departs from the PSS/E library (ESST3A's terminal current and IEEEG1's valve rate
limits are left on the system base; KI and XL, and UO and UC, are rescaled so ANDES computes them on the machine's
base), and the WECC case sets ESDC2A's TR to zero in both programs because ANDES computes ESDC2A's transducer but does
not use it. The golden records what was changed.

The test runs each case twice and compares at ANDES's time points, the engine's trajectory interpolated there. The
tolerances come from measurements, not choice:

- **Event stepping.** ANDES lands steps 0.1 ms before and after each event, and its first step after an event averages
  the new derivatives with those before it. That first-order error decays with the subtransient time constants and, on
  WECC, excites swings that last seconds. The first run uses ANDES's stepping (`EventSteps::Andes`) and is compared
  everywhere except within two steps of an event; the second uses the engine's own and is compared from 0.3 s after
  each event, to three times the tolerance.
- **Anti-windup limits.** Where every exciter reaches its ceiling (Kundur with a fault), ANDES's trajectory depends on
  its step: from 1 ms to 0.5 ms to 0.25 ms its rotor angles move from 8.5e-3 to 5.1e-3 to 1.0e-3 rad away from the
  engine's, towards them. ANDES therefore runs at 0.25 ms and the engine at 1 ms; ANDES at 1 ms is further from ANDES
  at 0.25 ms than the engine is.
- **The engine's own step.** The IEEE 14-bus system's EXST1 exciter (KA = 50, TA = 20 ms) differs by 1e-3 p.u. in field
  voltage during a fault at 1 ms and by 7e-5 at 0.25 ms.
- **Load flow.** The WECC load flows differ by up to 1.8e-6 p.u. in voltage, which moves the slack machine's power by
  3.7e-4 p.u. throughout.

`PS_DYN_DUMP=<folder>` writes every compared value with ANDES's as CSV; `PS_DYN_STEP` runs the engine at another step.

## WebGPU in other environments

`node scripts/webgpu-probe.mjs` (after `node build.mjs`) opens the built app in Chromium with several flag sets and
prints, for each, the backend the app chose, its reason, and the share of diagram pixels in both a screenshot and the
renderer's own read-back frame. The manual "WebGPU probe" workflow runs it on GitHub's Ubuntu runners.
