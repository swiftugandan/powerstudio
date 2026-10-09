/** WebGPU renderer for the diagram. Shapes (segments, circles, rounded rectangles) are instanced quads whose edges
 * come from signed distance functions in WGSL; filled polygons are plain triangles; text is drawn from a signed
 * distance field glyph atlas. Everything renders into a 4× multisampled target. */

import { SHAPE_STRIDE } from './displaylist.js';
import { GlyphAtlas } from './glyphs.js';

/** @typedef {import('./displaylist.js').DisplayList} DisplayList @typedef {import('./camera.js').Camera} Camera
 * @typedef {import('./scene.js').Palette} Palette */

const SHADER = /* wgsl */ `
struct U { viewport: vec2f, center: vec2f, scale: f32, dpr: f32, gridStep: f32, pad: f32, bg: vec4f, grid: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

fn toClip(p: vec2f) -> vec4f {
  let px = (p - u.center) * u.scale;
  return vec4f(px.x / (u.viewport.x * 0.5), -px.y / (u.viewport.y * 0.5), 0.0, 1.0);
}

// Background: dot grid in world coordinates, coarser when zoomed out.
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}
@fragment fn fsGrid(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let world = (fc.xy - u.viewport * 0.5) / u.scale + u.center;
  var step = u.gridStep;
  if (step * u.scale < 12.0 * u.dpr) { step = step * 5.0; }
  if (step * u.scale < 12.0 * u.dpr) { step = step * 5.0; }
  let g = world / step;
  let d = abs(g - round(g)) * step * u.scale;
  let a = clamp(1.1 * u.dpr - length(d) + 0.5, 0.0, 1.0) * u.grid.a;
  return vec4f(mix(u.bg.rgb, u.grid.rgb, a), 1.0);
}

struct ShapeIn {
  @builtin(vertex_index) vi: u32,
  @location(0) g0: vec4f, @location(1) g1: vec4f, @location(2) fill: vec4f, @location(3) stroke: vec4f, @location(4) ex: vec4f,
};
struct ShapeOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec2f,
  @location(1) @interpolate(flat) g0: vec4f,
  @location(2) @interpolate(flat) g1: vec4f,
  @location(3) @interpolate(flat) fill: vec4f,
  @location(4) @interpolate(flat) stroke: vec4f,
  @location(5) @interpolate(flat) ex: vec4f,
};

@vertex fn vsShape(i: ShapeIn) -> ShapeOut {
  let c = CORNERS[i.vi];
  let aa = 1.5 / u.scale;
  var world: vec2f;
  if (i.g0.x < 0.5) {
    let a = i.g0.yz;
    let b = vec2f(i.g0.w, i.g1.x);
    let hw = max(i.g1.y * u.scale, 1.0) * 0.5 / u.scale + aa;
    let d = b - a;
    let l = length(d);
    let dir = select(vec2f(1.0, 0.0), d / max(l, 1e-6), l > 1e-6);
    let n = vec2f(-dir.y, dir.x);
    world = select(a - dir * hw, b + dir * hw, c.x > 0.0) + n * hw * c.y;
  } else if (i.g0.x < 1.5) {
    let r = i.g0.w + max(i.ex.x * u.scale, 1.0) * 0.5 / u.scale + aa;
    world = i.g0.yz + c * r;
  } else {
    let half = vec2f(i.g0.w, i.g1.x) * 0.5;
    world = i.g0.yz + half + c * (half + vec2f(max(i.ex.x * u.scale, 1.0) * 0.5 / u.scale + aa));
  }
  var o: ShapeOut;
  o.pos = toClip(world);
  o.world = world;
  o.g0 = i.g0; o.g1 = i.g1; o.fill = i.fill; o.stroke = i.stroke; o.ex = i.ex;
  return o;
}

@fragment fn fsShape(i: ShapeOut) -> @location(0) vec4f {
  let p = i.world;
  if (i.g0.x < 0.5) {
    let a = i.g0.yz;
    let ba = vec2f(i.g0.w, i.g1.x) - a;
    let l2 = max(dot(ba, ba), 1e-12);
    let t = clamp(dot(p - a, ba) / l2, 0.0, 1.0);
    let dist = length(p - (a + ba * t)) * u.scale;
    let hw = max(i.g1.y * u.scale, 1.0) * 0.5;
    var alpha = clamp(hw - dist + 0.5, 0.0, 1.0) * i.fill.a;
    if (i.ex.y > 0.0 && fract(t * sqrt(l2) / (2.0 * i.ex.y)) > 0.5) { alpha = 0.0; }
    return vec4f(i.fill.rgb * alpha, alpha);
  }
  var dist: f32;
  if (i.g0.x < 1.5) {
    dist = (length(p - i.g0.yz) - i.g0.w) * u.scale;
  } else {
    let half = vec2f(i.g0.w, i.g1.x) * 0.5;
    let r = min(i.g1.y, min(half.x, half.y));
    let q = abs(p - (i.g0.yz + half)) - half + vec2f(r);
    dist = (length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r) * u.scale;
  }
  let sw = select(0.0, max(i.ex.x * u.scale, 1.0), i.ex.x > 0.0);
  let fillA = clamp(0.5 - dist, 0.0, 1.0) * i.fill.a;
  let strokeA = select(0.0, clamp(sw * 0.5 - abs(dist) + 0.5, 0.0, 1.0) * i.stroke.a, sw > 0.0);
  let rgb = i.stroke.rgb * strokeA + i.fill.rgb * fillA * (1.0 - strokeA);
  return vec4f(rgb, strokeA + fillA * (1.0 - strokeA));
}

struct TriOut { @builtin(position) pos: vec4f, @location(0) color: vec4f };
@vertex fn vsTri(@location(0) p: vec2f, @location(1) color: vec4f) -> TriOut {
  var o: TriOut;
  o.pos = toClip(p);
  o.color = color;
  return o;
}
@fragment fn fsTri(i: TriOut) -> @location(0) vec4f { return vec4f(i.color.rgb * i.color.a, i.color.a); }

struct TextIn { @builtin(vertex_index) vi: u32, @location(0) q: vec4f, @location(1) uv: vec4f, @location(2) color: vec4f, @location(3) ex: vec4f };
struct TextOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) color: vec4f };
@vertex fn vsText(i: TextIn) -> TextOut {
  let c = CORNERS[i.vi] * 0.5 + vec2f(0.5);
  var o: TextOut;
  o.pos = toClip(mix(i.q.xy, i.q.zw, c));
  // Text below its minimum on-screen size is moved outside the clip volume.
  if (i.ex.x * u.scale / u.dpr < i.ex.y) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); }
  o.uv = mix(i.uv.xy, i.uv.zw, c);
  o.color = i.color;
  return o;
}
@fragment fn fsText(i: TextOut) -> @location(0) vec4f {
  let s = textureSample(atlas, samp, i.uv).r;
  let w = clamp(fwidth(s) * 0.7, 0.002, 0.5);
  let a = smoothstep(0.5 - w, 0.5 + w, s) * i.color.a;
  return vec4f(i.color.rgb * a, a);
}
`;

