#!/usr/bin/env node
/** Checks that the WebAssembly engine builds to the same bytes from another place: it copies engine/ (without its
 * target directory) into a temporary directory and builds it there with a fresh cargo home, which downloads the locked
 * dependencies again, and a fresh target directory. The result must equal src/engine/powerstudio-engine.wasm, built
 * by `npm run build:engine` first. Exit status 1 and both hashes when they differ.
 *
 *     node scripts/check-reproducible.mjs
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ENGINE_DIR, ENGINE_WASM, buildWasm, sha256 } from './build-engine.mjs';

if (!existsSync(ENGINE_WASM)) {
  console.error('Build the engine first: npm run build:engine');
  process.exit(2);
}
const here = sha256(readFileSync(ENGINE_WASM));
const scratch = mkdtempSync(join(tmpdir(), 'powerstudio-repro-'));
try {
  const engineDir = join(scratch, 'checkout', 'engine');
  cpSync(ENGINE_DIR, engineDir, {
    recursive: true,
    filter: src => !relative(ENGINE_DIR, src).split(sep).includes('target'),
  });
  console.log(`Building again in ${engineDir} with a fresh cargo home…`);
  const there = sha256(buildWasm({ engineDir, cargoHome: join(scratch, 'cargo'), targetDir: join(scratch, 'target'), quiet: true }));
  if (there !== here) {
    console.error(`Not reproducible:\n  ${here}  src/engine/powerstudio-engine.wasm\n  ${there}  the build in ${scratch}`);
    process.exitCode = 1;
  } else {
    console.log(`Reproducible: both builds are ${here}.`);
  }
} finally {
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
}
