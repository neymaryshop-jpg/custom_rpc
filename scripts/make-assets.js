'use strict';

/**
 * Generates all application artwork without external dependencies:
 *   assets/icon.png              512x512 app icon
 *   assets/icon.ico              multi-size Windows icon (PNG entries)
 *   assets/tray/frame-N.png      8 animated tray frames
 *   assets/sample/aruku-live.gif animated sample GIF for Discord RPC
 *
 * Everything is drawn procedurally and encoded with Node's zlib.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

/* ------------------------------------------------------------------ math */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function smoothAlpha(distance, softness) {
  return clamp(0.5 - distance / (2 * softness), 0, 1);
}

function sdRoundRect(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const qx = Math.abs(px - cx) - (halfWidth - radius);
  const qy = Math.abs(py - cy) - (halfHeight - radius);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/* ----------------------------------------------------------------- scene */

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
};

function drawLabel(u, v, size, text, color, alpha) {
  const cell = 0.0072;
  const gap = cell;
  const glyphs = String(text).split('');
  const textWidth = glyphs.length * 5 * cell + Math.max(0, glyphs.length - 1) * gap;
  const left = 0.5 - textWidth / 2;
  const top = 0.095;
  if (v < top || v > top + 7 * cell) return 0;

  for (let g = 0; g < glyphs.length; g += 1) {
    const glyph = FONT[glyphs[g]] || FONT.K;
    const gx = left + g * (5 * cell + gap);
    if (u < gx || u > gx + 5 * cell) continue;
    const column = Math.floor((u - gx) / cell);
    const row = Math.floor((v - top) / cell);
    if (column < 0 || column >= 5 || row < 0 || row >= 7) continue;
    if (glyph[row][column] === '1') return alpha;
  }
  return 0;
}

function shade(u, v, phase, options, out) {
  const size = options.size;
  const animated = Boolean(options.animated);
  const soft = Math.max(0.0022, 1.15 / size);

  const angle = animated ? phase * Math.PI * 2 : -0.72;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  let t = clamp(0.5 + ((u - 0.5) * cos + (v - 0.5) * sin) * 0.92, 0, 1);
  t = t * t * (3 - 2 * t);
  let color = mix([124, 92, 255], [46, 211, 166], t);

  const glowAngle = animated ? phase * Math.PI * 2 + 1.1 : 2.2;
  const glowX = 0.5 + 0.32 * Math.cos(glowAngle);
  const glowY = 0.5 + 0.32 * Math.sin(glowAngle);
  const glowDistance = (u - glowX) ** 2 + (v - glowY) ** 2;
  const glow = Math.exp(-glowDistance / 0.07) * (animated ? 0.2 + 0.05 * Math.sin(phase * Math.PI * 4) : 0.22);
  color = [color[0] + 255 * glow, color[1] + 255 * glow, color[2] + 255 * glow];

  let alpha = 1;
  if (options.rounded) {
    const background = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225);
    alpha = smoothAlpha(background, soft);
    const border = Math.abs(sdRoundRect(u, v, 0.5, 0.5, 0.492, 0.492, 0.218)) - 0.0012;
    const borderLight = Math.exp(-(border * border) / (0.004 * 0.004)) * 0.16;
    color = [color[0] + 255 * borderLight, color[1] + 255 * borderLight, color[2] + 255 * borderLight];
  }

  const plate = sdRoundRect(u, v, 0.5, 0.5, 0.315, 0.315, 0.108);
  const plateMask = smoothAlpha(plate, soft);
  if (plateMask > 0) {
    const plateColor = mix([31, 34, 47], [10, 12, 17], clamp((v - 0.2) / 0.6, 0, 1));
    color = mix(color, plateColor, plateMask);
  }

  const pulse = animated ? Math.sin(phase * Math.PI * 4) : 0.35;
  const ringRadius = 0.236 + pulse * 0.003;
  const ringThickness = Math.max(0.013, 1.55 / size);
  const ringDistance = Math.abs(Math.hypot(u - 0.5, v - 0.5) - ringRadius) - ringThickness;
  const ringAngle = Math.atan2(v - 0.5, u - 0.5) + (animated ? phase * Math.PI * 2 : 0);
  const ringColor = mix([186, 160, 255], [61, 220, 151], 0.5 + 0.5 * Math.sin(ringAngle));
  const ringGlow = Math.exp(-(ringDistance * ringDistance) / ((0.02 + ringThickness) ** 2)) * 0.55;
  color = [color[0] + ringColor[0] * ringGlow, color[1] + ringColor[1] * ringGlow, color[2] + ringColor[2] * ringGlow];
  color = mix(color, ringColor, smoothAlpha(ringDistance, soft));

  const orbitAngle = (animated ? phase * Math.PI * 4 : 1.9) + 0.9;
  const orbitX = 0.5 + ringRadius * Math.cos(orbitAngle);
  const orbitY = 0.5 + ringRadius * Math.sin(orbitAngle);
  const dotRadius = Math.max(0.023, 2.1 / size);
  const dotDistance = Math.hypot(u - orbitX, v - orbitY) - dotRadius;
  const dotGlow = Math.exp(-(dotDistance * dotDistance) / ((dotRadius * 2.2) ** 2)) * 0.55;
  color = [color[0] + 255 * dotGlow, color[1] + 255 * dotGlow, color[2] + 255 * dotGlow];
  color = mix(color, [255, 255, 255], smoothAlpha(dotDistance, soft));

  const shadowShift = 0.012;
  const shadow =
    pointInTriangle(u, v - shadowShift, 0.452, 0.393, 0.452, 0.607, 0.636, 0.5) &&
    !pointInTriangle(u, v, 0.452, 0.393, 0.452, 0.607, 0.636, 0.5);
  if (shadow) color = mix(color, [0, 0, 0], 0.35);

  const play = pointInTriangle(u, v, 0.452, 0.393, 0.452, 0.607, 0.636, 0.5);
  if (play) {
    const playColor = mix([244, 246, 255], [213, 224, 255], clamp((v - 0.39) / 0.22, 0, 1));
    color = mix(color, playColor, 0.98);
  }

  if (options.label) {
    const labelAlpha = drawLabel(u, v, size, options.label, [255, 255, 255], 0.62);
    if (labelAlpha > 0) color = mix(color, [255, 255, 255], labelAlpha);
  }

  out[0] = clamp(color[0], 0, 255);
  out[1] = clamp(color[1], 0, 255);
  out[2] = clamp(color[2], 0, 255);
  out[3] = clamp(alpha, 0, 1) * 255;
}

