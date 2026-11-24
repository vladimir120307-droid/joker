// ФАЙЛ СОЗДАЁТСЯ АВТОМАТИЧЕСКИ — не правьте руками.
// Меняйте extension/core.js и запускайте: node tools/sync-core.js
// Выполняется в КАЖДОМ фрейме страницы (и в iframe) до скриптов сайта, в главном мире страницы.

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
// JOKER — выполняется в мире страницы (MAIN) во всех фреймах до скриптов сайта.
// Два независимых режима (флаги в общем состоянии S):
//   focus      — сайт не узнаёт о переключении окна/вкладки (visibility, blur/focus, mouseleave)
//   fullscreen — сайт видит, что окно в полноэкранном режиме (реально окно не меняется)
(() => {
  'use strict';
  const KEY = Symbol.for('wnd.s');
  const S = window[KEY] || Object.defineProperty(window, KEY, {
    value: { focus: false, fullscreen: false }, configurable: true,
  })[KEY];
  if (S.installed) return;
  S.installed = true;

  // ---------- «нативный» вид подменённых функций ----------
  const nativeToString = Function.prototype.toString;
  const fakeSrc = new WeakMap();
  const patchedToString = function toString() {
    const s = fakeSrc.get(this);
    return s !== undefined ? s : nativeToString.call(this);
  };
  fakeSrc.set(patchedToString, 'function toString() { [native code] }');
  Object.defineProperty(Function.prototype, 'toString', {
    value: patchedToString, writable: true, configurable: true,
  });
  const mark = (fn, name) => { fakeSrc.set(fn, `function ${name}() { [native code] }`); return fn; };

  // Подмена getter'а: fake() вернул undefined => отдаём настоящее значение
  function wrapGetter(holder, prop, fake) {
    const d = Object.getOwnPropertyDescriptor(holder, prop);
    if (!d || !d.get) return;
    const orig = d.get;
    const g = mark(function () {
      const v = fake.call(this);
      return v === undefined ? orig.call(this) : v;
    }, 'get ' + prop);
    Object.defineProperty(holder, prop, { ...d, get: g });
  }
  function wrapMethod(holder, prop, make) {
    const orig = holder[prop];
    if (typeof orig !== 'function') return;
    const fn = mark(make(orig), prop);
    Object.defineProperty(holder, prop, { value: fn, writable: true, configurable: true, enumerable: false });
  }

  // ---------- режим «скрыть переключение окон» ----------
  const F = () => S.focus;
  const docProto = Document.prototype;
  wrapGetter(docProto, 'hidden', () => (F() ? false : undefined));
  wrapGetter(docProto, 'visibilityState', () => (F() ? 'visible' : undefined));
  wrapGetter(docProto, 'webkitHidden', () => (F() ? false : undefined));
  wrapGetter(docProto, 'webkitVisibilityState', () => (F() ? 'visible' : undefined));
  wrapMethod(docProto, 'hasFocus', (orig) => function () { return F() ? true : orig.call(this); });

  const isRoot = (t) => t === window || t === document ||
    t === document.documentElement || t === document.body;
  const hideEvt = (e) => {
    if (!S.focus) return;
    switch (e.type) {
      case 'visibilitychange':
      case 'webkitvisibilitychange':
        e.stopImmediatePropagation(); break;
      case 'blur':
      case 'focus':
        // блокируем только blur/focus самого окна, не полей ввода
        if (e.target === window || e.target === document) e.stopImmediatePropagation();
        break;
      case 'mouseleave':
        if (isRoot(e.target)) e.stopImmediatePropagation();
        break;
      case 'mouseout':
        // курсор ушёл за пределы окна
        if (e.relatedTarget === null) e.stopImmediatePropagation();
        break;
    }
  };
  for (const t of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'focus', 'mouseleave', 'mouseout']) {
    window.addEventListener(t, hideEvt, true);
  }

  // ---------- режим «сообщать о полном экране» ----------
  let fsState = 'auto';   // auto — следует за флагом; entered — сайт запросил; exited — сайт вышел
  let fsElement = null;
  const FS = () => S.fullscreen && fsState !== 'exited';
  const root = () => fsElement || document.documentElement;

  const fire = () => {
    const target = fsElement || document.documentElement;
    try { target && target.dispatchEvent(new Event('fullscreenchange', { bubbles: true, composed: true })); } catch (_) {}
    try { document.dispatchEvent(new Event('fullscreenchange', { bubbles: true })); } catch (_) {}
    try { document.dispatchEvent(new Event('webkitfullscreenchange', { bubbles: true })); } catch (_) {}
  };

  wrapGetter(docProto, 'fullscreenElement', () => (FS() ? root() : undefined));
  wrapGetter(docProto, 'webkitFullscreenElement', () => (FS() ? root() : undefined));
  wrapGetter(docProto, 'webkitCurrentFullScreenElement', () => (FS() ? root() : undefined));
  wrapGetter(docProto, 'fullscreenEnabled', () => (S.fullscreen ? true : undefined));
  wrapGetter(docProto, 'webkitFullscreenEnabled', () => (S.fullscreen ? true : undefined));
  wrapGetter(docProto, 'webkitIsFullScreen', () => (FS() ? true : undefined));

  const fakeEnter = (orig) => function () {
    if (!S.fullscreen) return orig.apply(this, arguments);
    fsElement = this === document.documentElement ? null : this;
    fsState = 'entered';
    setTimeout(fire, 0);
    return Promise.resolve();
  };
  const fakeExit = (orig) => function () {
    if (!S.fullscreen) return orig.apply(this, arguments);
    const was = FS();
    fsState = 'exited';
    fsElement = null;
    if (was) setTimeout(fire, 0);
    return Promise.resolve();
  };
  for (const n of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
    wrapMethod(Element.prototype, n, fakeEnter);
  }
  for (const n of ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen']) {
    wrapMethod(docProto, n, fakeExit);
  }

  // Размеры окна = размеры экрана, пока «полный экран»
  const scr = () => window.screen;
  for (const [p, f] of Object.entries({
    innerWidth: () => scr().width, innerHeight: () => scr().height,
    outerWidth: () => scr().width, outerHeight: () => scr().height,
  })) {
    const d = Object.getOwnPropertyDescriptor(window, p);
    if (d && d.get) wrapGetter(window, p, () => (FS() ? f() : undefined));
  }
  const sp = Screen.prototype;
  wrapGetter(sp, 'availWidth', () => (FS() ? scr().width : undefined));
  wrapGetter(sp, 'availHeight', () => (FS() ? scr().height : undefined));
  wrapGetter(sp, 'availTop', () => (FS() ? 0 : undefined));
  wrapGetter(sp, 'availLeft', () => (FS() ? 0 : undefined));
  if (window.VisualViewport) {
    wrapGetter(VisualViewport.prototype, 'width', () => (FS() ? scr().width : undefined));
    wrapGetter(VisualViewport.prototype, 'height', () => (FS() ? scr().height : undefined));
  }

  // matchMedia('(display-mode: fullscreen)')
  wrapMethod(window, 'matchMedia', (orig) => function (q) {
    const r = orig.apply(this, arguments);
    if (FS()) {
      const s = String(q);
      let v;
      if (/display-mode\s*:\s*fullscreen/i.test(s)) v = true;
      else if (/display-mode\s*:\s*(browser|standalone|minimal-ui)/i.test(s)) v = false;
      if (v !== undefined) {
        Object.defineProperty(r, 'matches', {
          get: mark(function () { return v; }, 'get matches'), configurable: true,
        });
      }
    }
    return r;
  });

  // ---------- живое переключение из popup / горячих клавиш ----------
  window.addEventListener('wnd:s', (e) => {
    e.stopImmediatePropagation();
    const d = e.detail || {};
    const wasFS = FS();
    if ('focus' in d) S.focus = !!d.focus;
    if ('fullscreen' in d && !!d.fullscreen !== S.fullscreen) { S.fullscreen = !!d.fullscreen; fsState = 'auto'; fsElement = null; }
    if (wasFS !== FS()) setTimeout(fire, 0);
  }, true);
})();
