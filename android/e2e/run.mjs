// Проверка приложения на настоящем Android (эмулятор или телефон по USB).
//
//   1) соберите отладочный APK:  cd android && ./gradlew :app:assembleDebug
//   2) запустите эмулятор или подключите телефон (adb devices должен показывать устройство)
//   3) node android/e2e/run.mjs
//
// Переменные: APK (путь к app-debug.apk), ADB, OUT_DIR (куда класть скриншоты и results.txt).
// Нужен Node 22+ (используются встроенные fetch и WebSocket). Зависимостей нет.
//
// Как это работает: тестовые страницы раздаёт этот скрипт, на устройство они пробрасываются через adb reverse.
// Приложение уводится в фон настоящей кнопкой Home, а состояние страницы читается через отладочный порт WebView
// (в отладочной сборке он включён). Кнопки нажимаются настоящим тапом по координатам из uiautomator.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PKG = 'app.joker.browser';
const ROOT = path.resolve(import.meta.dirname, '..');
const APK = process.env.APK || path.join(ROOT, 'app', 'build', 'outputs', 'apk', 'debug', 'JOKER-debug.apk');
const OUT = process.env.OUT_DIR || path.join(import.meta.dirname, 'out');
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
const ADB = process.env.ADB || (SDK ? path.join(SDK, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const adbBin = (...args) => execFileSync(ADB, args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

let failed = 0;
const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, extra) => {
  if (!ok) failed++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`);
};
// ONLY=priv,menu — запустить только выбранные разделы (раздел «boot» выполняется всегда)
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const TAGS = [['Запуск', 'boot'], ['Режим «Скрыть»', 'focus'], ['Режим «Экран»', 'screen'], ['Видео', 'video'],
  ['Адресная', 'nav'], ['Диалоги', 'dialogs'], ['Меню', 'menu'], ['Загрузка', 'download'], ['Вкладки', 'tabs'],
  ['Приватность', 'priv'], ['Выход', 'relaunch'], ['Поворот', 'rotate'], ['Тема', 'theme']];
async function section(name, fn) {
  const tag = (TAGS.find(([prefix]) => name.startsWith(prefix)) || ['', ''])[1];
  if (ONLY && tag !== 'boot' && !ONLY.includes(tag)) return;
  log(`\n— ${name}`);
  try { await fn(); } catch (e) { failed++; log(`FAIL  «${name}» прервано: ${e && e.message || e}`); }
}

// ---------- тестовые страницы ----------
const COUNTERS = `<script>
window.__early=(()=>{const s=window[Symbol.for('wnd.s')];return s?{focus:!!s.focus,fullscreen:!!s.fullscreen}:null})();
window.__n={vis:0,blur:0,focus:0,fs:0};
document.addEventListener('visibilitychange',()=>__n.vis++);
window.addEventListener('blur',()=>__n.blur++);
window.addEventListener('focus',()=>__n.focus++);
document.addEventListener('fullscreenchange',()=>__n.fs++);
window.__frameState=null;
window.addEventListener('message',e=>{if(e.data&&e.data.jkFrame)window.__frameState=e.data.jkFrame;});
window.__askFrame=()=>new Promise(res=>{window.__frameState=null;
  if(!frames[0]){res(null);return;} frames[0].postMessage('jk-probe','*');
  const t0=Date.now();(function w(){if(window.__frameState||Date.now()-t0>3000)res(window.__frameState);else setTimeout(w,50);})();});
</script>`;
const FRAME_PAGE = `<!doctype html><meta charset=utf-8><body>frame<script>
window.addEventListener('message',e=>{if(e.data==='jk-probe'){const s=window[Symbol.for('wnd.s')];
parent.postMessage({jkFrame:{hidden:document.hidden,vs:document.visibilityState,hasFocus:document.hasFocus(),
flags:s?{focus:!!s.focus,fullscreen:!!s.fullscreen}:null}},'*');}});
</script></body>`;

const servers = [];
const listen = (handler) => new Promise((res) => {
  const s = http.createServer(handler).listen(0, '127.0.0.1', () => { servers.push(s); res(s.address().port); });
});
const pB = await listen((rq, rs) => { rs.setHeader('content-type', 'text/html; charset=utf-8'); rs.end(FRAME_PAGE); });
const pA = await listen((rq, rs) => {
  if (rq.url === '/file.txt') {
    rs.setHeader('content-type', 'text/plain');
    rs.setHeader('content-disposition', 'attachment; filename="jk-file.txt"');
    return rs.end('hello');
  }
  rs.setHeader('content-type', 'text/html; charset=utf-8');
  rs.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><head><title>jk-test ${rq.url}</title>${COUNTERS}</head>
  <body><h1>Тест</h1><p>${rq.url}</p><iframe src="http://127.0.0.1:${pB}/f" width=280 height=80></iframe></body>`);
});
const URL_A = `http://localhost:${pA}/`;

