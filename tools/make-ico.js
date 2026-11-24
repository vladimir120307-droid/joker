'use strict';
// Собирает desktop/build/icon.ico (значок JOKER.exe) из того же рисунка, что и значки расширения:
//   node tools/make-ico.js
const fs = require('fs');
const path = require('path');
const { render, png } = require('./make-icons');

// Значки 16–64 px храним как BMP (так надёжнее для старых программ), 256 px как PNG
function bmp(size) {
  const rgba = render(size);
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0); head.writeInt32LE(size, 4); head.writeInt32LE(size * 2, 8);   // высота удвоена: цвет + маска
  head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14);
  const pix = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;   // строки идут снизу вверх, цвет в порядке BGRA
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = (y * size + x) * 4;
      pix[d] = rgba[s + 2]; pix[d + 1] = rgba[s + 1]; pix[d + 2] = rgba[s]; pix[d + 3] = rgba[s + 3];
    }
  }
  const mask = Buffer.alloc(((size + 31) >> 5) * 4 * size);   // прозрачность задаёт альфа-канал, маска пустая
  return Buffer.concat([head, pix, mask]);
}

const sizes = [16, 32, 48, 64, 256];
const images = sizes.map((s) => (s >= 256 ? png(s) : bmp(s)));
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((s, i) => {
  const o = 6 + 16 * i;
  dir[o] = s >= 256 ? 0 : s; dir[o + 1] = s >= 256 ? 0 : s;   // 0 означает 256
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(images[i].length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += images[i].length;
});

const out = path.join(__dirname, '..', 'desktop', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([dir, ...images]));
console.log('значок записан:', out, `(${sizes.join(', ')} px)`);
