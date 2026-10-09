#!/usr/bin/env node
/** Builds the calculation engine (Rust, engine/) for WebAssembly and places it at src/engine/powerstudio-engine.wasm,
 * where the source tree loads it and the single-file build embeds it. Its SHA-256 is printed and written next to it.
 *
 * The build is meant to be reproducible: the toolchain is pinned by engine/rust-toolchain.toml, the dependencies by
 * engine/Cargo.lock, and the machine-specific paths that panic locations would embed (the cargo registry and this
 * checkout) are remapped to fixed prefixes. Comparing builds across machines is part of release hardening (phase 7
 * of docs/design/NATIONAL-GRADE.md); until then it is a goal, not a checked property. */

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = join(root, 'engine');
export const ENGINE_WASM = join(root, 'src', 'engine', 'powerstudio-engine.wasm');

const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
// These flags replace the ones in engine/.cargo/config.toml for this build, so SIMD128 is repeated here.
const rustflags = ['-C', 'target-feature=+simd128', `--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${engine}=/engine`].join(' ');
execFileSync('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown', '-p', 'ps-wasm'], {
  cwd: engine, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: rustflags },
});
copyFileSync(join(engine, 'target', 'wasm32-unknown-unknown', 'release', 'ps_wasm.wasm'), ENGINE_WASM);
const bytes = readFileSync(ENGINE_WASM);
const sha = createHash('sha256').update(bytes).digest('hex');
writeFileSync(`${ENGINE_WASM}.sha256`, `${sha}  powerstudio-engine.wasm\n`);
console.log(`Built src/engine/powerstudio-engine.wasm (${(bytes.length / 1024).toFixed(1)} KiB, sha256 ${sha})`);
