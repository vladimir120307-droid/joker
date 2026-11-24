// JOKER (Android) — связка между фреймами.
// WebView умеет выполнять evaluateJavascript только в главном фрейме, поэтому живое переключение режимов
// доходит до вложенных iframe (в том числе чужих доменов) через postMessage по цепочке родитель -> потомок.
// Подставляется ДО core.js: этот код видит событие wnd:s раньше, чем core.js его заглушит.
// __NONCE__ — случайная строка на вкладку; страница её не знает, поэтому подделать сообщение не может.
(() => {
  'use strict';
  const N = '__NONCE__';

  const relay = (detail) => {
    let n = 0;
    try { n = window.frames.length; } catch (_) {}
    for (let i = 0; i < n; i++) {
      try { window.frames[i].postMessage({ [N]: detail }, '*'); } catch (_) {}
    }
  };

  window.addEventListener('wnd:s', (e) => {
    if (e.detail) relay(e.detail);
  }, true);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || !(N in m)) return;
    e.stopImmediatePropagation();                       // страница сообщения не увидит
    if (window.parent === window || e.source !== window.parent) return;
    const d = m[N];
    if (!d || typeof d !== 'object') return;
    window.dispatchEvent(new CustomEvent('wnd:s', {
      detail: { focus: !!d.focus, fullscreen: !!d.fullscreen },
    }));
  }, true);
})();
