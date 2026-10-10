/** Loads and compiles the engine's WebAssembly module, once per page. The single-file build embeds the module as
 * gzip-compressed base64 in `globalThis.__POWERSTUDIO_ENGINE__`; the source tree serves it as a file next to this
 * one (built by `npm run build:engine`). The compiled module is shared with every worker, which instantiates it
 * without compiling again. */

/** @type {Promise<WebAssembly.Module> | null} */
let compiled = null;
/** SHA-256 of the module's bytes, as run records cite it ('' where WebCrypto is unavailable). */
let digest = '';

/** The engine's compiled module. */
export function engineModule() {
  compiled ??= load().catch(error => { compiled = null; throw error; });
  return compiled;
}

/** SHA-256 of the engine's WebAssembly, once it has loaded. */
export async function engineDigest() {
  await engineModule();
  return digest;
}

async function load() {
  const bytes = await read();
  try {
    digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { digest = ''; }
  return WebAssembly.compile(bytes);
}

/** The module's bytes, from the single-file build or the source tree. @returns {Promise<ArrayBuffer>} */
async function read() {
  const embedded = /** @type {{ __POWERSTUDIO_ENGINE__?: string }} */ (globalThis).__POWERSTUDIO_ENGINE__;
  if (embedded) {
    const packed = Uint8Array.from(atob(embedded), ch => ch.charCodeAt(0));
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  const response = await fetch('./src/engine/powerstudio-engine.wasm');
  if (!response.ok) throw new Error('The calculation engine is missing: run npm run build:engine.');
  return response.arrayBuffer();
}
