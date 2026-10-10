#!/usr/bin/env node
/** Builds the calculation engine (Rust, engine/) for WebAssembly and places it at src/engine/powerstudio-engine.wasm,
 * where the source tree loads it and the single-file build embeds it. Its SHA-256 is printed and written next to it.
 *
 *     node scripts/build-engine.mjs                     with the machine's own toolchain
 *     node scripts/build-engine.mjs --container [--ca certificates.pem]
 *                                                       as releases are built: in the pinned image below
 *
 * The build is reproducible for a given build host: the toolchain is pinned by engine/rust-toolchain.toml, the
 * dependencies by engine/Cargo.lock, and the machine-specific paths that panic locations would embed (the cargo
 * registry and the checkout) are remapped to fixed prefixes. The host itself cannot be taken out: Cargo folds the
 * build host's target triple into the identity of build scripts and proc-macros, which reaches every crate's symbol
 * hashes and so the order of the functions in the output. Releases are therefore built on Linux on x86_64 (GitHub's
 * Ubuntu runners), and `--container` gives that environment on any machine with Docker (emulated on Arm, slowly).
 * `--ca` adds certificates the container should trust, for networks that inspect TLS. `scripts/check-reproducible.mjs`
 * builds again from a copy elsewhere, with its own cargo home and target directory, and requires the same bytes; CI
 * compares the runner's own build with the container's. */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_DIR = join(root, 'engine');
export const ENGINE_WASM = join(root, 'src', 'engine', 'powerstudio-engine.wasm');
/** The release build's environment: the Rust project's Debian image for the pinned toolchain, on Linux x86_64. */
export const BUILD_IMAGE = 'rust:1.96.0-bookworm@sha256:c993d32d95cc146bd12c84d66f0b924a6a96f3988325f39c144f2f9893dea120';
export const BUILD_PLATFORM = 'linux/amd64';

/** The flags of every engine build: SIMD128, and the cargo home and checkout remapped to fixed prefixes. They replace
 * the ones in engine/.cargo/config.toml, so SIMD128 is repeated here. @param {string} cargoHome @param {string} engineDir */
const rustflags = (cargoHome, engineDir) => ['-C', 'target-feature=+simd128', `--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${engineDir}=/engine`].join(' ');

/**
 * Builds the WebAssembly engine from `engineDir` and returns its bytes. The cargo home and the checkout are remapped
 * to `/cargo` and `/engine`, so the bytes do not depend on where either lies.
 * @param {{ engineDir?: string, targetDir?: string, cargoHome?: string, quiet?: boolean }} [options]
 * @returns {Buffer}
 */
export function buildWasm({ engineDir = ENGINE_DIR, targetDir, cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo'), quiet = false } = {}) {
  const target = targetDir ?? join(engineDir, 'target');
  execFileSync('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown', '-p', 'ps-wasm'], {
    cwd: engineDir,
    stdio: quiet ? 'ignore' : 'inherit',
    env: { ...process.env, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: target, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: rustflags(cargoHome, engineDir) },
  });
  return readFileSync(join(target, 'wasm32-unknown-unknown', 'release', 'ps_wasm.wasm'));
}

/**
 * Builds the engine as releases are built, in BUILD_IMAGE on BUILD_PLATFORM: the checkout is copied into the
 * container (without its target directory) and built there with a fresh cargo home. Returns the bytes.
 * @param {{ engineDir?: string, ca?: string, quiet?: boolean }} [options] `ca`: a PEM file of certificates to trust
 * @returns {Buffer}
 */
export function buildWasmInContainer({ engineDir = ENGINE_DIR, ca, quiet = false } = {}) {
  // The output folder lies in the checkout's target directory: Docker Desktop shares the home folder with containers,
  // not the system's temporary folder.
  const target = join(engineDir, 'target');
  mkdirSync(target, { recursive: true });
  const out = mkdtempSync(join(target, 'container-'));
  try {
    const trust = ca ? 'cp /ca.pem /usr/local/share/ca-certificates/extra.crt && update-ca-certificates >/dev/null && export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt RUSTUP_USE_CURL=1 && ' : '';
    const script = `set -e; ${trust}mkdir /engine && tar -C /src --exclude=./target -cf - . | tar -C /engine -xf - && cd /engine && `
      + `CARGO_HOME=/cargo-home CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='${rustflags('/cargo-home', '/engine')}' `
      + 'cargo build --release --locked --target wasm32-unknown-unknown -p ps-wasm && cp target/wasm32-unknown-unknown/release/ps_wasm.wasm /out/';
    execFileSync('docker', ['run', '--rm', '--platform', BUILD_PLATFORM, '-v', `${engineDir}:/src:ro`, '-v', `${out}:/out`,
      ...(ca ? ['-v', `${ca}:/ca.pem:ro`] : []), BUILD_IMAGE, 'bash', '-c', script], { stdio: quiet ? 'ignore' : 'inherit' });
    return readFileSync(join(out, 'ps_wasm.wasm'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** @param {Uint8Array} bytes */
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--ca');
  if (args.includes('--container')) {
    writeFileSync(ENGINE_WASM, buildWasmInContainer({ ca: at >= 0 ? args[at + 1] : undefined }));
  } else {
    buildWasm();
    copyFileSync(join(ENGINE_DIR, 'target', 'wasm32-unknown-unknown', 'release', 'ps_wasm.wasm'), ENGINE_WASM);
  }
  const bytes = readFileSync(ENGINE_WASM);
  const sha = sha256(bytes);
  writeFileSync(`${ENGINE_WASM}.sha256`, `${sha}  powerstudio-engine.wasm\n`);
  console.log(`Built src/engine/powerstudio-engine.wasm (${(bytes.length / 1024).toFixed(1)} KiB, sha256 ${sha})`);
}