// ---------- работа с устройством ----------
function pid() {
  try { return adb('shell', 'pidof', PKG).trim().split(/\s+/)[0]; } catch { return ''; }
}
function forwardCdp() {
  const p = pid();
  if (!p) throw new Error('приложение не запущено');
  try { adb('forward', '--remove', 'tcp:9222'); } catch { /* не было */ }
  adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${p}`);
}
async function targets() {
  const r = await fetch('http://127.0.0.1:9222/json');
  return (await r.json()).filter((t) => t.type === 'page');
}
async function waitTarget(match, ms = 20000, label = 'вкладка') {
  const t0 = Date.now();
  let seen = [];
  while (Date.now() - t0 < ms) {
    try {
      seen = await targets();
      const t = seen.find((x) => match(x));
      if (t) return t;
    } catch { /* порт ещё не готов */ }
    await sleep(400);
  }
  throw new Error(`${label} не появилась; открыты: ${seen.map((x) => x.url.slice(0, 60)).join(' | ')}`);
}
function cdp(target, expression, { awaitPromise = false, userGesture = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('cdp: таймаут')); }, 20000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise, userGesture },
    }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer); ws.close();
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else if (m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails)));
      else resolve(m.result.result.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('cdp: ошибка соединения')); };
  });
}

const PROBE = `JSON.stringify({
  hidden: document.hidden, vs: document.visibilityState, hasFocus: document.hasFocus(),
  fsEl: !!document.fullscreenElement, fsRoot: document.fullscreenElement === document.documentElement,
  fsEnabled: document.fullscreenEnabled,
  ih: innerHeight === screen.height, iw: innerWidth === screen.width,
  mm: matchMedia('(display-mode: fullscreen)').matches,
  n: window.__n, early: window.__early,
  flags: (()=>{const s=window[Symbol.for('wnd.s')];return s?{focus:!!s.focus,fullscreen:!!s.fullscreen}:null})(),
  ua: navigator.userAgent,
})`;
const probe = async (t) => JSON.parse(await cdp(t, PROBE));
const resetN = (t) => cdp(t, 'Object.keys(__n).forEach(k=>__n[k]=0)');
const askFrame = (t) => cdp(t, 'window.__askFrame()', { awaitPromise: true });

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
function uiNodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/ui.xml');
  const out = [];
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = {};
    for (const kv of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[kv[1]] = decode(kv[2]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || '');
    if (!b) continue;
    out.push({ id: a['resource-id'], text: a.text, desc: a['content-desc'], x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2) });
  }
  return out;
}
const fullId = (id) => (id.includes(':') ? id : `${PKG}:id/${id}`);
const byId = (id) => uiNodes().find((n) => n.id === fullId(id));
const tapNode = (n) => adb('shell', 'input', 'tap', String(n.x), String(n.y));
function tap(id) {
  const n = byId(id);
  if (!n) throw new Error('нет элемента ' + id);
  tapNode(n);
}
function tapText(text) {
  const n = uiNodes().find((x) => x.text === text);
  if (!n) throw new Error('нет пункта «' + text + '»');
  tapNode(n);
}
async function waitNode(pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n = uiNodes().find(pred);
    if (n) return n;
    await sleep(300);
  }
  return null;
}
const screenshot = (name) => fs.writeFileSync(path.join(OUT, name + '.png'), adbBin('exec-out', 'screencap', '-p'));
const key = (k) => adb('shell', 'input', 'keyevent', k);
const home = async () => { key('KEYCODE_HOME'); await sleep(2500); };
const back = async () => { adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await sleep(1800); };
const typeText = async (text) => { adb('shell', 'input', 'text', text); await sleep(300); };

/** Тап по полю и ввод текста; результат сверяется, а ввод повторяется, если клавиатура ещё не успела подняться. */
async function typeInto(id, text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    tap(id); await sleep(900);
    if (attempt > 0) adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END', ...Array(80).fill('KEYCODE_DEL'));
    await typeText(text);
    await sleep(300);
    const n = byId(id);
    if (n && n.text === text) return;
  }
  throw new Error(`не удалось ввести текст в поле ${id}`);
}

/** Открывает адрес в новой вкладке (так же, как ссылка из другого приложения) и ждёт её. */
async function openPage(suffix = '') {
  const url = URL_A + suffix;
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, PKG);
  const t = await waitTarget((x) => x.url === url);
  await sleep(1200);
  return t;
}

// ---------- сценарий ----------
try {
  const devices = adb('devices').split('\n').slice(1).filter((l) => /\sdevice$/.test(l.trim()));
  if (!devices.length) throw new Error('нет подключённых устройств (adb devices)');
  log('устройство: ' + devices[0].split(/\s+/)[0] + ' | Android ' + adb('shell', 'getprop', 'ro.build.version.release').trim()
    + ' (API ' + adb('shell', 'getprop', 'ro.build.version.sdk').trim() + ')');

  key('KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('shell', 'svc', 'power', 'stayon', 'true');
  try { adb('shell', 'cmd', 'uimode', 'night', 'no'); } catch { /* старые версии */ }
  // системная подсказка «Просмотр в полноэкранном режиме» при первом входе в immersive перехватывает касания
  try { adb('shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed'); } catch { /* */ }
  adb('reverse', `tcp:${pA}`, `tcp:${pA}`);
  adb('reverse', `tcp:${pB}`, `tcp:${pB}`);
  try { adb('uninstall', PKG); } catch { /* не был установлен */ }
  log('установка: ' + adb('install', '-r', APK).trim());
} catch (e) {
  failed++;
  log('ОШИБКА ПОДГОТОВКИ: ' + (e && e.stack || e));
}

let t = null;   // главная тестовая вкладка

await section('Запуск', async () => {
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(3000);
  forwardCdp();
  const tNew = await waitTarget((x) => /newtab\.html/.test(x.url));
  check('приложение запускается и показывает страницу новой вкладки', !!tNew, tNew.url);
  screenshot('01-new-tab');

  t = await openPage('');
  const p = await probe(t);
  check('страница открылась по ссылке из другого приложения (intent VIEW)', p.flags !== null, p.flags);
  check('User-Agent без пометок WebView', !/; wv|Version\/4\.0/.test(p.ua), p.ua);
  check('режимы по умолчанию выключены', p.flags && !p.flags.focus && !p.flags.fullscreen, p.flags);
  check('iframe на другом сайте загрузился', (await askFrame(t)) !== null);
  screenshot('02-test-page');
});

await section('Режим «Скрыть»: настоящий уход в фон кнопкой Home', async () => {
  // базовая линия: режим выключен — что видит сайт без защиты
  await resetN(t);
  await home();
  const bgBase = await probe(t);
  await back();
  const afterBase = await probe(t);
  log('базовая линия (режим выключен): в фоне ' + JSON.stringify({ hidden: bgBase.hidden, vs: bgBase.vs }) + ', события ' + JSON.stringify(afterBase.n));
  check('базовая линия: уход в фон виден странице (hidden=true, visibilitychange)',
    bgBase.hidden === true && bgBase.vs === 'hidden' && afterBase.n.vis >= 1, { hidden: bgBase.hidden, n: afterBase.n });

  tap('btn_focus'); await sleep(800);
  let p = await probe(t);
  check('тап по кнопке включил режим на странице сразу', p.flags && p.flags.focus === true, p.flags);
  const fr1 = await askFrame(t);
  check('режим дошёл и до iframe другого сайта (мост между фреймами)', fr1 && fr1.flags && fr1.flags.focus === true, fr1);
  screenshot('03-focus-on');

  await resetN(t);
  await home();
  const bgFocus = await probe(t);
  const frBg = await askFrame(t);
  await back();
  const afterFocus = await probe(t);
  log('со скрытием: в фоне ' + JSON.stringify({ hidden: bgFocus.hidden, vs: bgFocus.vs, hasFocus: bgFocus.hasFocus }) + ', события ' + JSON.stringify(afterFocus.n));
  check('в фоне hidden=false, visibilityState=visible, hasFocus=true', bgFocus.hidden === false && bgFocus.vs === 'visible' && bgFocus.hasFocus === true);
  check('страница не получила visibilitychange/blur/focus', afterFocus.n.vis === 0 && afterFocus.n.blur === 0 && afterFocus.n.focus === 0, afterFocus.n);
  check('то же внутри iframe другого сайта', frBg && frBg.hidden === false && frBg.vs === 'visible' && frBg.hasFocus === true, frBg);

  await cdp(t, 'location.reload()'); await sleep(2500);
  t = await waitTarget((x) => x.url === URL_A);
  p = await probe(t);
  check('после перезагрузки режим уже стоит ДО скриптов сайта', p.early && p.early.focus === true, p.early);
  const fr2 = await askFrame(t);
  check('после перезагрузки iframe тоже защищён с первого скрипта', fr2 && fr2.flags && fr2.flags.focus === true, fr2);

  // всплывающее окно наследует режимы, а закрытие возвращает на родителя
  const before = (await targets()).length;
  await cdp(t, `window.open('http://localhost:${pA}/popup','_blank'), 1`, { userGesture: true });
  const popupT = await waitTarget((x) => x.url === `http://localhost:${pA}/popup`);
  await sleep(1200);
  check('window.open по жесту пользователя открывает новую вкладку', (await targets()).length === before + 1);
  const pp = await probe(popupT);
  check('новая вкладка со страницы наследует режим с первого скрипта', pp.early && pp.early.focus === true, pp.early);
  await cdp(popupT, 'window.close(), 1');
  await sleep(1500);
  check('window.close() закрывает вкладку', (await targets()).length === before);
  const shown = byId('url_bar');
  check('после закрытия показывается вкладка-родитель', shown && shown.text === `localhost:${pA}`, shown && shown.text);
});

