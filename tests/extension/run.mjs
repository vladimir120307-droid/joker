// Проверка расширения в настоящем Chromium (Playwright).
//   cd tests/extension && npm install && npm run install-browser && npm test
// Загружает extension/ как распакованное расширение и проверяет: подмену, живое включение, включение с первого
// скрипта после перезагрузки, сохранение настроек после перезапуска браузера и popup. Окно браузера мигнёт на экране.
import { chromium } from 'playwright-core';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';

const EXT = process.env.EXT_DIR || path.resolve(import.meta.dirname, "..", "..", "extension");
const OUT = process.env.OUT_DIR || path.join(import.meta.dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jk-profile-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, extra) => { if (!ok) failed++; log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); };

const COUNTERS = `<script>
window.__early = (()=>{const s=window[Symbol.for('wnd.s')];return s?{focus:!!s.focus,fullscreen:!!s.fullscreen}:null})();
window.__n={vis:0,blur:0,focus:0,fs:0,ml:0};
document.addEventListener('visibilitychange',()=>__n.vis++);
window.addEventListener('blur',()=>__n.blur++);
window.addEventListener('focus',()=>__n.focus++);
document.addEventListener('fullscreenchange',()=>__n.fs++);
document.addEventListener('mouseleave',()=>__n.ml++);
</script>`;

const servers = [];
const listen = (host, handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, host, () => { servers.push(s); res(s.address().port); }); });
const pb = await listen('127.0.0.1', (rq, rs) => { rs.setHeader('content-type', 'text/html; charset=utf-8'); rs.end(`<!doctype html><meta charset=utf-8><head>${COUNTERS}</head><body>frame</body>`); });
const pa = await listen('127.0.0.1', (rq, rs) => {
  rs.setHeader('content-type', 'text/html; charset=utf-8');
  rs.end(`<!doctype html><meta charset=utf-8><head><title>test</title>${COUNTERS}</head><body><h1>Тест</h1><iframe src="http://localhost:${pb}/f" width=300 height=80></iframe></body>`);
});
const URL_A = `http://127.0.0.1:${pa}/`;

const launch = () => chromium.launchPersistentContext(profile, {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const getSW = async (ctx) => { let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }); return sw; };
const STATE = () => { const s = window[Symbol.for('wnd.s')]; return s ? { focus: !!s.focus, fullscreen: !!s.fullscreen } : null; };
const setMode = (sw, msg) => sw.evaluate((m) => handleMessage(m), { type: 'set', ...msg });
const tabIdOf = (sw, pattern) => sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0].id, pattern);

