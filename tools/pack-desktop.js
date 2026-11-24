'use strict';
// Собирает браузер для Windows (x64), без установщика:
//   desktop/out/JOKER-win32-x64/JOKER.exe           — готовая программа (портативная папка)
//   desktop/out/JOKER-desktop-windows-x64.zip       — то же одним архивом (внутри папка JOKER)
// Запуск: cd desktop && npm install && npm run package
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { zip, readDir } = require('./zip');

const desktop = path.join(__dirname, '..', 'desktop');
const out = path.join(desktop, 'out');
const archive = path.join(out, 'JOKER-desktop-windows-x64.zip');

// @electron/packager — ESM-пакет, поэтому подключаем его динамическим import()
async function loadPackager() {
  const entry = require.resolve('@electron/packager', { paths: [desktop] });
  const mod = await import(pathToFileURL(entry).href);
  const fn = mod.packager || mod.default;
  if (typeof fn !== 'function') throw new Error('Не удалось подключить @electron/packager: выполните npm install в папке desktop');
  return fn;
}

(async () => {
  const packager = await loadPackager();

  const icon = path.join(desktop, 'build', 'icon.ico');
  if (!fs.existsSync(icon)) execFileSync(process.execPath, [path.join(__dirname, 'make-ico.js')], { stdio: 'inherit' });

  fs.rmSync(out, { recursive: true, force: true });
  const [appDir] = await packager({
    dir: desktop,
    out,
    name: 'JOKER',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: true,
    prune: true,
    icon,
    // в программу не нужны: результаты сборки, значок (он вшивается в .exe), запуск из исходников, lock-файл
    // и node_modules целиком (у браузера нет сторонних зависимостей; там только Electron и упаковщик для сборки)
    ignore: [/^\/out($|\/)/, /^\/build($|\/)/, /^\/start\.bat$/, /^\/package-lock\.json$/, /^\/node_modules($|\/)/],
    win32metadata: {
      CompanyName: 'JOKER',
      FileDescription: 'JOKER',
      ProductName: 'JOKER',
      InternalName: 'JOKER',
      OriginalFilename: 'JOKER.exe',
    },
  });
  console.log('Папка с программой:', appDir);

  const files = readDir(appDir, { prefix: 'JOKER' });   // внутри архива всё лежит в папке JOKER
  fs.writeFileSync(archive, zip(files));
  console.log(`Архив: ${archive} (${(fs.statSync(archive).size / 1048576).toFixed(1)} МБ, файлов: ${files.length})`);
})().catch((e) => { console.error(e); process.exit(1); });
