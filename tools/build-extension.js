'use strict';
// Собирает расширение в архивы для установки:
//   node tools/build-extension.js [chrome|firefox|all]
// dist/JOKER-extension-chrome.zip   — Chrome, Edge, Brave, Opera, Яндекс.Браузер
// dist/JOKER-extension-firefox.zip  — Firefox и Firefox для Android (+ папка dist/firefox для about:debugging)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = path.join(__dirname, '..', 'extension');
const DIST = path.join(__dirname, '..', 'dist');

function readTree() {
  const files = [];
  (function walk(dir, rel = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.name === 'node_modules' || e.name === 'test' || e.name === 'tests') continue;   // в архив — только расширение
      if (e.isDirectory()) walk(abs, r);
      else files.push({ name: r, data: fs.readFileSync(abs) });
    }
  })(SRC);
  return files;
}

// минимальный zip-писатель (имена с «/», как требуют Chrome и Firefox)
function zip(list) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of list) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const crc = zlib.crc32(f.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    chunks.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

function buildChrome() {
  const files = readTree();
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, 'JOKER-extension-chrome.zip');
  fs.writeFileSync(out, zip(files));
  console.log('Chrome-архив:', out);
}

function buildFirefox() {
  const files = readTree();
  const mf = files.find((f) => f.name === 'manifest.json');
  const m = JSON.parse(mf.data.toString('utf8'));
  m.background = { scripts: ['background.js'] };          // Firefox: фоновый скрипт вместо service worker
  delete m.minimum_chrome_version;
  m.browser_specific_settings = {
    gecko: {
      id: 'joker@local.invalid',
      strict_min_version: '128.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '128.0' },
  };
  mf.data = Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf8');

  const dir = path.join(DIST, 'firefox');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const p = path.join(dir, f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.data);
  }
  const out = path.join(DIST, 'JOKER-extension-firefox.zip');
  fs.writeFileSync(out, zip(files));
  console.log('Firefox-архив:', out);
}

const target = process.argv[2] || 'all';
if (target === 'chrome' || target === 'all') buildChrome();
if (target === 'firefox' || target === 'all') buildFirefox();