await section('Режим «Экран»', async () => {
  tap('btn_fs'); await sleep(900);
  t = await waitTarget((x) => x.url === URL_A);
  const p = await probe(t);
  check('fullscreenElement=<html>, fullscreenEnabled, размеры окна = размеры экрана, (display-mode: fullscreen)',
    p.fsEl && p.fsRoot && p.fsEnabled && p.ih && p.iw && p.mm, { fsEl: p.fsEl, ih: p.ih, iw: p.iw, mm: p.mm });
  check('включённый «Скрыть» при этом не сбросился', p.flags && p.flags.focus === true && p.flags.fullscreen === true, p.flags);
  const fr = await askFrame(t);
  check('режим дошёл и до iframe другого сайта', fr && fr.flags && fr.flags.fullscreen === true, fr);
  const rq = await cdp(t, "document.body.requestFullscreen().then(()=>'resolved',e=>'rejected:'+e)", { awaitPromise: true, userGesture: true });
  await sleep(700);
  check('requestFullscreen() успешно завершается, а панели приложения остаются на месте',
    rq === 'resolved' && !!byId('btn_back') && !byId('fullscreen_holder'), rq);
  screenshot('04-both-on');
  await cdp(t, 'document.exitFullscreen()', { awaitPromise: true });

  tap('btn_focus'); await sleep(800);
  tap('btn_fs'); await sleep(800);
  const off = await probe(t);
  check('оба режима выключаются тапом', off.flags && !off.flags.focus && !off.flags.fullscreen && !off.fsEl, off.flags);
  await resetN(t); await home();
  const bgOff = await probe(t); await back();
  check('после выключения страница снова видит уход в фон', bgOff.hidden === true, { hidden: bgOff.hidden });
});

