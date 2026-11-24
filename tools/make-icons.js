'use strict';
// Рисует иконки расширения (скруглённый квадрат + глаз) без внешних зависимостей: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  const inRound = (x, y) => {
    const r = size * 0.22, cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, rr = 0, gg = 0, bb = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
      if (!inRound(fx, fy)) continue;
      const u = (fx - size / 2) / (size * 0.36), v = (fy - size / 2) / (size * 0.21);
      const pr = Math.hypot(fx - size / 2, fy - size / 2);
      let c = [26, 115, 232];
      if (u * u + v * v <= 1) c = pr <= size * 0.115 ? [32, 33, 36] : [255, 255, 255];
      a++; rr += c[0]; gg += c[1]; bb += c[2];
    }
    const i = (y * size + x) * 4, n = SS * SS;
    if (a) { px[i] = rr / a; px[i + 1] = gg / a; px[i + 2] = bb / a; px[i + 3] = Math.round(255 * a / n); }
  }
  return px;
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const px = render(size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(dir, `${s}.png`), png(s));
console.log('icons written to', dir);
