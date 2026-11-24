'use strict';
// Готовит исходник значка из исходной гифки: убирает надпись («HELLO … AGAIN» сверху) и светлую кайму по краю кадра
// и сохраняет чистую анимацию в tools/icon-source.gif. Запускается один раз при смене рисунка:
//   node tools/clean-icon-gif.js <путь к исходному .gif>
// Надпись лежит в верхних углах кадра и звезду не пересекает, поэтому закрашиваются два прямоугольника цветом фона.
const fs = require('fs');
const path = require('path');
const { decodeGif, encodeGif } = require('./gif');

const input = process.argv[2];
if (!input) { console.error('Укажите путь к исходному GIF'); process.exit(1); }

const TEXT_RECTS = [{ x0: 0, y0: 0, x1: 205, y1: 95 }, { x0: 280, y0: 0, x1: 479, y1: 95 }];   // верхние левый и правый углы
const EDGE = 8;                                                                                    // кайма по краю кадра

const g = decodeGif(fs.readFileSync(input));
const { width: W, height: H, frames } = g;
const lum = (rgba, i) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

// цвет фона — медиана яркости первого кадра
const sorted = Float32Array.from({ length: W * H }, (_, i) => lum(frames[0].rgba, i)).sort();
const bg = Math.round(sorted[Math.floor(W * H / 2)]);

const inText = (x, y) => TEXT_RECTS.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
let painted = 0;
const cleaned = frames.map((f) => {
  const out = Buffer.from(f.rgba);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const edge = x < EDGE || y < EDGE || x >= W - EDGE || y >= H - EDGE;
    if (!edge && !inText(x, y)) continue;
    const o = (y * W + x) * 4;
    if (lum(out, y * W + x) > bg + 6) painted++;
    out[o] = out[o + 1] = out[o + 2] = bg; out[o + 3] = 255;
  }
  return out;
});

const gif = encodeGif(cleaned, W, H, 100);
const dest = path.join(__dirname, 'icon-source.gif');
fs.writeFileSync(dest, gif);

// проверка: файл читается обратно без потерь, а в углах не осталось ничего яркого
const back = decodeGif(gif);
let maxDiff = 0, left = 0;
back.frames.forEach((f, k) => {
  for (let i = 0; i < W * H; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(lum(f.rgba, i) - lum(cleaned[k], i)));
    const x = i % W, y = (i / W) | 0;
    if ((inText(x, y) || x < EDGE || y < EDGE || x >= W - EDGE || y >= H - EDGE) && lum(f.rgba, i) > bg + 6) left++;
  }
});
console.log(`кадров: ${frames.length}, размер ${W}x${H}, цвет фона ${bg}`);
console.log(`закрашено ярких пикселей (надпись и кайма): ${painted}`);
console.log(`записано ${dest} (${(gif.length / 1024).toFixed(0)} КБ); чтение обратно: максимальное расхождение яркости ${maxDiff.toFixed(2)}, ярких пикселей в закрашенных областях: ${left}`);
if (back.frames.length !== frames.length || maxDiff > 1.5 || left) { console.error('ПРОВЕРКА НЕ ПРОЙДЕНА'); process.exit(1); }
