/** Host side of the engine's WebAssembly boundary: instantiates the module and exchanges envelopes with it.
 *
 * An envelope is a little-endian u32 header length, a UTF-8 JSON header and an optional binary payload. The engine has
 * one entry point, `ps_call`; requests name an operation in their header's `op` (engine/crates/ps-wasm/src/engine.rs
 * lists them). This module runs unchanged on the main thread, in a worker and in Node, so the engine tests need no
 * browser. */

/** @typedef {{ header: Record<string, any>, payload: Uint8Array }} Envelope */
/** @typedef {{ memory: WebAssembly.Memory, ps_alloc: (n: number) => number, ps_free: (p: number, n: number) => void, ps_call: (p: number, n: number) => number }} EngineExports */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class EngineHost {
  /** @param {WebAssembly.Instance} instance @param {{ progress: ((done: number, total: number) => void) | null }} hooks */
  constructor(instance, hooks) {
    this.exports = /** @type {EngineExports} */ (/** @type {unknown} */ (instance.exports));
    this.hooks = hooks;
  }

  /** The engine's WebAssembly memory, in bytes: the most it has needed, since such memory never shrinks. */
  get memoryBytes() { return this.exports.memory.buffer.byteLength; }

  /** Instantiates the engine from a compiled module or its bytes. @param {WebAssembly.Module | BufferSource} source */
  static async create(source) {
    const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    /** @type {{ progress: ((done: number, total: number) => void) | null }} */
    const hooks = { progress: null };
    const imports = { env: { ps_now: now, ps_progress: (/** @type {number} */ done, /** @type {number} */ total) => hooks.progress?.(done, total) } };
    const instance = source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, imports)
      : (await WebAssembly.instantiate(source, imports)).instance;
    return new EngineHost(instance, hooks);
  }

  /**
   * Sends one request and returns the reply. Throws when the engine reports an error.
   * @param {Record<string, any>} header @param {Uint8Array} [payload] @param {(done: number, total: number) => void} [onProgress]
   * @returns {Envelope}
   */
  call(header, payload = new Uint8Array(0), onProgress) {
    const head = encoder.encode(JSON.stringify(header));
    const len = 4 + head.length + payload.length;
    const { ps_alloc, ps_free, ps_call } = this.exports;
    const ptr = ps_alloc(len);
    let mem = new Uint8Array(this.exports.memory.buffer);
    new DataView(mem.buffer).setUint32(ptr, head.length, true);
    mem.set(head, ptr + 4);
    mem.set(payload, ptr + 4 + head.length);
    this.hooks.progress = onProgress ?? null;
    let out;
    try { out = ps_call(ptr, len); }
    finally { this.hooks.progress = null; ps_free(ptr, len); }
    // The call may have grown memory; take fresh views.
    mem = new Uint8Array(this.exports.memory.buffer);
    const view = new DataView(mem.buffer);
    const total = view.getUint32(out, true);
    const hlen = view.getUint32(out + 4, true);
    const reply = JSON.parse(decoder.decode(mem.subarray(out + 8, out + 8 + hlen)));
    const body = mem.slice(out + 8 + hlen, out + total);
    ps_free(out, total);
    if (reply.ok === false) throw new Error(reply.error);
    return { header: reply, payload: body };
  }

  /** The engine's version. */
  version() {
    return /** @type {string} */ (this.call({ op: 'version' }).header.engine);
  }
}

/** Reads a JSON payload. @param {Uint8Array} bytes */
export function jsonPayload(bytes) {
  return JSON.parse(decoder.decode(bytes));
}

/** Encodes text for a payload. @param {string} text */
export function textPayload(text) {
  return encoder.encode(text);
}
