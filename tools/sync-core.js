'use strict';
// Единственный источник подмены — extension/core.js.
// Этот скрипт собирает из него desktop/preload-page.js (добавляя связку с IPC Electron).
//   node tools/sync-core.js          — перегенерировать
//   node tools/sync-core.js --check  — только проверить, что файл актуален (для CI)
// Для Android core.js копируется Gradle-задачей syncCore (см. android/app/build.gradle.kts).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'extension', 'core.js'), 'utf8');
const target = path.join(root, 'desktop', 'preload-page.js');

const header = `// ФАЙЛ СОЗДАЁТСЯ АВТОМАТИЧЕСКИ — не правьте руками.
// Меняйте extension/core.js и запускайте: node tools/sync-core.js
// Выполняется в КАЖДОМ фрейме страницы (и в iframe) до скриптов сайта, в главном мире страницы.
`;

const glue = `
// ---------- связка с главным процессом Electron: начальные флаги и живое обновление ----------
(() => {
  const { ipcRenderer } = require('electron');
  const K = Symbol.for('wnd.s');
  let f = { fullscreen: false, focus: false };
  try { f = ipcRenderer.sendSync('flags:get') || f; } catch (_) {}
  const S = window[K] || Object.defineProperty(window, K, {
    value: { focus: false, fullscreen: false }, configurable: true,
  })[K];
  S.focus = !!f.focus;
  S.fullscreen = !!f.fullscreen;
  ipcRenderer.on('flags:set', (_e, nf) => {
    window.dispatchEvent(new CustomEvent('wnd:s', {
      detail: { focus: !!nf.focus, fullscreen: !!nf.fullscreen },
    }));
  });
})();

// ---------- общая логика подмены (extension/core.js) ----------
`;

const out = header + glue + core;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (cur !== out) {
    console.error('desktop/preload-page.js устарел: запустите node tools/sync-core.js');
    process.exit(1);
  }
  console.log('desktop/preload-page.js актуален');
} else {
  fs.writeFileSync(target, out);
  console.log('записан', path.relative(root, target));
}
