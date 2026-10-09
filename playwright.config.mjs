/** Browser tests run against the built single-file app (dist/PowerStudio.html) served over HTTP.
 * Two projects: "webgpu" launches full Chromium with WebGPU enabled; "canvas" launches the headless shell, which has
 * no WebGPU adapter, so the Canvas 2D fallback is what it exercises. */
import { defineConfig } from '@playwright/test';

const port = 8771;
const linux = process.platform === 'linux';

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '*.spec.mjs',
  outputDir: 'test-results/artifacts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list'], ['json', { outputFile: 'test-results/browser-report.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/build-engine.mjs && node build.mjs && node serve.mjs',
    env: { SERVE_ROOT: 'dist', PORT: String(port) },
    url: `http://127.0.0.1:${port}/PowerStudio.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'webgpu',
      use: {
        browserName: 'chromium',
        channel: 'chromium',
        launchOptions: { args: ['--enable-unsafe-webgpu', ...(linux ? ['--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'] : [])] },
      },
    },
    { name: 'canvas', use: { browserName: 'chromium' } },
  ],
});
