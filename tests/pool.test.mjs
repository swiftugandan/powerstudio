import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineClient } from '../src/ui/engine-client.js';

/**
 * A stand-in for the calculation worker: answers a contingency plan, chunks and the merge as the real worker does, and
 * can be told to fail a chunk the way an engine that runs out of memory fails.
 */
class FakeWorker {
  /** @param {{ failFirstChunk: boolean, log: string[] }} opt */
  constructor(opt) {
    this.opt = opt;
    /** @type {((e: { data: any }) => void) | null} */
    this.onmessage = null;
    /** @type {((e: any) => void) | null} */
    this.onerror = null;
    this.terminated = false;
  }

  /** @param {any} msg */
  postMessage(msg) {
    if (msg.type === 'init' || msg.type === 'doc' || msg.type === 'ops') return;
    setTimeout(() => {
      if (this.terminated) return;
      const json = (/** @type {unknown} */ v) => new TextEncoder().encode(JSON.stringify(v));
      const reply = (/** @type {Uint8Array} */ bytes) => this.onmessage?.({ data: { id: msg.id, type: 'result', bytes, ms: 1, memory: 64 * 2 ** 20 } });
      if (msg.kind === 'contingency_plan') return reply(json({ count: 160 }));
      if (msg.kind === 'contingency_chunk') {
        if (this.opt.failFirstChunk) {
          this.opt.failFirstChunk = false;
          return this.onmessage?.({ data: { id: msg.id, type: 'error', message: 'RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded' } });
        }
        this.opt.log.push(`${msg.options.from}-${msg.options.to}`);
        return reply(json({ from: msg.options.from, to: msg.options.to }));
      }
      if (msg.type === 'call') {
        // The merge: the chunks as the workers wrote them, in chunk order.
        const text = new TextDecoder().decode(msg.payload);
        return this.onmessage?.({ data: { id: msg.id, type: 'result', bytes: new TextEncoder().encode(JSON.stringify({ merged: text })), header: {}, ms: 1 } });
      }
    }, 1);
  }

  terminate() { this.terminated = true; }
}

test('a worker that runs out of memory ends, and the others finish its chunks in order', async () => {
  /** @type {string[]} */
  const log = [];
  let made = 0;
  // The second worker fails its first chunk for want of memory.
  const client = new EngineClient(() => /** @type {any} */ (new FakeWorker({ failFirstChunk: made++ === 1, log })), { poolSize: 3 });
  const doc = /** @type {any} */ ({ elements: [] });
  const result = await client.contingency(client.token, /** @type {any} */ ({}), doc, undefined);
  assert.equal(client.shrunk, 1, 'one worker ended');
  // Every chunk was solved once and merged in order, so the result is the sequential one.
  const merged = JSON.parse(JSON.parse(new TextDecoder().decode(result.bytes)).merged.replace(/}{/g, '},{').replace(/^/, '[').replace(/$/, ']'));
  assert.deepEqual(merged.map((/** @type {any} */ c) => c.from), Array.from({ length: merged.length }, (_, k) => k * merged[0].to));
  assert.equal(new Set(log).size, log.length, 'no chunk was solved twice');
  assert.equal(client.slots.filter(Boolean).length, 1, 'only the first worker stays');
});

test('the pool keeps to half the device memory at the first engine\'s size', () => {
  const client = new EngineClient(() => /** @type {any} */ (new FakeWorker({ failFirstChunk: false, log: [] })), { poolSize: 8 });
  Object.defineProperty(globalThis, 'navigator', { value: { deviceMemory: 4, hardwareConcurrency: 16 }, configurable: true });
  try {
    client.slots[0] = /** @type {any} */ ({ worker: new FakeWorker({ failFirstChunk: false, log: [] }), pending: null, key: '', memory: 600 * 2 ** 20 });
    // 4 GB device: 2 GB for engines of 600 MB is three of them.
    assert.equal(client.poolFor(13000), 3);
    client.slots[0] = /** @type {any} */ ({ ...client.slots[0], memory: 50 * 2 ** 20 });
    assert.equal(client.poolFor(13000), 8);
  } finally {
    // @ts-ignore
    delete globalThis.navigator;
  }
});
