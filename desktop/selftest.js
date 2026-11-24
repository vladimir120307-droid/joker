'use strict';
// Автотест: npm run selftest   (результат — в консоли и в $SELFTEST_OUT/results.txt)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COUNTERS = `<script>
window.__n={vis:0,blur:0,focus:0,fs:0,ml:0};
document.addEventListener('visibilitychange',()=>__n.vis++);
window.addEventListener('blur',()=>__n.blur++);
window.addEventListener('focus',()=>__n.focus++);
document.addEventListener('fullscreenchange',()=>__n.fs++);
document.addEventListener('mouseleave',()=>__n.ml++);
</script>`;

const PROBE = `JSON.stringify({
  hidden: document.hidden, vs: document.visibilityState, hasFocus: document.hasFocus(),
  wkHidden: document.webkitHidden,
  fsEl: !!document.fullscreenElement, fsRoot: document.fullscreenElement === document.documentElement,
  fsEnabled: document.fullscreenEnabled,
  iw: innerWidth === screen.width, ih: innerHeight === screen.height,
  mm: matchMedia('(display-mode: fullscreen)').matches,
  n: window.__n,
  getterSrc: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get.toString(),
  reqSrc: Function.prototype.toString.call(Element.prototype.requestFullscreen),
})`;

module.exports = async function run(ctx) {
  const out = process.env.SELFTEST_OUT || app.getPath('temp');
  fs.mkdirSync(out, { recursive: true });
  const lines = [];
  let failed = 0;
  const log = (s) => { console.log(s); lines.push(s); };
  const check = (name, ok, extra) => {
    if (!ok) failed++;
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`);
  };

  const servers = [];
  const listen = (handler) => new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); });
  });
  let other = null;

  try {
    const pb = await listen((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset=utf-8><title>frame</title>${COUNTERS}<body>frame</body>`);
    });
    const pa = await listen((req, res) => {
      if (req.url === '/hdr') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(req.headers)); }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset=utf-8><title>test page</title>${COUNTERS}<body><h1>Тестовая страница</h1>
        <iframe src="http://localhost:${pb}/frame.html" width="300" height="80"></iframe></body>`);
    });

    const tab = ctx.createTab(`http://127.0.0.1:${pa}/`, true);
    const wc = tab.view.webContents;
    await new Promise((r) => wc.once('did-finish-load', r));
    await sleep(1200);

    const probe = async () => JSON.parse(await wc.executeJavaScript(PROBE));
    const frames = () => wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame);
    const frameProbe = async (f) => JSON.parse(await f.executeJavaScript(
      'JSON.stringify({hidden:document.hidden,vs:document.visibilityState,hasFocus:document.hasFocus()})'));
    const resetN = () => wc.executeJavaScript('Object.keys(__n).forEach(k=>__n[k]=0)');

    check('сессия приватная (в памяти)', ctx.ses.isPersistent() === false);
    const hdr = await wc.executeJavaScript("fetch('/hdr').then(r=>r.json())");
    check('заголовки DNT и Sec-GPC отправляются', hdr.dnt === '1' && hdr['sec-gpc'] === '1');
    check('User-Agent как у обычного Chrome: без «Electron» и без названия приложения',
      /^Mozilla\/5\.0 \([^)]+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/.test(hdr['user-agent']), hdr['user-agent']);
    const brands = await wc.executeJavaScript('JSON.stringify((navigator.userAgentData && navigator.userAgentData.brands) || [])');
    log('navigator.userAgentData.brands: ' + brands);
    check('в client hints (userAgentData.brands) нет «Electron» и названия приложения', !/Electron|JOKER/i.test(brands), brands);
    check('iframe на другом origin создан', frames().length === 1, frames().map((f) => f.url));

    // ---------- уход из окна тремя способами ----------
    const focusMain = async () => {
      ctx.win.show(); ctx.win.setAlwaysOnTop(true); ctx.win.focus(); wc.focus();
      await sleep(500); ctx.win.setAlwaysOnTop(false); await sleep(300);
    };
    const leave = async (kind) => {
      if (kind === 'other-window') { other = new BrowserWindow({ width: 220, height: 160, show: true }); other.focus(); await sleep(900); }
      else if (kind === 'hide') { ctx.win.hide(); await sleep(900); }
      else { ctx.win.minimize(); await sleep(1000); }
    };
    const comeBack = async (kind) => {
      if (other) { other.close(); other = null; }
      if (kind === 'hide') ctx.win.show(); else if (kind === 'minimize') ctx.win.restore();
      await sleep(700); await focusMain();
    };
    const KINDS = ['other-window', 'hide', 'minimize'];

    // 1) базовая линия: режимы ВЫКЛЮЧЕНЫ — что сайт видит в обычном Chrome-поведении
    const base = {};
    for (const kind of KINDS) {
      await focusMain(); await resetN();
      await leave(kind);
      const inside = await probe();
      await comeBack(kind);
      const after = await probe();
      base[kind] = { hidden: inside.hidden, vs: inside.vs, hasFocus: inside.hasFocus, n: after.n };
      log(`базовая линия [${kind}] (режимы выключены): ${JSON.stringify(base[kind])}`);
    }
    const realBlur = base['other-window'].n.blur >= 1 || base['other-window'].hasFocus === false;
    const realHidden = base.hide.hidden === true || base.minimize.hidden === true;
    log(`→ настоящая потеря фокуса воспроизведена: ${realBlur ? 'да' : 'НЕТ (проверка blur слабая)'}; настоящий hidden воспроизведён: ${realHidden ? 'да' : 'НЕТ'}`);

    // 2) режим «скрыть переключение» ВКЛЮЧЁН
    ctx.setFlag(tab, 'focus', true); await sleep(400);
    for (const kind of KINDS) {
      await focusMain(); await resetN();
      await leave(kind);
      const p = await probe();
      check(`focus [${kind}]: document.hidden === false, visibilityState === "visible"`, p.hidden === false && p.wkHidden === false && p.vs === 'visible', { hidden: p.hidden, vs: p.vs });
      check(`focus [${kind}]: document.hasFocus() === true`, p.hasFocus === true);
      for (const f of frames()) {
        const fp = await frameProbe(f);
        check(`focus [${kind}]: то же внутри iframe другого origin`, fp.hidden === false && fp.vs === 'visible' && fp.hasFocus === true, fp);
      }
      await comeBack(kind);
      const q = await probe();
      check(`focus [${kind}]: сайт не получил visibilitychange/blur/focus`, q.n.vis === 0 && q.n.blur === 0 && q.n.focus === 0, q.n);
    }

    // синтетические события
    const synth = `(()=>{const b=JSON.parse(JSON.stringify(__n));
      window.dispatchEvent(new Event('blur'));document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));document.dispatchEvent(new MouseEvent('mouseleave'));
      const a=__n;return JSON.stringify({vis:a.vis-b.vis,blur:a.blur-b.blur,focus:a.focus-b.focus,ml:a.ml-b.ml});})()`;
    let d = JSON.parse(await wc.executeJavaScript(synth));
    check('focus: события blur/focus/visibilitychange/mouseleave глушатся', d.vis === 0 && d.blur === 0 && d.focus === 0 && d.ml === 0, d);

    const inputBlur = await wc.executeJavaScript(`(()=>{const i=document.createElement('input');document.body.appendChild(i);
      let got=0;i.addEventListener('blur',()=>got++);i.dispatchEvent(new FocusEvent('blur'));return got;})()`);
    check('focus: blur у обычного поля ввода НЕ блокируется', inputBlur === 1, inputBlur);

    ctx.setFlag(tab, 'focus', false); await sleep(300);
    d = JSON.parse(await wc.executeJavaScript(synth));
    check('focus выключен: события снова доходят до сайта', d.vis === 1 && d.blur === 1 && d.focus === 1 && d.ml === 1, d);

    // ---------- режим «полный экран» ----------
    let p = await probe();
    check('fullscreen выключен: fullscreenElement пуст', p.fsEl === false && p.mm === false);
    await resetN();
    ctx.setFlag(tab, 'fullscreen', true); await sleep(500);
    p = await probe();
    check('fullscreen: document.fullscreenElement = <html>', p.fsEl && p.fsRoot);
    check('fullscreen: fullscreenEnabled = true', p.fsEnabled === true);
    check('fullscreen: innerWidth/innerHeight = размер экрана', p.iw && p.ih);
    check('fullscreen: (display-mode: fullscreen) совпадает', p.mm === true);
    check('fullscreen: сайт получил fullscreenchange при включении', p.n.fs >= 1, p.n);

    const res = await wc.executeJavaScript("document.body.requestFullscreen().then(()=> 'resolved', (e)=> 'rejected:' + e)");
    await sleep(300);
    check('fullscreen: requestFullscreen() успешно завершается', res === 'resolved', res);
    check('fullscreen: окно браузера при этом НЕ меняется', ctx.win.isFullScreen() === false);
    check('fullscreen: fullscreenElement = запрошенный элемент', (await wc.executeJavaScript('document.fullscreenElement === document.body')) === true);
    const res2 = await wc.executeJavaScript("document.exitFullscreen().then(()=> 'resolved', (e)=> 'rejected:' + e)");
    await sleep(300);
    p = await probe();
    check('fullscreen: exitFullscreen() отрабатывает как у настоящего', res2 === 'resolved' && p.fsEl === false, { res2, fsEl: p.fsEl });

    ctx.setFlag(tab, 'fullscreen', false); await sleep(200);
    ctx.setFlag(tab, 'fullscreen', true); await sleep(400);
    p = await probe();
    check('fullscreen: повторное включение снова даёт "полный экран"', p.fsEl && p.iw && p.ih);
    check('маскировка: геттер выглядит нативным', /\[native code\]/.test(p.getterSrc), p.getterSrc);
    check('маскировка: requestFullscreen выглядит нативным', /\[native code\]/.test(p.reqSrc), p.reqSrc);

    ctx.setFlag(tab, 'fullscreen', false); await sleep(400);
    p = await probe();
    check('fullscreen выключен: всё возвращается к реальным значениям', !p.fsEl && !p.iw && !p.mm, { fsEl: p.fsEl, iw: p.iw, mm: p.mm });

    // ---------- скриншоты интерфейса ----------
    ctx.setFlag(tab, 'fullscreen', true);
    ctx.setFlag(tab, 'focus', true);
    ctx.createTab('about:blank', false);
    await sleep(700);
    try {
      fs.writeFileSync(path.join(out, 'ui.png'), (await ctx.win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(out, 'page.png'), (await wc.capturePage()).toPNG());
      log('скриншоты сохранены в ' + out);
    } catch (e) { log('скриншот не удался: ' + e.message); }
  } catch (e) {
    failed++;
    log('ОШИБКА ТЕСТА: ' + (e && e.stack || e));
  }

  if (other && !other.isDestroyed()) other.close();
  for (const s of servers) s.close();
  log(failed ? `\nИТОГ: провалено проверок: ${failed}` : '\nИТОГ: все проверки пройдены');
  fs.writeFileSync(path.join(out, 'results.txt'), lines.join('\n'), 'utf8');
  app.exit(failed ? 1 : 0);
};
