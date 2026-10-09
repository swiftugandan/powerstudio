#!/usr/bin/env node
/** Builds the calculation engine (Rust, engine/) for WebAssembly and places it at src/engine/powerstudio-engine.wasm,
 * where the source tree loads it and the single-file build embeds it. The toolchain is pinned by
 * engine/rust-toolchain.toml and the dependencies by engine/Cargo.lock, so the module is reproducible; its SHA-256 is
 * printed and written next to it. */

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = join(root, 'engine');
export const ENGINE_WASM = join(root, 'src', 'engine', 'powerstudio-engine.wasm');

execFileSync('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown', '-p', 'ps-wasm'], { cwd: engine, stdio: 'inherit' });
copyFileSync(join(engine, 'target', 'wasm32-unknown-unknown', 'release', 'ps_wasm.wasm'), ENGINE_WASM);
const bytes = readFileSync(ENGINE_WASM);
const sha = createHash('sha256').update(bytes).digest('hex');
writeFileSync(`${ENGINE_WASM}.sha256`, `${sha}  powerstudio-engine.wasm\n`);
console.log(`Built src/engine/powerstudio-engine.wasm (${(bytes.length / 1024).toFixed(1)} KiB, sha256 ${sha})`);