function renderImage(size, phase, options = {}) {
  const supersample = options.supersample || 2;
  const high = size * supersample;
  const total = size * size;
  const red = new Float32Array(total);
  const green = new Float32Array(total);
  const blue = new Float32Array(total);
  const alpha = new Float32Array(total);
  const sample = [0, 0, 0, 0];
  const sceneOptions = { ...options, size };

  for (let y = 0; y < high; y += 1) {
    const v = (y + 0.5) / high;
    const row = Math.floor(y / supersample);
    for (let x = 0; x < high; x += 1) {
      const u = (x + 0.5) / high;
      shade(u, v, phase, sceneOptions, sample);
      const index = row * size + Math.floor(x / supersample);
      const weight = sample[3] / 255;
      red[index] += sample[0] * weight;
      green[index] += sample[1] * weight;
      blue[index] += sample[2] * weight;
      alpha[index] += weight;
    }
  }

  const out = Buffer.alloc(total * 4);
  const samples = supersample * supersample;
  for (let index = 0; index < total; index += 1) {
    const weight = alpha[index];
    const offset = index * 4;
    if (weight > 0) {
      out[offset] = Math.round(clamp(red[index] / weight, 0, 255));
      out[offset + 1] = Math.round(clamp(green[index] / weight, 0, 255));
      out[offset + 2] = Math.round(clamp(blue[index] / weight, 0, 255));
      out[offset + 3] = Math.round(clamp((weight / samples) * 255, 0, 255));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let value = ~0;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (~value) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  const blobs = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    blobs.push(image.png);
    offset += image.png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ------------------------------------------------------------------ gif */

function quantize(rgba, width, height) {
  const palette = Buffer.alloc(256 * 3);
  for (let index = 0; index < 216; index += 1) {
    const r = Math.floor(index / 36);
    const g = Math.floor((index % 36) / 6);
    const b = index % 6;
    palette[index * 3] = r * 51;
    palette[index * 3 + 1] = g * 51;
    palette[index * 3 + 2] = b * 51;
  }

  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const indices = Buffer.alloc(width * height);
  const step = 51;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const dither = (bayer[y % 4][x % 4] / 16 - 0.5) * step;
      const r = clamp(Math.round((rgba[offset] + dither) / step), 0, 5);
      const g = clamp(Math.round((rgba[offset + 1] + dither) / step), 0, 5);
      const b = clamp(Math.round((rgba[offset + 2] + dither) / step), 0, 5);
      indices[y * width + x] = r * 36 + g * 6 + b;
    }
  }
  return { palette, indices };
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.bits = 0;
  }

  write(code, size) {
    this.current |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.bytes.push(this.current & 0xff);
      this.current >>>= 8;
      this.bits -= 8;
    }
  }

  finish() {
    if (this.bits > 0) {
      this.bytes.push(this.current & 0xff);
      this.current = 0;
      this.bits = 0;
    }
    return Buffer.from(this.bytes);
  }
}

function lzwEncode(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map();
  const writer = new BitWriter();

  writer.write(clearCode, codeSize);
  if (indices.length === 0) {
    writer.write(endCode, codeSize);
    return writer.finish();
  }

  let prefix = indices[0];
  for (let index = 1; index < indices.length; index += 1) {
    const suffix = indices[index];
    const key = (prefix << 8) | suffix;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }

    writer.write(prefix, codeSize);
    if (nextCode < 4096) {
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
      dictionary.set(key, nextCode);
      nextCode += 1;
    } else {
      writer.write(clearCode, codeSize);
      dictionary = new Map();
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
    }
    prefix = suffix;
  }

  writer.write(prefix, codeSize);
  writer.write(endCode, codeSize);
  return writer.finish();
}

