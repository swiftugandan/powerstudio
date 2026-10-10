#!/usr/bin/env node
/** Writes the software bill of materials of a build as CycloneDX 1.6 JSON (dist/PowerStudio.cdx.json by default).
 *
 * What the app ships is its own code and the WebAssembly engine; the engine's components are the Rust crates that
 * ps-wasm builds from for wasm32 (from `cargo metadata`, with the checksums Cargo.lock pins). The npm packages are
 * build and test tools that nothing in the app contains, listed with scope "excluded" (CycloneDX: not part of the
 * runtime). The document is deterministic: its timestamp is the commit's time and its serial number comes from its
 * content, so the same commit gives the same file.
 *
 *     node scripts/sbom.mjs [out.json]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'dist', 'PowerStudio.cdx.json');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** @typedef {{ type: string, 'bom-ref': string, name: string, version: string, scope: string, purl: string,
 *   licenses?: Array<{ expression: string }>, hashes?: Array<{ alg: string, content: string }>, description?: string }} Component */

/** The crates the WebAssembly engine is built from: ps-wasm's normal dependencies, transitively, for wasm32. */
function crates() {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', 'wasm32-unknown-unknown'], {
    cwd: join(root, 'engine'), encoding: 'utf8', maxBuffer: 64 << 20,
  }));
  const lock = readFileSync(join(root, 'engine', 'Cargo.lock'), 'utf8');
  /** @type {Map<string, string>} name@version → sha256 of the .crate file */
  const checksums = new Map();
  for (const block of lock.split('[[package]]').slice(1)) {
    const field = (/** @type {string} */ k) => block.match(new RegExp(`^${k} = "([^"]+)"`, 'm'))?.[1];
    const sum = field('checksum');
    if (sum) checksums.set(`${field('name')}@${field('version')}`, sum);
  }
  const packages = new Map(meta.packages.map((/** @type {any} */ p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((/** @type {any} */ n) => [n.id, n]));
  const start = meta.packages.find((/** @type {any} */ p) => p.name === 'ps-wasm').id;
  const seen = new Set([start]), stack = [start];
  while (stack.length) {
    const id = stack.pop();
    for (const d of nodes.get(id).deps) {
      if (d.dep_kinds.some((/** @type {any} */ k) => k.kind === null) && !seen.has(d.pkg)) { seen.add(d.pkg); stack.push(d.pkg); }
    }
  }
  return [...seen].map(id => {
    const p = /** @type {any} */ (packages.get(id));
    const local = !p.source;
    const sum = checksums.get(`${p.name}@${p.version}`);
    /** @type {Component} */
    const c = {
      type: local ? 'application' : 'library', 'bom-ref': `pkg:cargo/${p.name}@${p.version}`, name: p.name, version: p.version,
      scope: 'required', purl: `pkg:cargo/${p.name}@${p.version}`,
    };
    if (p.license) c.licenses = [{ expression: p.license }];
    if (sum) c.hashes = [{ alg: 'SHA-256', content: sum }];
    if (local) c.description = 'PowerStudio engine crate (engine/ in this repository)';
    return c;
  });
}

/** The npm packages the build and tests use: nothing in the app contains them. */
function npmTools() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([path]) => path.startsWith('node_modules/'))
    .map(([path, /** @type {any} */ p]) => {
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const purl = `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${p.version}`;
      /** @type {Component} */
      const c = { type: 'library', 'bom-ref': purl, name, version: p.version, scope: 'excluded', purl };
      if (p.license) c.licenses = [{ expression: p.license }];
      const sri = /** @type {string | undefined} */ (p.integrity)?.match(/^sha512-(.+)$/)?.[1];
      if (sri) c.hashes = [{ alg: 'SHA-512', content: Buffer.from(sri, 'base64').toString('hex') }];
      return c;
    });
}

const components = [...crates(), ...npmTools()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
let time;
try { time = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: root, encoding: 'utf8' }).trim(); } catch { time = undefined; }
const body = {
  bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
  metadata: {
    ...(time ? { timestamp: new Date(time).toISOString().replace(/\.\d+Z$/, 'Z') } : {}),
    component: {
      type: 'application', 'bom-ref': `pkg:github/swiftugandan/powerstudio@${pkg.version}`, name: 'PowerStudio', version: pkg.version,
      description: pkg.description, licenses: [{ expression: pkg.license }], purl: `pkg:github/swiftugandan/powerstudio@v${pkg.version}`,
    },
    tools: { components: [{ type: 'application', name: 'scripts/sbom.mjs', description: 'PowerStudio’s own SBOM writer' }] },
  },
  components,
  dependencies: [{ ref: `pkg:github/swiftugandan/powerstudio@${pkg.version}`, dependsOn: components.filter(c => c.scope === 'required').map(c => c['bom-ref']) }],
};
// A serial number from the content: the same commit gives the same document.
const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${(8 + (parseInt(digest[16], 16) & 3)).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
const sbom = { bomFormat: body.bomFormat, specVersion: body.specVersion, serialNumber: `urn:uuid:${uuid}`, version: 1, metadata: body.metadata, components, dependencies: body.dependencies };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(sbom, null, 1)}\n`);
console.log(`Wrote ${out}: ${components.filter(c => c.scope === 'required').length} components in the engine, ${components.filter(c => c.scope === 'excluded').length} build and test tools.`);
