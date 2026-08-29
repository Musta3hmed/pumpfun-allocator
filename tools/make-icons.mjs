#!/usr/bin/env node
/**
 * Generate the extension's PNG icons.
 *
 * Chrome requires PNG, and pulling in an image library for four flat squares
 * would be silly, so this writes the PNGs by hand: a dark rounded tile with a
 * small ascending bar chart in the accent colour.
 *
 *   node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

const BG = [23, 26, 33];      // panel
const EDGE = [38, 43, 54];    // line
const BAR = [91, 157, 255];   // accent
const UP = [62, 207, 142];    // ok green

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  // One filter byte (0 = none) per scanline, then RGBA.
  const stride = size * 4 + 1;
  const buf = Buffer.alloc(stride * size);
  const radius = Math.max(2, Math.round(size * 0.18));

  const put = (x, y, [r, g, b], a = 255) => {
    const i = y * stride + 1 + x * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };

  // Rounded background.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const outside = dx < radius && dy < radius &&
        (radius - dx) ** 2 + (radius - dy) ** 2 > radius ** 2;
      if (outside) put(x, y, BG, 0);
      else if (dx === 0 || dy === 0) put(x, y, EDGE);
      else put(x, y, BG);
    }
  }

  // Ascending bars, last one green — an allocation getting filled.
  const bars = 4;
  const pad = Math.max(2, Math.round(size * 0.17));
  const gap = Math.max(1, Math.round(size * 0.055));
  const usable = size - pad * 2;
  const barW = Math.max(1, Math.floor((usable - gap * (bars - 1)) / bars));

  for (let b = 0; b < bars; b++) {
    const h = Math.round(usable * (0.3 + 0.7 * ((b + 1) / bars)));
    const x0 = pad + b * (barW + gap);
    const y0 = size - pad - h;
    const colour = b === bars - 1 ? UP : BAR;
    for (let x = x0; x < Math.min(x0 + barW, size - pad); x++) {
      for (let y = y0; y < size - pad; y++) put(x, y, colour);
    }
  }
  return buf;
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png(size, draw(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}