function gifBlocks(data) {
  const parts = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const length = Math.min(255, data.length - offset);
    parts.push(Buffer.from([length]), data.subarray(offset, offset + length));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeGif(width, height, frames, delayCentiseconds = 9) {
  const palette = frames[0].palette;
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0xf7;
  header[11] = 0;
  header[12] = 0;

  const netscape = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ]);

  const parts = [header, palette, netscape];
  for (const frame of frames) {
    const delay = Buffer.alloc(2);
    delay.writeUInt16LE(delayCentiseconds, 0);
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x04, delay[0], delay[1], 0x00, 0x00]));

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0;
    parts.push(descriptor);

    parts.push(Buffer.from([8]), gifBlocks(lzwEncode(frame.indices, 8)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/* ---------------------------------------------------------------- output */

function lzwDecode(data, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let dictionary;
  let codeSize;
  let nextCode;
  let bitPosition = 0;
  const output = [];

  function reset() {
    dictionary = [];
    for (let index = 0; index < clearCode; index += 1) dictionary[index] = [index];
    dictionary[clearCode] = [];
    dictionary[endCode] = [];
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  }

  function read(size) {
    let value = 0;
    for (let index = 0; index < size; index += 1) {
      const byte = data[bitPosition >> 3];
      if (byte === undefined) return -1;
      value |= ((byte >> (bitPosition & 7)) & 1) << index;
      bitPosition += 1;
    }
    return value;
  }

  reset();
  let previous = null;
  for (;;) {
    const code = read(codeSize);
    if (code < 0 || code === endCode) break;
    if (code === clearCode) {
      reset();
      previous = null;
      continue;
    }

    let entry;
    if (code < nextCode && dictionary[code]) entry = dictionary[code].slice();
    else if (code === nextCode && previous) entry = [...previous, previous[0]];
    else throw new Error(`Некорректный LZW-код ${code}`);

    output.push(...entry);
    if (previous && nextCode < 4096) {
      dictionary[nextCode] = [...previous, entry[0]];
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }
  return Buffer.from(output);
}

function selfTestLzw() {
  let seed = 123456789;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const indices = Buffer.alloc(5000);
  for (let index = 0; index < indices.length; index += 1) indices[index] = random() % 256;
  const encoded = lzwEncode(indices, 8);
  const decoded = lzwDecode(encoded, 8);
  if (!decoded.equals(indices)) throw new Error('LZW self-test failed');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writePng(filePath, size, phase, options) {
  const rgba = renderImage(size, phase, options);
  fs.writeFileSync(filePath, encodePng(size, size, rgba));
  return fs.statSync(filePath).size;
}

function main() {
  selfTestLzw();

  ensureDirectory(ASSETS);
  ensureDirectory(path.join(ASSETS, 'tray'));
  ensureDirectory(path.join(ASSETS, 'sample'));

  console.log('Генерация иконок…');
  const iconSize = 512;
  const iconBytes = writePng(path.join(ASSETS, 'icon.png'), iconSize, 0.18, {
    rounded: true,
    supersample: 2,
  });

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoImages = icoSizes.map((size) => ({
    size,
    png: encodePng(
      size,
      size,
      renderImage(size, 0.18, {
        rounded: true,
        supersample: size <= 64 ? 4 : 2,
      }),
    ),
  }));
  const icoBytes = encodeIco(icoImages);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), icoBytes);
  console.log(`  icon.png  ${(iconBytes / 1024).toFixed(1)} КБ`);
  console.log(`  icon.ico  ${(icoBytes.length / 1024).toFixed(1)} КБ (${icoSizes.join(', ')})`);

  console.log('Генерация кадров трея…');
  const trayFrames = 8;
  for (let frame = 0; frame < trayFrames; frame += 1) {
    const phase = frame / trayFrames;
    const bytes = writePng(
      path.join(ASSETS, 'tray', `frame-${String(frame).padStart(2, '0')}.png`),
      32,
      phase,
      { rounded: true, animated: true, supersample: 4 },
    );
    if (frame === 0) console.log(`  frame-00.png  ${(bytes / 1024).toFixed(1)} КБ`);
  }

  console.log('Генерация примера GIF…');
  const gifSize = 320;
  const gifFrames = 24;
  const frames = [];
  for (let frame = 0; frame < gifFrames; frame += 1) {
    const phase = frame / gifFrames;
    const rgba = renderImage(gifSize, phase, {
      rounded: false,
      animated: true,
      label: 'ARUKU',
      supersample: 2,
    });
    frames.push(quantize(rgba, gifSize, gifSize));
  }
  const gif = encodeGif(gifSize, gifSize, frames, 9);
  fs.writeFileSync(path.join(ASSETS, 'sample', 'aruku-live.gif'), gif);
  console.log(
    `  aruku-live.gif  ${(gif.length / 1024).toFixed(1)} КБ · ${gifSize}×${gifSize} · ${gifFrames} кадров`,
  );
  console.log('Готово.');
}

if (require.main === module) main();

module.exports = {
  encodeGif,
  encodePng,
  renderImage,
};
