#!/usr/bin/env node
/** Builds the calculation engine (Rust, engine/) for WebAssembly and places it at src/engine/powerstudio-engine.wasm,
 * where the source tree loads it and the single-file build embeds it. Its SHA-256 is printed and written next to it.
 *
 * The build is reproducible: the toolchain is pinned by engine/rust-toolchain.toml, the dependencies by
 * engine/Cargo.lock, and the machine-specific paths that panic locations would embed (the cargo registry and the
 * checkout) are remapped to fixed prefixes. `scripts/check-reproducible.mjs` builds again from a copy elsewhere, with
 * its own cargo home and target directory, and requires the same bytes; CI compares builds on two operating systems. */

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_DIR = join(root, 'engine');
export const ENGINE_WASM = join(root, 'src', 'engine', 'powerstudio-engine.wasm');

/**
 * Builds the WebAssembly engine from `engineDir` and returns its bytes. The cargo home and the checkout are remapped
 * to `/cargo` and `/engine`, so the bytes do not depend on where either lies.
 * @param {{ engineDir?: string, targetDir?: string, cargoHome?: string, quiet?: boolean }} [options]
 * @returns {Buffer}
 */
export function buildWasm({ engineDir = ENGINE_DIR, targetDir, cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo'), quiet = false } = {}) {
  // These flags replace the ones in engine/.cargo/config.toml for this build, so SIMD128 is repeated here.
  const rustflags = ['-C', 'target-feature=+simd128', `--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${engineDir}=/engine`].join(' ');
  const target = targetDir ?? join(engineDir, 'target');
  execFileSync('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown', '-p', 'ps-wasm'], {
    cwd: engineDir,
    stdio: quiet ? 'ignore' : 'inherit',
    env: { ...process.env, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: target, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: rustflags },
  });
  return readFileSync(join(target, 'wasm32-unknown-unknown', 'release', 'ps_wasm.wasm'));
}

/** @param {Uint8Array} bytes */
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildWasm();
  copyFileSync(join(ENGINE_DIR, 'target', 'wasm32-unknown-unknown', 'release', 'ps_wasm.wasm'), ENGINE_WASM);
  const bytes = readFileSync(ENGINE_WASM);
  const sha = sha256(bytes);
  writeFileSync(`${ENGINE_WASM}.sha256`, `${sha}  powerstudio-engine.wasm\n`);
  console.log(`Built src/engine/powerstudio-engine.wasm (${(bytes.length / 1024).toFixed(1)} KiB, sha256 ${sha})`);
}
