'use strict';
// Собирает значки JOKER из рисунка tools/icon-source.png (серый эскиз глаза на чёрном)
// без внешних зависимостей.
//   node tools/make-icons.js   — значки расширения (extension/icons) и значок приложения Android
//                                (android/app/src/main/res: mipmap-*/ic_launcher_foreground.png и drawable/ic_launcher_background.xml)
// Этот же рисунок использует tools/make-ico.js (значок JOKER.exe).
// Чёрный фон рисунка превращается в «прозрачность по яркости»: серые линии ложатся и на плитку значка,
// и на прозрачный слой Android без швов. Для мелких размеров линии утолщаются, чтобы не пропадали.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SOURCE = path.join(__dirname, 'icon-source.png');
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

// ---------- PNG ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('это не PNG');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, plte = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (depth !== 8 || interlace !== 0) throw new Error('поддерживается только 8-битный PNG без чересстрочной развёртки');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch) throw new Error('неизвестный тип PNG: ' + ctype);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(w * h * 4);
  let cur = Buffer.alloc(stride), prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    raw.copy(cur, 0, p, p + stride); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (cur[i] + add) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ctype === 6) { out[o] = cur[x * 4]; out[o + 1] = cur[x * 4 + 1]; out[o + 2] = cur[x * 4 + 2]; out[o + 3] = cur[x * 4 + 3]; }
      else if (ctype === 2) { out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255; }
      else if (ctype === 0) { out[o] = out[o + 1] = out[o + 2] = cur[x]; out[o + 3] = 255; }
      else if (ctype === 4) { out[o] = out[o + 1] = out[o + 2] = cur[x * 2]; out[o + 3] = cur[x * 2 + 1]; }
      else { const k = cur[x]; out[o] = plte[k * 3]; out[o + 1] = plte[k * 3 + 1]; out[o + 2] = plte[k * 3 + 2]; out[o + 3] = trns && k < trns.length ? trns[k] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, rgba: out };
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- рисунок ----------
// Яркость -> прозрачность; обрезка до квадрата вокруг рисунка. Возвращает { side, alpha, peak, bg }.
let artCache = null;
function loadArt() {
  if (artCache) return artCache;
  const { w, h, rgba } = decodePng(fs.readFileSync(SOURCE));
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const sorted = Float32Array.from(lum).sort();
  const bg = sorted[Math.floor(w * h * 0.5)];                                // цвет фона — медиана: почти весь кадр это фон
  const peak = sorted[Math.floor(w * h * 0.997)];                            // самые яркие линии
  const EDGE = 8;                                                            // по краю картинки идёт светлая кайма — её не считаем
  const a = new Float32Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inner = x >= EDGE && y >= EDGE && x < w - EDGE && y < h - EDGE;
    const v = inner ? clamp((lum[y * w + x] - bg) / (peak - bg)) : 0;
    a[y * w + x] = v;
    if (v > 0.12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error('на рисунке ничего не найдено');
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1) + 4;
  const ox = Math.round((x0 + x1) / 2 - side / 2), oy = Math.round((y0 + y1) / 2 - side / 2);
  const alpha = new Float32Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const sx = ox + x, sy = oy + y;
    if (sx >= 0 && sy >= 0 && sx < w && sy < h) alpha[y * side + x] = a[sy * w + sx];
  }
  return (artCache = { side, alpha, peak: Math.round(peak), bg: Math.round(bg) });
}

// Утолщение линий (максимум по квадрату радиуса r)
function dilate(src, side, r) {
  if (r <= 0) return src;
  const tmp = new Float32Array(side * side), out = new Float32Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    let m = 0;
    for (let k = -r; k <= r; k++) { const v = src[y * side + clamp(x + k, 0, side - 1)]; if (v > m) m = v; }
    tmp[y * side + x] = m;
  }
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    let m = 0;
    for (let k = -r; k <= r; k++) { const v = tmp[clamp(y + k, 0, side - 1) * side + x]; if (v > m) m = v; }
    out[y * side + x] = m;
  }
  return out;
}

