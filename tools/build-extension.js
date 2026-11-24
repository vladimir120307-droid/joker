'use strict';
// Собирает расширение в архивы для установки:
//   node tools/build-extension.js [chrome|firefox|all]
// dist/JOKER-extension-chrome.zip   — Chrome, Edge, Brave, Opera, Яндекс.Браузер
// dist/JOKER-extension-firefox.zip  — Firefox и Firefox для Android (+ папка dist/firefox для about:debugging)
const fs = require('fs');
const path = require('path');
const { zip, readDir } = require('./zip');

const SRC = path.join(__dirname, '..', 'extension');
const DIST = path.join(__dirname, '..', 'dist');

// в архив — только само расширение
const readTree = () => readDir(SRC, { skip: (name) => name === 'node_modules' || name === 'test' || name === 'tests' });

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