await section('Видео на весь экран (настоящий полный экран, режимы выключены)', async () => {
  const tv = await openPage('video');
  const rq = await cdp(tv, "document.body.requestFullscreen().then(()=>'resolved',e=>'rejected:'+e)", { awaitPromise: true, userGesture: true });
  await sleep(1200);
  const cling = await waitNode((n) => n.id === 'android:id/ok', 1500);   // подсказка Android, если настройка не помогла
  if (cling) { tapNode(cling); await sleep(600); }
  check('requestFullscreen() включает настоящий полный экран: панели приложения скрыты',
    rq === 'resolved' && !!byId('fullscreen_holder') && !byId('btn_back'), rq);
  screenshot('05-real-fullscreen');
  key('KEYCODE_BACK'); await sleep(1200);
  check('кнопка «назад» выходит из полного экрана и возвращает панели',
    !byId('fullscreen_holder') && !!byId('btn_back') && (await cdp(tv, '!document.fullscreenElement')) === true);
});

await section('Адресная строка и страница ошибки', async () => {
  await openPage('nav');
  await typeInto('url_bar', `localhost:${pA}/typed`);
  screenshot('12-typing-with-keyboard');
  check('при открытой клавиатуре нижняя панель скрывается, а адресная строка остаётся доступной',
    !byId('btn_menu') && !!byId('url_bar'));
  key('KEYCODE_ENTER');
  const typed = await waitTarget((x) => x.url === `http://localhost:${pA}/typed`, 20000, 'вкладка /typed');
  check('локальный адрес без схемы открывается по http', !!typed);
  await sleep(800);

  await typeInto('url_bar', 'localhost:1');
  key('KEYCODE_ENTER');
  const err = await waitTarget((x) => x.url.startsWith('https://appassets.androidplatform.net/error?'), 20000, 'страница ошибки');
  check('недоступный сервер показывает страницу ошибки', !!err, err.url.slice(0, 80));
  await sleep(800);
  const shown = byId('url_bar');
  check('в адресной строке при этом виден исходный адрес', shown && shown.text === 'localhost:1', shown && shown.text);
  screenshot('06-error-page');

  // «назад» со страницы ошибки не должен зацикливаться на неудавшемся адресе
  key('KEYCODE_BACK'); await sleep(1800);
  const after = await waitTarget((x) => x.url === `http://localhost:${pA}/typed`, 10000, 'предыдущая страница после «назад»');
  const bar = byId('url_bar');
  check('«назад» со страницы ошибки возвращает на предыдущую страницу, а не зацикливается',
    !!after && bar && bar.text === `localhost:${pA}/typed`, bar && bar.text);
});

