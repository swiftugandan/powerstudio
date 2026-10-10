/** CGMES conformity cases for tests, read from the ENTSO-E archives in `.cache/reference` (fetched by
 * `node scripts/fetch-reference.mjs`; they are never copied into the repository). */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The files of a CGMES conformity case listed in tests/oracle/cgmes-cases.json, read from its archive in
 * `.cache/reference` (`node scripts/fetch-reference.mjs` fetches it; the ENTSO-E files are never copied into the
 * repository). Returns null when the archive is not there.
 * @param {string} name @returns {Array<{ name: string, bytes: Uint8Array }> | null}
 */
export function cgmesCase(name) {
  const cases = JSON.parse(readFileSync(join(root, 'tests/oracle/cgmes-cases.json'), 'utf8'));
  const c = cases.cases.find((/** @type {any} */ x) => x.name === name);
  if (!c) throw new Error(`no CGMES case ${name}`);
  let archive;
  try { archive = readFileSync(join(root, '.cache/reference', cases.archives[c.archive].file)); } catch { return null; }
  return unzip(archive).filter(e => c.entries.some((/** @type {string} */ p) => e.name.startsWith(p)));
}

/** The entries of a ZIP archive, stored or deflated. @param {Buffer} zip @returns {Array<{ name: string, bytes: Uint8Array }>} */
function unzip(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(data, data + size);
    out.push({ name, bytes: new Uint8Array(method === 8 ? inflateRawSync(raw) : raw) });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}
