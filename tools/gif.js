'use strict';
// Декодер и кодировщик GIF без зависимостей.
//   decodeGif(buf) -> { width, height, frames: [{ rgba, delay }] }   — кадры уже собраны целиком (с учётом смещений и способов очистки), delay в мс
//   encodeGif(frames, w, h, delayMs)                                 — анимированный GIF с палитрой из 256 оттенков серого (индекс 0 не используется как прозрачный)

// ---------- чтение ----------
function decodeGif(buf) {
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('это не GIF');
  const width = buf.readUInt16LE(6), height = buf.readUInt16LE(8);
  const flags = buf[10], bgIndex = buf[11];
  let pos = 13;
  let globalTable = null;
  if (flags & 0x80) { const n = 3 * (1 << ((flags & 7) + 1)); globalTable = buf.subarray(pos, pos + n); pos += n; }

  const frames = [];
  const canvas = Buffer.alloc(width * height * 4);             // собранный холст (изначально прозрачный)
  let gce = null, prev = null;                                  // управляющий блок следующего кадра, сведения о прошлом кадре для очистки

  while (pos < buf.length) {
    const b = buf[pos++];
    if (b === 0x3b) break;                                      // конец файла
    if (b === 0x21) {                                           // расширение
      const label = buf[pos++];
      if (label === 0xf9) {                                     // управляющий блок графики
        const size = buf[pos];
        const packed = buf[pos + 1];
        gce = { disposal: (packed >> 2) & 7, transparent: packed & 1 ? buf[pos + 4] : -1, delay: buf.readUInt16LE(pos + 2) * 10 };
        pos += size + 1;
        while (buf[pos] !== 0) pos += buf[pos] + 1;
        pos++;
      } else {
        while (buf[pos] !== 0) pos += buf[pos] + 1;
        pos++;
      }
      continue;
    }
    if (b !== 0x2c) throw new Error('неизвестный блок GIF: 0x' + b.toString(16));

    const left = buf.readUInt16LE(pos), top = buf.readUInt16LE(pos + 2), fw = buf.readUInt16LE(pos + 4), fh = buf.readUInt16LE(pos + 6);
    const lf = buf[pos + 8];
    pos += 9;
    let table = globalTable;
    if (lf & 0x80) { const n = 3 * (1 << ((lf & 7) + 1)); table = buf.subarray(pos, pos + n); pos += n; }
    const interlaced = !!(lf & 0x40);
    const minCode = buf[pos++];
    const chunks = [];
    while (buf[pos] !== 0) { chunks.push(buf.subarray(pos + 1, pos + 1 + buf[pos])); pos += buf[pos] + 1; }
    pos++;
    const idx = lzw(Buffer.concat(chunks), minCode, fw * fh);

    // очистка по способу прошлого кадра
    if (prev) {
      if (prev.disposal === 2) fillRect(canvas, width, prev.rect, null);
      else if (prev.disposal === 3 && prev.saved) prev.saved.copy(canvas);
    }
    const g = gce || { disposal: 0, transparent: -1, delay: 100 };
    const saved = g.disposal === 3 ? Buffer.from(canvas) : null;

    // порядок строк при чересстрочной развёртке
    const rows = new Array(fh);
    if (interlaced) {
      let r = 0;
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < fh; y += step) rows[r++] = y;
    } else for (let y = 0; y < fh; y++) rows[y] = y;
    for (let r = 0; r < fh; r++) {
      const y = rows[r] + top;
      if (y >= height) continue;
      for (let x = 0; x < fw; x++) {
        const px = x + left;
        if (px >= width) continue;
        const ci = idx[r * fw + x];
        if (ci === g.transparent) continue;
        const o = (y * width + px) * 4;
        canvas[o] = table[ci * 3]; canvas[o + 1] = table[ci * 3 + 1]; canvas[o + 2] = table[ci * 3 + 2]; canvas[o + 3] = 255;
      }
    }
    frames.push({ rgba: Buffer.from(canvas), delay: Math.max(20, g.delay || 100) });
    prev = { disposal: g.disposal, rect: { left, top, w: fw, h: fh }, saved };
    gce = null;
  }
  return { width, height, frames, bgIndex };
}