await section('Диалоги страницы и запрос микрофона', async () => {
  const td = await openPage('dlg');
  const okId = 'android:id/button1';
  const noId = 'android:id/button2';

  await cdp(td, "window.__a=0; setTimeout(()=>{alert('hello'); window.__a=1},0); 1");
  let b = await waitNode((n) => n.id === okId);
  check('alert() показывает окно с кнопкой OK', !!b);
  if (b) tapNode(b);
  await sleep(800);
  check('после OK страница продолжает выполнение', (await cdp(td, 'window.__a')) === 1);

  await cdp(td, "window.__c=null; setTimeout(()=>{window.__c=confirm('sure?')},0); 1");
  b = await waitNode((n) => n.id === okId); if (b) tapNode(b); await sleep(800);
  check('confirm() возвращает true после OK', (await cdp(td, 'window.__c')) === true);

  await cdp(td, "window.__c2=null; setTimeout(()=>{window.__c2=confirm('sure2?')},0); 1");
  b = await waitNode((n) => n.id === noId); if (b) tapNode(b); await sleep(800);
  check('confirm() возвращает false после «Отмена»', (await cdp(td, 'window.__c2')) === false);

  await cdp(td, "window.__p=null; setTimeout(()=>{window.__p=prompt('q','def')},0); 1");
  b = await waitNode((n) => n.id === okId); if (b) tapNode(b); await sleep(800);
  check('prompt() возвращает значение по умолчанию после OK', (await cdp(td, 'window.__p')) === 'def');

  await cdp(td, "window.__gum='pending'; navigator.mediaDevices.getUserMedia({audio:true}).then(()=>{window.__gum='granted'},e=>{window.__gum=e.name}); 1");
  const msg = await waitNode((n) => n.id === 'android:id/message' && /микрофон/.test(n.text || ''));
  check('запрос микрофона показывает диалог разрешения с названием сайта и ресурса', !!msg, msg && msg.text);
  screenshot('07-permission');
  b = await waitNode((n) => n.id === noId);   // «Блокировать» (на кнопках включён textAllCaps, поэтому ищем по id)
  if (b) tapNode(b);
  await sleep(1000);
  check('«Блокировать» отклоняет запрос (NotAllowedError)', (await cdp(td, 'window.__gum')) === 'NotAllowedError', await cdp(td, 'window.__gum'));
});

