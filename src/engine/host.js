/** Host side of the engine's WebAssembly boundary: instantiates the module and exchanges envelopes with it.
 *
 * An envelope is a little-endian u32 header length, a UTF-8 JSON header and an optional binary payload. The engine has
 * one entry point, `ps_call`; requests name an operation in their header's `op`. This module works the same in a
 * browser worker and in Node, so the engine tests run without a browser. */

/** @typedef {{ header: Record<string, any>, payload: Uint8Array }} Envelope */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class EngineHost {
  /** @param {WebAssembly.Instance} instance */
  constructor(instance) {
    this.exports = /** @type {{ memory: WebAssembly.Memory, ps_alloc: (n: number) => number, ps_free: (p: number, n: number) => void, ps_call: (p: number, n: number) => number }} */ (/** @type {unknown} */ (instance.exports));
  }

  /** Instantiates the engine from its compiled bytes. @param {BufferSource} bytes */
  static async create(bytes) {
    const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    const { instance } = await WebAssembly.instantiate(bytes, { env: { ps_now: now } });
    return new EngineHost(instance);
  }

  /**
   * Sends one request and returns the reply. Throws when the engine reports an error.
   * @param {Record<string, any>} header @param {Uint8Array} [payload] @returns {Envelope}
   */
  call(header, payload = new Uint8Array(0)) {
    const head = encoder.encode(JSON.stringify(header));
    const len = 4 + head.length + payload.length;
    const { ps_alloc, ps_free, ps_call } = this.exports;
    const ptr = ps_alloc(len);
    let mem = new Uint8Array(this.exports.memory.buffer);
    new DataView(mem.buffer).setUint32(ptr, head.length, true);
    mem.set(head, ptr + 4);
    mem.set(payload, ptr + 4 + head.length);
    const out = ps_call(ptr, len);
    ps_free(ptr, len);
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
}

/** Reads a payload of little-endian f64 values. @param {Uint8Array} bytes */
export function f64s(bytes) {
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
}