// Квадрат sw×sw -> dw×dw: уменьшение усреднением по площади, увеличение билинейно
function resizeSquare(src, sw, dw) {
  const out = new Float32Array(dw * dw);
  const k = sw / dw;
  if (dw >= sw) {
    for (let y = 0; y < dw; y++) {
      const fy = clamp((y + 0.5) * k - 0.5, 0, sw - 1), y0 = Math.floor(fy), y1 = Math.min(sw - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < dw; x++) {
        const fx = clamp((x + 0.5) * k - 0.5, 0, sw - 1), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        out[y * dw + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty)
          + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
      }
    }
    return out;
  }
  for (let y = 0; y < dw; y++) {
    const ys = y * k, ye = (y + 1) * k;
    for (let x = 0; x < dw; x++) {
      const xs = x * k, xe = (x + 1) * k;
      let sum = 0, wsum = 0;
      for (let yy = Math.floor(ys); yy < Math.min(sw, Math.ceil(ye)); yy++) {
        const wy = Math.min(yy + 1, ye) - Math.max(yy, ys);
        for (let xx = Math.floor(xs); xx < Math.min(sw, Math.ceil(xe)); xx++) {
          const wx = Math.min(xx + 1, xe) - Math.max(xx, xs);
          sum += src[yy * sw + xx] * wy * wx; wsum += wy * wx;
        }
      }
      out[y * dw + x] = sum / wsum;
    }
  }
  return out;
}

// Рисунок стороной T пикселей: на мелких размерах линии утолщаются и подсвечиваются, на крупных остаются как нарисованы
function rasterize(T, alpha) {
  const art = loadArt();
  const scale = T / art.side;
  const r = scale > 0.7 ? 0 : Math.min(9, Math.max(1, Math.round(0.42 / scale)));
  const out = resizeSquare(dilate(alpha, art.side, r), art.side, T);
  const boost = T <= 24 ? 1.6 : T <= 48 ? 1.35 : T <= 96 ? 1.12 : 1;
  for (let i = 0; i < out.length; i++) out[i] = clamp(out[i] * boost);
  return out;
}
const rasterCache = new Map();
function artRaster(T) {
  if (!rasterCache.has(T)) rasterCache.set(T, rasterize(T, loadArt().alpha));
  return rasterCache.get(T);
}

// tile=true — значок с плиткой (расширение, .exe); tile=false — только рисунок на прозрачном фоне (слой Android).
// artFrac — какую долю стороны занимает рисунок; alpha — своя карта прозрачности рисунка (для кадров анимации).
function renderRGBA(size, { tile = true, artFrac = tile ? 0.72 : 0.52, alpha = null } = {}) {
  const A = loadArt();
  const T = Math.max(6, Math.round(size * artFrac));
  const ar = alpha ? rasterize(T, alpha) : artRaster(T);
  const off = Math.floor((size - T) / 2);
  const out = Buffer.alloc(size * size * 4);
  const grey = A.peak, bg = A.bg;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const ax = x - off, ay = y - off;
    const a = ax >= 0 && ay >= 0 && ax < T && ay < T ? ar[ay * T + ax] : 0;
    if (!tile) {
      out[i] = out[i + 1] = out[i + 2] = grey;
      out[i + 3] = Math.round(255 * a);
      continue;
    }
    const u = (x + 0.5) / size, v = (y + 0.5) / size, r = 0.22;
    const qx = Math.abs(u - 0.5) - (0.5 - r), qy = Math.abs(v - 0.5) - (0.5 - r);
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    const cov = clamp(0.5 - sd * size);                    // покрытие плитки (сглаженный край)
    if (cov <= 0) continue;
    const e = clamp(1 + sd / 0.02);                        // тонкий светлый кант по краю, чтобы плитка не терялась на тёмном
    const base = bg + (64 - bg) * 0.55 * e * e;
    out[i] = out[i + 1] = out[i + 2] = Math.round(base * (1 - a) + grey * a);
    out[i + 3] = Math.round(255 * cov);
  }
  return out;
}

const render = (size) => renderRGBA(size, { tile: true });
const png = (size) => encodePng(render(size), size, size);