await section('Меню: версия для ПК и поиск по странице', async () => {
  const tm = await openPage('find');
  tap('btn_menu'); await sleep(800); tapText('Версия для ПК'); await sleep(3000);
  const ua = await cdp(tm, 'navigator.userAgent');
  check('«Версия для ПК» меняет User-Agent на настольный', /Windows NT/.test(ua), ua);
  tap('btn_menu'); await sleep(800); tapText('Версия для ПК'); await sleep(3000);
  const ua2 = await cdp(tm, 'navigator.userAgent');
  check('повторное нажатие возвращает мобильный', /Android/.test(ua2), ua2);

  tap('btn_menu'); await sleep(800); tapText('Найти на странице'); await sleep(900);
  await typeText('find');
  await sleep(1200);
  const cnt = byId('find_count');
  check('поиск находит совпадение и показывает счётчик', cnt && /^1\/\d+$/.test(cnt.text), cnt && cnt.text);
  screenshot('08-find');
  key('KEYCODE_BACK'); await sleep(500);
  key('KEYCODE_BACK'); await sleep(700);
});

await section('Загрузка файла', async () => {
  const tf = await openPage('dl');
  try { adb('shell', 'rm', '-f', '/sdcard/Download/jk-file.txt'); } catch { /* */ }
  await cdp(tf, "location.href='/file.txt'; 1");
  let found = false;
  for (let i = 0; i < 24 && !found; i++) {
    await sleep(500);
    try { found = adb('shell', 'ls', '/sdcard/Download').includes('jk-file.txt'); } catch { /* */ }
  }
  check('ссылка на файл запускает загрузку в «Загрузки»', found);
  const content = found ? adb('shell', 'cat', '/sdcard/Download/jk-file.txt').trim() : '';
  check('файл скачан целиком', content === 'hello', content);
  try { adb('shell', 'rm', '-f', '/sdcard/Download/jk-file.txt'); } catch { /* */ }
});

