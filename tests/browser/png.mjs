/** Minimal PNG decoder for Playwright screenshots (8-bit RGB or RGBA, not interlaced), so tests can check pixels. */
import { inflateSync } from 'node:zlib';

/** @param {Buffer} buf @returns {{ width: number, height: number, rgba: Uint8Array }} */
export function decodePNG(buf) {
  let p = 8, width = 0, height = 0, channels = 4;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Only 8-bit, non-interlaced PNG is supported.');
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!channels) throw new Error(`Unsupported PNG colour type ${data[9]}.`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) out[(y * width + x) * 4 + k] = cur[x * channels + k];
      out[(y * width + x) * 4 + 3] = channels === 4 ? cur[x * channels + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, rgba: out };
}

/** Share of pixels within `tol` of an sRGB colour. @param {{ rgba: Uint8Array }} img @param {[number, number, number]} rgb @param {number} [tol] */
export function share(img, rgb, tol = 40) {
  let n = 0;
  const total = img.rgba.length / 4;
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (Math.abs(img.rgba[i] - rgb[0]) + Math.abs(img.rgba[i + 1] - rgb[1]) + Math.abs(img.rgba[i + 2] - rgb[2]) <= tol) n++;
  }
  return n / total;
}
