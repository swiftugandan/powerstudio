# Testing

## Everyday checks

```sh
npm ci
npm run check          # strict type checking (tsc --checkJs), page and worker configs
npm test               # Node test runner: engine, store, import, diagram, build
npm run test:browser   # Playwright against dist/PowerStudio.html over HTTP (builds first)
```

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

The engine tests compare against results produced by two independent programs (see `docs/research/sources.md`).
The goldens are committed; CI compares against them but does not regenerate them. To regenerate after changing a
sample:

```sh
node scripts/export-oracle-inputs.mjs           # samples → tests/oracle/inputs/*.json
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r scripts/oracle/requirements.txt
.venv/bin/python scripts/oracle/oracle.py       # → tests/oracle/golden/*.json
```

`tests/oracle.test.mjs` fails when the committed inputs no longer match the samples, so a sample cannot drift away
from its goldens unnoticed. Moving a busbar on the diagram changes the inputs but not the goldens.

## WebGPU in other environments

`node scripts/webgpu-probe.mjs` (after `node build.mjs`) opens the built app in Chromium with several flag sets and
prints, for each, the backend the app chose, its reason, and the share of diagram pixels in both a screenshot and the
renderer's own read-back frame. The manual "WebGPU probe" workflow runs it on GitHub's Ubuntu runners.