await section('Вкладки и меню', async () => {
  tap('btn_tabs'); await sleep(900);
  check('список вкладок открывается', !!byId('tab_list'));
  screenshot('09-tab-switcher');
  key('KEYCODE_BACK'); await sleep(700);
  check('кнопка «назад» закрывает список вкладок', !byId('tab_list') && !!byId('btn_menu'));
  tap('btn_menu'); await sleep(900);
  screenshot('10-menu');
  key('KEYCODE_BACK'); await sleep(700);
});

await section('Приватность: данные не переживают сеанс', async () => {
  const dirs = () => { try { return adb('shell', `run-as ${PKG} ls app_webview`).split(/\s*\n/).filter(Boolean); } catch { return []; } };
  const profiles = (list) => list.filter((d) => /^Profile \d+$/.test(d));
  // файлы данных WebView, в которых встречается строка (так видно, что реально осталось на диске)
  const onDisk = (pattern) => {
    try { return adb('shell', `run-as ${PKG} grep -rla ${pattern} app_webview`).split(/\s*\n/).filter(Boolean); } catch { return []; }
  };

  const t1 = await openPage('priv1');
  await cdp(t1, "document.cookie='jk=1; path=/'; localStorage.setItem('jk','1'); 1");
  check('cookie и localStorage записались', (await cdp(t1, 'document.cookie')).includes('jk=1') && (await cdp(t1, "localStorage.getItem('jk')")) === '1');
  log('каталоги WebView до перезапуска: ' + dirs().join(', '));

  adb('shell', 'am', 'force-stop', PKG); await sleep(1500);   // аварийное завершение: профиль не успел удалиться
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await sleep(3500);
  forwardCdp();
  const after = dirs();
  log('каталоги WebView после перезапуска: ' + after.join(', '));
  check('остатки профиля прошлого запуска удалены (остался ровно один профиль)', profiles(after).length === 1, after);
  check('после перезапуска на диске нет следов прошлого сеанса (адресов посещённых сайтов)', onDisk('localhost').length === 0, onDisk('localhost'));

  const t2 = await openPage('priv2');
  check('после перезапуска cookie пусты', (await cdp(t2, 'document.cookie')) === '', await cdp(t2, 'document.cookie'));
  check('после перезапуска localStorage пуст', (await cdp(t2, "localStorage.getItem('jk')")) === null);

  // «Завершить сеанс» из меню: на диске не должно остаться ни значений, ни адресов посещённых сайтов
  await cdp(t2, "document.cookie='jk=JKMARKER2; path=/'; localStorage.setItem('jk','JKMARKER2'); 1");
  let hit = [];
  for (let i = 0; i < 30 && !hit.length; i++) { await sleep(500); hit = onDisk('JKMARKER2'); }   // localStorage пишется на диск с задержкой
  check('предусловие: значение действительно попало на диск до завершения сеанса', hit.length > 0, hit);

  tap('btn_menu'); await sleep(800); tapText('Завершить сеанс…'); await sleep(900);
  const yes = await waitNode((n) => n.id === 'android:id/button1');
  check('«Завершить сеанс…» просит подтверждение', !!yes);
  if (yes) tapNode(yes);
  await sleep(2500);
  forwardCdp();
  const leftMarker = onDisk('JKMARKER2');
  const leftOrigins = onDisk('localhost');
  check('после «Завершить сеанс» на диске нет ни значений, ни адресов посещённых сайтов',
    leftMarker.length === 0 && leftOrigins.length === 0, { значения: leftMarker, адреса: leftOrigins });
  log('каталоги WebView после завершения сеанса: ' + dirs().join(', ') + ' (пустой каталог старого профиля удалится при следующем запуске)');

  const t3 = await openPage('priv3');
  check('после «Завершить сеанс» cookie и localStorage удалены',
    (await cdp(t3, 'document.cookie')) === '' && (await cdp(t3, "localStorage.getItem('jk')")) === null);
});