const SAMPLES = 4;

export class WebGPURenderer {
  /** @param {HTMLCanvasElement} canvas @returns {Promise<WebGPURenderer>} Rejects with a reason when WebGPU is unavailable. */
  static async create(canvas) {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error('This browser does not expose WebGPU.');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice();
    const context = /** @type {GPUCanvasContext | null} */ (canvas.getContext('webgpu'));
    if (!context) throw new Error('The canvas could not create a WebGPU context.');
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const info = adapter.info;
    const detail = info ? [info.vendor, info.architecture, info.isFallbackAdapter ? 'software' : ''].filter(Boolean).join(' · ') : '';
    return new WebGPURenderer(canvas, adapter, device, context, format, detail);
  }

  /** @param {HTMLCanvasElement} canvas @param {GPUAdapter} adapter @param {GPUDevice} device @param {GPUCanvasContext} context @param {GPUTextureFormat} format @param {string} detail */
  constructor(canvas, adapter, device, context, format, detail) {
    /** Held for the renderer's lifetime so the adapter (and the instance behind it) is not collected. */
    this.adapter = adapter;
    this.backend = /** @type {const} */ ('webgpu');
    this.label = 'WebGPU';
    this.detail = detail;
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    /** @type {((reason: string) => void) | null} */
    this.onLost = null;
    device.lost.then(info => { if (info.reason !== 'destroyed') this.onLost?.(info.message || 'The GPU device was lost.'); });
    this.atlas = new GlyphAtlas();
    this.atlasVersion = -1;
    const module = device.createShaderModule({ code: SHADER });
    this.uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.atlasTexture = device.createTexture({ size: [this.atlas.size, this.atlas.size], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] });
    this.bindGroup = device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: this.atlasTexture.createView() },
      { binding: 2, resource: sampler },
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    /** @type {GPUBlendState} */
    const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    /** @param {string} vs @param {string} fs @param {GPUVertexBufferLayout[]} buffers @param {boolean} blended */
    const pipeline = (vs, fs, buffers, blended) => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: vs, buffers },
      fragment: { module, entryPoint: fs, targets: [{ format, ...(blended ? { blend } : {}) }] },
      primitive: { topology: 'triangle-list' },
      multisample: { count: SAMPLES },
    });
    /** @param {number} count @returns {GPUVertexAttribute[]} */
    const vec4s = count => Array.from({ length: count }, (_, k) => ({ shaderLocation: k, offset: k * 16, format: /** @type {GPUVertexFormat} */ ('float32x4') }));
    this.gridPipeline = pipeline('vsFull', 'fsGrid', [], false);
    this.shapePipeline = pipeline('vsShape', 'fsShape', [{ arrayStride: SHAPE_STRIDE * 4, stepMode: 'instance', attributes: vec4s(5) }], true);
    this.triPipeline = pipeline('vsTri', 'fsTri', [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x4' }] }], true);
    this.textPipeline = pipeline('vsText', 'fsText', [{ arrayStride: 64, stepMode: 'instance', attributes: vec4s(4) }], true);
    /** @type {Record<'shapes' | 'tris' | 'texts', GPUBuffer | null>} */
    this.buffers = { shapes: null, tris: null, texts: null };
    /** @type {Array<{ shapes: [number, number], tris: [number, number], texts: [number, number] }>} */
    this.ranges = [];
    /** @type {GPUTexture | null} */
    this.msaa = null;
  }

  /** @param {number} width CSS px @param {number} height CSS px @param {number} dpr */
  resize(width, height, dpr) {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.msaa) return;
    this.canvas.width = w; this.canvas.height = h;
    this.msaa?.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  /** Uploads a display list. @param {DisplayList} list */
  setScene(list) {
    /** @type {number[]} */
    const shapes = [];
    /** @type {number[]} */
    const tris = [];
    /** @type {number[]} */
    const texts = [];
    this.ranges = list.layers.map(layer => {
      const s0 = shapes.length / SHAPE_STRIDE, t0 = tris.length / 6, x0 = texts.length / 16;
      for (const v of layer.shapes) shapes.push(v);
      for (const v of layer.tris) tris.push(v);
      for (const t of layer.texts) this.layoutText(t, texts);
      return { shapes: [s0, shapes.length / SHAPE_STRIDE - s0], tris: [t0, tris.length / 6 - t0], texts: [x0, texts.length / 16 - x0] };
    });
    this.buffers.shapes = this.upload(this.buffers.shapes, shapes);
    this.buffers.tris = this.upload(this.buffers.tris, tris);
    this.buffers.texts = this.upload(this.buffers.texts, texts);
    const { y0, y1 } = this.atlas.dirty;
    if (y1 > y0) {
      const size = this.atlas.size;
      this.device.queue.writeTexture({ texture: this.atlasTexture, origin: [0, y0] }, this.atlas.data.subarray(y0 * size, y1 * size), { bytesPerRow: size }, [size, y1 - y0]);
      this.atlas.dirty = { y0: size, y1: 0 };
    }
  }

  /** Lays a string out as one glyph instance per character: quad, atlas coordinates, colour, size and minimum px.
   * @param {import('./displaylist.js').TextItem} t @param {number[]} out */
  layoutText(t, out) {
    const m = GlyphAtlas.metrics, weight = t.weight;
    const width = this.atlas.measure(t.font, weight, t.text) * t.size;
    let pen = t.x - t.align * width;
    const top = t.y - (m.line / 2 + m.pad) * t.size;
    for (const ch of t.text) {
      const g = this.atlas.glyph(t.font, weight, ch);
      if (ch !== ' ') {
        const x0 = pen - m.pad * t.size;
        out.push(x0, top, x0 + g.w * t.size, top + g.h * t.size, g.u0, g.v0, g.u1, g.v1, ...t.color, t.size, t.minPx, 0, 0);
      }
      pen += g.advance * t.size;
    }
  }

  /** @param {GPUBuffer | null} buffer @param {number[]} data */
  upload(buffer, data) {
    const bytes = Math.max(256, data.length * 4);
    if (!buffer || buffer.size < bytes) {
      buffer?.destroy();
      buffer = this.device.createBuffer({ size: Math.max(bytes, (buffer?.size ?? 0) * 2), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (data.length) this.device.queue.writeBuffer(buffer, 0, new Float32Array(data));
    return buffer;
  }

  /** @param {Camera} camera @param {Palette} palette @param {number} dpr */
  draw(camera, palette, dpr) {
    this.encode(camera, palette, dpr, this.context.getCurrentTexture().createView());
  }

  /**
   * Renders the current view into a texture and reads it back: the frame exactly as the GPU produced it, independent
   * of how the browser composites the canvas. @param {Camera} camera @param {Palette} palette @param {number} dpr
   * @returns {Promise<{ width: number, height: number, rgba: Uint8ClampedArray }>}
   */
  async snapshot(camera, palette, dpr) {
    const w = this.canvas.width, h = this.canvas.height, device = this.device;
    const target = device.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.encode(camera, palette, dpr, target.createView());
    const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [w, h]);
    device.queue.submit([encoder.finish()]);
    // A device that stops responding must not hang the caller.
    let timer = 0;
    try {
      await Promise.race([buffer.mapAsync(GPUMapMode.READ), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The GPU did not return the frame within 5 s.')), 5000); })]);
    } finally { clearTimeout(timer); }
    const src = new Uint8Array(buffer.getMappedRange()), rgba = new Uint8ClampedArray(w * h * 4);
    const bgra = this.format.startsWith('bgra');
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * bytesPerRow + x * 4, o = (y * w + x) * 4;
      rgba[o] = src[i + (bgra ? 2 : 0)]; rgba[o + 1] = src[i + 1]; rgba[o + 2] = src[i + (bgra ? 0 : 2)]; rgba[o + 3] = 255;
    }
    buffer.unmap(); buffer.destroy(); target.destroy();
    return { width: w, height: h, rgba };
  }

  /** @param {Camera} camera @param {Palette} palette @param {number} dpr @param {GPUTextureView} resolveTarget */
  encode(camera, palette, dpr, resolveTarget) {
    const w = this.canvas.width, h = this.canvas.height;
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([w, h, camera.cx, camera.cy, camera.zoom * dpr, dpr, 20, 0, ...palette.bg, ...palette.grid]));
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: /** @type {GPUTexture} */ (this.msaa).createView(), resolveTarget,
      clearValue: { r: palette.bg[0], g: palette.bg[1], b: palette.bg[2], a: 1 }, loadOp: 'clear', storeOp: 'discard',
    }] });
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.gridPipeline);
    pass.draw(3);
    for (const r of this.ranges) {
      if (r.shapes[1]) { pass.setPipeline(this.shapePipeline); pass.setVertexBuffer(0, this.buffers.shapes); pass.draw(6, r.shapes[1], 0, r.shapes[0]); }
      if (r.tris[1]) { pass.setPipeline(this.triPipeline); pass.setVertexBuffer(0, this.buffers.tris); pass.draw(r.tris[1], 1, r.tris[0], 0); }
      if (r.texts[1]) { pass.setPipeline(this.textPipeline); pass.setVertexBuffer(0, this.buffers.texts); pass.draw(6, r.texts[1], 0, r.texts[0]); }
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy() {
    this.onLost = null;
    this.msaa?.destroy();
    for (const b of Object.values(this.buffers)) b?.destroy();
    this.atlasTexture.destroy();
    this.device.destroy();
  }
}