function fillRect(canvas, width, r, color) {
  for (let y = r.top; y < r.top + r.h; y++) for (let x = r.left; x < r.left + r.w; x++) {
    const o = (y * width + x) * 4;
    canvas[o] = color ? color[0] : 0; canvas[o + 1] = color ? color[1] : 0; canvas[o + 2] = color ? color[2] : 0; canvas[o + 3] = color ? 255 : 0;
  }
}

// LZW-распаковка данных кадра -> массив индексов палитры
function lzw(data, minCode, total) {
  const clear = 1 << minCode, eoi = clear + 1;
  const out = new Uint8Array(total);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  let codeSize = minCode + 1, mask = (1 << codeSize) - 1, next = eoi + 1, old = -1, first = 0, bits = 0, acc = 0, ip = 0, op = 0;
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; }
  while (op < total) {
    while (bits < codeSize && ip < data.length) { acc |= data[ip++] << bits; bits += 8; }
    if (bits < codeSize) break;
    let code = acc & mask; acc >>>= codeSize; bits -= codeSize;
    if (code === clear) { codeSize = minCode + 1; mask = (1 << codeSize) - 1; next = eoi + 1; old = -1; continue; }
    if (code === eoi) break;
    let sp = 0, cur = code;
    if (old === -1) { out[op++] = suffix[code]; old = code; first = suffix[code]; continue; }
    if (code >= next) { stack[sp++] = first; cur = old; }
    while (cur >= clear) { stack[sp++] = suffix[cur]; cur = prefix[cur]; }
    first = suffix[cur];
    stack[sp++] = first;
    while (sp > 0 && op < total) out[op++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = old; suffix[next] = first; next++;
      if ((next & mask) === 0 && next < 4096) { codeSize++; mask = (1 << codeSize) - 1; }
    }
    old = code;
  }
  return out;
}

// ---------- запись ----------
// frames: массив RGBA-буферов w*h*4 (непрозрачных); цвет превращается в оттенок серого, палитра — 256 оттенков
function encodeGif(frames, w, h, delayMs) {
  const out = [];
  const u16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);
  out.push(Buffer.from('GIF89a', 'latin1'), u16(w), u16(h), Buffer.from([0xf7, 0, 0]));        // глобальная палитра на 256 цветов
  const pal = Buffer.alloc(768);
  for (let i = 0; i < 256; i++) pal[i * 3] = pal[i * 3 + 1] = pal[i * 3 + 2] = i;
  out.push(pal, Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0]));   // бесконечный цикл
  for (const rgba of frames) {
    out.push(Buffer.from([0x21, 0xf9, 4, 0x04, ...u16(Math.round(delayMs / 10)), 0, 0]));      // кадр заменяет предыдущий (disposal=1)
    out.push(Buffer.from([0x2c, 0, 0, 0, 0]), u16(w), u16(h), Buffer.from([0]));
    const idx = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) idx[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
    out.push(Buffer.from([8]), subBlocks(lzwEncode(idx, 8)));
  }
  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
}

function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); parts.push(Buffer.from([n]), data.subarray(i, i + n)); }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function lzwEncode(idx, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  const out = [];
  let bits = 0, acc = 0, codeSize = minCode + 1, next = eoi + 1;
  const emit = (code) => { acc |= code << bits; bits += codeSize; while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; } };
  let dict = new Map();
  emit(clear);
  let cur = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const c = idx[i], key = cur * 256 + c;     // ключ: (код префикса, следующий индекс)
    const hit = dict.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    if (next < 4096) {
      dict.set(key, next++);
      if (next - 1 === (1 << codeSize) && codeSize < 12) codeSize++;
    } else { emit(clear); dict = new Map(); codeSize = minCode + 1; next = eoi + 1; }
    cur = c;
  }
  emit(cur);
  emit(eoi);
  if (bits > 0) out.push(acc & 255);
  return Buffer.from(out);
}

module.exports = { decodeGif, encodeGif };