// ---------- анимация: «дрожание» карандашного эскиза ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Лёгкое плавное искажение рисунка: линии «дрожат», как в покадровой анимации от руки
function wobble(src, side, amp, seed) {
  const rnd = mulberry32(seed), TAU = Math.PI * 2;
  const ph = Array.from({ length: 4 }, () => rnd() * TAU);
  const out = new Float32Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const u = x / side, v = y / side;
    const dx = amp * (0.6 * Math.sin(TAU * (1.7 * u + 1.1 * v) + ph[0]) + 0.4 * Math.sin(TAU * (3.1 * v - 0.9 * u) + ph[1]));
    const dy = amp * (0.6 * Math.sin(TAU * (1.3 * v + 0.8 * u) + ph[2]) + 0.4 * Math.sin(TAU * (2.7 * u + 1.2 * v) + ph[3]));
    const fx = clamp(x + dx, 0, side - 1), fy = clamp(y + dy, 0, side - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(side - 1, x0 + 1), y1 = Math.min(side - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    out[y * side + x] = (src[y0 * side + x0] * (1 - tx) + src[y0 * side + x1] * tx) * (1 - ty)
      + (src[y1 * side + x0] * (1 - tx) + src[y1 * side + x1] * tx) * ty;
  }
  return out;
}

// Кадры анимации значка: рисунок дрожит, яркость линий чуть мерцает
function animationFrames(size, count = 6) {
  const art = loadArt();
  const flicker = [1, 0.93, 1.04, 0.96, 1.02, 0.94];
  const frames = [];
  for (let k = 0; k < count; k++) {
    const a = wobble(art.alpha, art.side, 1.7, 1000 + k * 77);
    for (let i = 0; i < a.length; i++) a[i] = clamp(a[i] * flicker[k % flicker.length]);
    frames.push(renderRGBA(size, { tile: true, alpha: a }));
  }
  return frames;
}

// Анимированный PNG (APNG): играет в браузерах, Electron и WebView без библиотек
function encodeApng(frames, w, h, delayMs) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const actl = Buffer.alloc(8); actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(0, 4);   // 0 повторов = бесконечно
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('acTL', actl)];
  let seq = 0;
  frames.forEach((rgba, i) => {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
    const z = zlib.deflateSync(raw);
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0); fctl.writeUInt32BE(w, 4); fctl.writeUInt32BE(h, 8);   // смещение 0,0
    fctl.writeUInt16BE(delayMs, 20); fctl.writeUInt16BE(1000, 22);                      // задержка кадра: delayMs / 1000 с
    parts.push(chunk('fcTL', fctl));                                                     // dispose=0, blend=0: кадр целиком заменяет предыдущий
    if (i === 0) parts.push(chunk('IDAT', z));
    else { const fd = Buffer.alloc(4 + z.length); fd.writeUInt32BE(seq++, 0); z.copy(fd, 4); parts.push(chunk('fdAT', fd)); }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

module.exports = { render, png, renderRGBA, encodePng, encodeApng, animationFrames, decodePng, loadArt };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const art = loadArt();
  console.log(`рисунок: ${art.side}x${art.side} px, цвет фона ${art.bg}, цвет линий ${art.peak}`);

  const extDir = path.join(root, 'extension', 'icons');
  fs.mkdirSync(extDir, { recursive: true });
  for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(extDir, `${s}.png`), png(s));
  console.log('значки расширения:', extDir);

  // Android: слой переднего плана adaptive-значка (холст 108dp, рисунок лежит в безопасной зоне, центральные 66dp)
  // и сплошной фон того же цвета, что у рисунка
  const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, f] of Object.entries(densities)) {
    const size = Math.round(108 * f);
    const dir = path.join(res, `mipmap-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), encodePng(renderRGBA(size, { tile: false }), size, size));
  }
  const bgHex = art.bg.toString(16).padStart(2, '0').toUpperCase();
  fs.mkdirSync(path.join(res, 'drawable'), { recursive: true });
  fs.writeFileSync(path.join(res, 'drawable', 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<!-- ГЕНЕРИРУЕТСЯ tools/make-icons.js: сплошной фон значка того же цвета, что фон рисунка -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FF${bgHex}${bgHex}${bgHex}"
        android:pathData="M0,0h108v108h-108z" />
</vector>
`);
  console.log('слои значка Android записаны');

  // Анимированный логотип для страницы новой вкладки (ПК и Android) и README: тот же значок, линии эскиза «дрожат».
  // logo-static.png — неподвижная версия для тех, у кого включено «уменьшить движение».
  const logo = encodeApng(animationFrames(192, 6), 192, 192, 110);
  const still = encodePng(render(192), 192, 192);
  for (const dir of [path.join(root, 'desktop', 'ui'), path.join(res, '..', 'assets')]) {
    fs.writeFileSync(path.join(dir, 'logo.png'), logo);
    fs.writeFileSync(path.join(dir, 'logo-static.png'), still);
  }
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'logo.png'), encodeApng(animationFrames(256, 6), 256, 256, 110));
  console.log('анимированный логотип записан (desktop/ui, android assets, assets/logo.png)');
}