await section('Выход из приложения и повторный запуск в том же процессе', async () => {
  const pidBefore = pid();
  const t1 = await openPage('exit1');
  await cdp(t1, "document.cookie='ex=1; path=/'; localStorage.setItem('ex','1'); 1");
  // выходим «назад» до конца: закрываются вкладки, затем приложение
  for (let i = 0; i < 14 && /ResumedActivity.*app\.joker\.browser/.test(adb('shell', 'dumpsys', 'activity', 'activities')); i++) {
    key('KEYCODE_BACK'); await sleep(700);
  }
  const resumed = /ResumedActivity.*app\.joker\.browser/.test(adb('shell', 'dumpsys', 'activity', 'activities'));
  check('кнопкой «назад» из приложения можно выйти', !resumed);
  await sleep(1500);
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await sleep(3500);
  const pidAfter = pid();
  log('процесс до выхода и после: ' + pidBefore + ' → ' + pidAfter);
  forwardCdp();
  const nt = await waitTarget((x) => /newtab\.html/.test(x.url), 20000, 'страница новой вкладки после повторного запуска');
  check('после выхода приложение запускается заново и показывает новую вкладку', !!nt);
  check('данные прошлого запуска не видны', onDiskNoMarker());
  const t2 = await openPage('exit2');
  check('после повторного запуска cookie и localStorage пусты, страницы работают',
    (await cdp(t2, 'document.cookie')) === '' && (await cdp(t2, "localStorage.getItem('ex')")) === null);

  function onDiskNoMarker() {
    try { return adb('shell', `run-as ${PKG} grep -rla "ex=1" app_webview`).trim() === ''; } catch { return true; }
  }
});

await section('Поворот экрана', async () => {
  const tr = await openPage('rotate');
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');   // альбомная
  await sleep(2500);
  screenshot('13-landscape');
  check('при повороте вкладка и страница сохраняются, панели на месте',
    (await targets()).some((x) => x.url === URL_A + 'rotate') && !!byId('btn_tabs') && !!byId('url_bar'));
  const dims = await cdp(tr, 'JSON.stringify({w: innerWidth, h: innerHeight})');
  const d = JSON.parse(dims);
  check('страница получила размеры альбомной ориентации (ширина больше высоты)', d.w > d.h, d);
  tap('btn_focus'); await sleep(700);
  check('кнопки режимов работают и в альбомной ориентации', (await probe(tr)).flags.focus === true);
  tap('btn_focus'); await sleep(500);
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  await sleep(2000);
  check('и после возврата в портретную', !!byId('btn_tabs') && (await probe(tr)).flags !== null);
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1');
});

await section('Тема и журнал', async () => {
  try {
    adb('shell', 'cmd', 'uimode', 'night', 'yes'); await sleep(2500);
    screenshot('11-dark');
    adb('shell', 'cmd', 'uimode', 'night', 'no'); await sleep(1500);
    check('смена темы на лету не роняет приложение и не теряет вкладки', pid() !== '' && !!byId('btn_tabs'));
  } catch (e) { log('смена темы: пропущено (' + e.message + ')'); }
  const crash = adb('logcat', '-d', '-b', 'crash');
  check('в журнале нет аварий (logcat -b crash)', !crash.includes(PKG), crash.slice(0, 400));
});

try { adb('reverse', '--remove-all'); adb('forward', '--remove-all'); adb('shell', 'svc', 'power', 'stayon', 'false'); } catch { /* */ }
for (const s of servers) s.close();
log(failed ? `\nИТОГ: провалено проверок: ${failed}` : '\nИТОГ: все проверки пройдены');
fs.writeFileSync(path.join(OUT, 'results.txt'), lines.join('\n'), 'utf8');
process.exit(failed ? 1 : 0);
