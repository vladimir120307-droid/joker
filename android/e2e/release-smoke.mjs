// Быстрая проверка РЕЛИЗНОЙ сборки (R8, без отладочного порта) на эмуляторе или телефоне.
//
//   cd android && ./gradlew :app:assembleRelease
//   node android/e2e/release-smoke.mjs
//
// В релизной сборке отладка WebView выключена, поэтому состояние страницы читается с экрана:
// тестовая страница выводит статус в DOM, а uiautomator видит этот текст. Зависимостей нет.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PKG = 'app.joker.browser';
const ROOT = path.resolve(import.meta.dirname, '..');
const APK = process.env.APK || path.join(ROOT, 'app', 'build', 'outputs', 'apk', 'release', 'JOKER-release.apk');
const OUT = process.env.OUT_DIR || path.join(import.meta.dirname, 'out');
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
const ADB = process.env.ADB || (SDK ? path.join(SDK, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const adbBin = (...a) => execFileSync(ADB, a, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

let failed = 0;
const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, extra) => {
  if (!ok) failed++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`);
};

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>smoke</title>
<script>
var n={vis:0,blur:0,focus:0};
document.addEventListener('visibilitychange',function(){n.vis++});
window.addEventListener('blur',function(){n.blur++});
window.addEventListener('focus',function(){n.focus++});
setInterval(function(){var e=document.getElementById('s');if(e)e.textContent='STATE vs='+document.visibilityState+' hidden='+document.hidden+' vis='+n.vis+' blur='+n.blur+' fs='+(!!document.fullscreenElement)+' iw='+(innerWidth===screen.width)+' ih='+(innerHeight===screen.height);},150);
</script><h1>smoke</h1><div id=s>-</div>`;
const server = http.createServer((rq, rs) => { rs.setHeader('content-type', 'text/html; charset=utf-8'); rs.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function uiNodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/ui.xml');
  const out = [];
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = {};
    for (const kv of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[kv[1]] = decode(kv[2]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || '');
    if (b) out.push({ id: a['resource-id'], text: a.text, x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2) });
  }
  return out;
}
const tap = (id) => {
  const n = uiNodes().find((x) => x.id === `${PKG}:id/${id}`);
  if (!n) throw new Error('нет элемента ' + id);
  adb('shell', 'input', 'tap', String(n.x), String(n.y));
};
/** Статус со страницы: читаем текст из дерева доступности, пока он не появится. */
async function readState(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n = uiNodes().find((x) => (x.text || '').startsWith('STATE'));
    if (n) {
      const o = {};
      for (const kv of n.text.matchAll(/(\w+)=(\w+)/g)) o[kv[1]] = kv[2];
      return o;
    }
    await sleep(500);
  }
  return null;
}
const home = async () => { adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await sleep(2500); };
const back = async () => { adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await sleep(2000); };
const open = async (suffix) => {
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://localhost:${port}/${suffix}`, PKG);
  await sleep(2500);
};

try {
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'svc', 'power', 'stayon', 'true');
  try { adb('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed'); } catch { /* */ }
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  try { adb('uninstall', PKG); } catch { /* не был установлен */ }
  log('установка релизной сборки: ' + adb('install', '-r', APK).trim());
  adb('shell', 'logcat', '-c');
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(3500);

  const debuggable = adb('shell', 'dumpsys', 'package', PKG).includes('DEBUGGABLE');
  check('сборка не отладочная (debuggable выключен)', !debuggable);

  await open('a');
  let s = await readState();
  check('релиз запускается, страница открывается и выполняет скрипты', !!s, s);
  check('режимы выключены: страница видна (visible, hidden=false)', s && s.vs === 'visible' && s.hidden === 'false', s);

  // базовая линия: без режима уход в фон виден странице
  await home(); await back();
  s = await readState();
  check('без режима уход в фон виден странице (visibilitychange приходит)', s && Number(s.vis) >= 1, s);

  // «Скрыть»: новая вкладка, чтобы счётчики начались с нуля
  await open('b');
  tap('btn_focus'); await sleep(900);
  await home(); await back();
  s = await readState();
  check('«Скрыть» в релизе: страница в фоне видна и событий нет (vis=0, blur=0)',
    s && s.vs === 'visible' && s.hidden === 'false' && s.vis === '0' && s.blur === '0', s);

  tap('btn_fs'); await sleep(1200);
  s = await readState();
  check('«Экран» в релизе: fullscreenElement, размеры окна = размеры экрана', s && s.fs === 'true' && s.iw === 'true' && s.ih === 'true', s);
  fs.writeFileSync(path.join(OUT, 'release-both-on.png'), adbBin('exec-out', 'screencap', '-p'));

  const crash = adb('logcat', '-d', '-b', 'crash');
  check('в журнале нет аварий', !crash.includes(PKG), crash.slice(0, 300));
} catch (e) {
  failed++;
  log('ОШИБКА ТЕСТА: ' + (e && e.stack || e));
}

try { adb('reverse', '--remove-all'); adb('shell', 'svc', 'power', 'stayon', 'false'); } catch { /* */ }
server.close();
log(failed ? `\nИТОГ: провалено проверок: ${failed}` : '\nИТОГ: все проверки пройдены');
fs.writeFileSync(path.join(OUT, 'release-results.txt'), lines.join('\n'), 'utf8');
process.exit(failed ? 1 : 0);