let ctx = await launch();
try {
  const sw = await getSW(ctx);
  const extId = new URL(sw.url()).host;
  log('расширение загружено, id=' + extId);

  const page = await ctx.newPage();
  await page.goto(URL_A); await sleep(800);
  const frame = () => page.frames().find((f) => f !== page.mainFrame());

  // ---------- 0. режимы выключены: всё как в обычном Chrome ----------
  let st = await page.evaluate(STATE);
  check('core.js внедрён в страницу (MAIN world)', st !== null && st.focus === false && st.fullscreen === false, st);
  const synth = `(()=>{const b={...__n};window.dispatchEvent(new Event('blur'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));
    const a=__n;return {vis:a.vis-b.vis,blur:a.blur-b.blur,focus:a.focus-b.focus};})()`;
  let d = await page.evaluate(synth);
  check('режимы выключены: события доходят до сайта', d.vis === 1 && d.blur === 1 && d.focus === 1, d);
  check('режимы выключены: fullscreenElement пуст', (await page.evaluate('!document.fullscreenElement && !matchMedia("(display-mode: fullscreen)").matches')) === true);
  check('нет заметных следов: toString нативный', (await page.evaluate('Object.getOwnPropertyDescriptor(Document.prototype,"hidden").get.toString()')) === 'function get hidden() { [native code] }');

  const tabId = await tabIdOf(sw, URL_A);
  const host = '127.0.0.1';

  // ---------- 1. живое включение «скрыть переключение» ----------
  let r = await setMode(sw, { feature: 'focus', mode: 'site', host, tabId });
  check('focus: режим сохранён как "site"', r.modes && r.modes.focus === 'site', r);
  st = await page.evaluate(STATE);
  check('focus: включился сразу, без перезагрузки', st && st.focus === true, st);
  const fst = await frame().evaluate(STATE);
  check('focus: включился и в iframe другого origin (живое применение, allFrames)', fst && fst.focus === true, fst);
  d = await page.evaluate(synth);
  check('focus: события blur/focus/visibilitychange глушатся', d.vis === 0 && d.blur === 0 && d.focus === 0, d);
  check('focus: document.hidden=false, hasFocus=true', (await page.evaluate('!document.hidden && document.hasFocus() && document.visibilityState==="visible"')) === true);

  // реальное переключение вкладок
  await page.evaluate('Object.keys(__n).forEach(k=>__n[k]=0)');
  const other = await ctx.newPage(); await other.goto('about:blank'); await other.bringToFront(); await sleep(700);
  const real = await page.evaluate('({hidden: document.hidden, vs: document.visibilityState, n: __n})');
  log('после реального переключения на другую вкладку: ' + JSON.stringify(real));
  check('focus: при реальном переключении вкладки сайт видит visible и не получает событий', real.hidden === false && real.vs === 'visible' && real.n.vis === 0, real);
  await page.bringToFront(); await other.close();

  // ---------- 2. включение с самого начала загрузки (после reload) ----------
  await page.reload(); await sleep(900);
  const early = await page.evaluate('window.__early');
  check('focus: после перезагрузки флаг уже стоит ДО скриптов сайта (registerContentScripts)', early && early.focus === true, early);
  const fst2 = await frame().evaluate(STATE);
  check('focus (режим "этот сайт"): iframe на ДРУГОМ домене не покрыт — известное ограничение', fst2 && fst2.focus === false, fst2);

  // ---------- 3. «все сайты» покрывает и iframe ----------
  await setMode(sw, { feature: 'focus', mode: 'all', host, tabId });
  await page.reload(); await sleep(900);
  const fst3 = await frame().evaluate(STATE);
  check('focus (режим "все сайты"): iframe другого домена тоже защищён с самого начала', fst3 && fst3.focus === true, fst3);

  // ---------- 4. «полный экран» ----------
  await setMode(sw, { feature: 'focus', mode: 'off', host, tabId });
  await setMode(sw, { feature: 'fullscreen', mode: 'site', host, tabId });
  await sleep(300);
  const PROBE = `({fsEl: !!document.fullscreenElement, root: document.fullscreenElement===document.documentElement, en: document.fullscreenEnabled,
    iw: innerWidth===screen.width, ih: innerHeight===screen.height, mm: matchMedia('(display-mode: fullscreen)').matches, n: __n})`;
  let p = await page.evaluate(PROBE);
  check('fullscreen: fullscreenElement=<html>, innerWidth/Height=экран, display-mode: fullscreen', p.fsEl && p.root && p.en && p.iw && p.ih && p.mm, p);
  check('fullscreen: сайт получил fullscreenchange', p.n.fs >= 1, p.n);
  const rq = await page.evaluate("document.body.requestFullscreen().then(()=>'resolved',e=>'rejected:'+e)");
  const fsIsBody = await page.evaluate('document.fullscreenElement===document.body');
  check('fullscreen: requestFullscreen() без жеста пользователя успешно завершается', rq === 'resolved' && fsIsBody, { rq, fsIsBody });
  const ex = await page.evaluate("document.exitFullscreen().then(()=>'resolved',e=>'rejected:'+e)");
  await sleep(200);
  check('fullscreen: exitFullscreen() отрабатывает', ex === 'resolved' && (await page.evaluate('!document.fullscreenElement')) === true, ex);
  await page.reload(); await sleep(900);
  const early2 = await page.evaluate('window.__early');
  check('fullscreen: после перезагрузки включён с самого начала', early2 && early2.fullscreen === true && early2.focus === false, early2);

  // ---------- 5. popup ----------
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 360, height: 300 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`); await sleep(600);
  check('popup: показывает текущий режим из настроек', (await popup.inputValue('#fullscreen')) === 'site' && (await popup.inputValue('#focus')) === 'off');
  check('popup: показывает домен', (await popup.textContent('#host')) === host);
  await popup.selectOption('#focus', 'site'); await sleep(600);
  st = await page.evaluate(STATE);
  check('popup: переключатель сразу меняет вкладку', st && st.focus === true && st.fullscreen === true, st);
  await popup.screenshot({ path: path.join(OUT, 'popup.png') });
  await popup.close();

  // ---------- 6. сохранение после перезапуска браузера ----------
  await ctx.close();
  ctx = await launch();
  const sw2 = await getSW(ctx);
  let regs = [];
  for (let i = 0; i < 10 && regs.length < 2; i++) {
    regs = await sw2.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((x) => x.id).sort());
    if (regs.length < 2) await sleep(300);
  }
  check('после перезапуска браузера скрипты режимов остались зарегистрированы', regs.join() === 'jk-focus,jk-fullscreen', regs);
  const page2 = await ctx.newPage(); await page2.goto(URL_A); await sleep(900);
  const early3 = await page2.evaluate('window.__early');
  check('после перезапуска: режимы включаются сами, до скриптов сайта', early3 && early3.focus && early3.fullscreen, early3);

  // на другом сайте всё выключено
  const pc = await listen('127.0.0.1', (rq2, rs) => { rs.setHeader('content-type', 'text/html'); rs.end(`<!doctype html><head>${COUNTERS}</head><body>other</body>`); });
  const page3 = await ctx.newPage(); await page3.goto(`http://localhost:${pc}/`); await sleep(700);
  const early4 = await page3.evaluate('window.__early');
  check('на другом сайте (localhost) режимы остаются выключенными', early4 && !early4.focus && !early4.fullscreen, early4);
} catch (e) {
  failed++; log('ОШИБКА ТЕСТА: ' + (e && e.stack || e));
}
await ctx.close().catch(() => {});
for (const s of servers) s.close();
log(failed ? `\nИТОГ: провалено проверок: ${failed}` : '\nИТОГ: все проверки пройдены');
fs.writeFileSync(path.join(OUT, 'ext-results.txt'), lines.join('\n'), 'utf8');
process.exit(failed ? 1 : 0);
