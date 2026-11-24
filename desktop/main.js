'use strict';
const {
  app, BrowserWindow, WebContentsView, Menu, ipcMain, dialog, session, shell, clipboard, nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const SELFTEST = process.argv.includes('--selftest');

// ---------- настройки ----------
const SEARCH_URL = 'https://www.google.com/search?q=';
const NEWTAB_URL = pathToFileURL(path.join(__dirname, 'ui', 'newtab.html')).href;
const PAGE_PRELOAD = path.join(__dirname, 'preload-page.js');
const UI_PRELOAD = path.join(__dirname, 'preload-ui.js');
const STRIP_H = 40;          // полоса вкладок
const TOOLBAR_H = 42;        // панель адреса
const FIND_H = 38;           // строка поиска по странице
const TOP_BASE = STRIP_H + TOOLBAR_H;

// Не даём Chromium «усыплять» окно, когда оно свёрнуто/перекрыто/в фоне
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Приватность: все служебные данные приложения — во временной папке, удаляются при выходе
const userDataDir = path.join(app.getPath('temp'), 'joker-' + process.pid);
app.setPath('userData', userDataDir);

let win = null;
let ses = null;
const tabs = [];
let activeId = null;
let tabSeq = 0;
const closedStack = [];
const flagMap = new Map();     // webContents.id -> flags (общий объект вкладки)
let pendingPopupFlags = null;
let findOpen = false;
let findState = { active: 0, total: 0 };
let htmlFs = false;
let fsFromHtml = false;

const activeTab = () => tabs.find((t) => t.id === activeId) || null;
const tabById = (id) => tabs.find((t) => t.id === id) || null;

// ---------- вспомогательное ----------
function toUrl(text) {
  text = String(text || '').trim();
  if (!text) return NEWTAB_URL;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(about:blank|file:\/\/|view-source:https?:\/\/)/i.test(text)) return text;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(text)) return 'http://' + text;
  if (/^[^\s/?#]+\.[^\s/?#.]{2,}(:\d+)?([/?#]\S*)?$/.test(text)) return 'https://' + text;
  return SEARCH_URL + encodeURIComponent(text);
}

function errorPage(url, code, desc) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const retry = /^https?:/i.test(url) ? `<a class=b href="${esc(url)}">Повторить</a>` : '';
  const html = `<!doctype html><meta charset=utf-8><title>Не удалось открыть страницу</title>
<style>
:root{color-scheme:light dark}
body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}
main{max-width:560px;padding:24px}
h1{font-size:24px;font-weight:500;margin:0 0 12px}
p{color:GrayText;margin:6px 0;word-break:break-all}
.b{display:inline-block;margin-top:16px;padding:8px 18px;border-radius:18px;background:#1a73e8;color:#fff;text-decoration:none}
</style><main><h1>Не удаётся получить доступ к сайту</h1><p>${esc(url)}</p><p>${esc(desc)} (${esc(code)})</p>${retry}</main>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function pagePrefs(withSession = true) {
  const p = {
    preload: PAGE_PRELOAD,
    contextIsolation: false,          // preload должен менять объекты в мире страницы
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: true, // preload выполняется и в iframe
    backgroundThrottling: false,
    spellcheck: true,
  };
  if (withSession) p.session = ses;
  return p;
}

// ---------- состояние для интерфейса ----------
let pushTimer = null;
function push() {
  if (pushTimer || !win || win.isDestroyed()) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!win || win.isDestroyed()) return;
    const s = snapshot();
    win.webContents.send('state', s);
    const t = s.tabs.find((x) => x.id === s.activeId);
    win.setTitle((t ? t.title + ' — ' : '') + 'JOKER');
  }, 16);
}

function snapshot() {
  const cur = activeTab();
  let active = null;
  if (cur) {
    const wc = cur.view.webContents;
    const url = cur.errorFor || (cur.url === NEWTAB_URL ? '' : cur.url);
    active = {
      url,
      https: /^https:/i.test(url),
      http: /^http:/i.test(url),
      canBack: wc.navigationHistory.canGoBack(),
      canForward: wc.navigationHistory.canGoForward(),
      loading: cur.loading,
      flags: { ...cur.flags },
    };
  }
  return {
    activeId,
    active,
    find: { open: findOpen, ...findState },
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.url === NEWTAB_URL ? 'Новая вкладка' : (t.title || t.url || 'Загрузка…'),
      favicon: t.favicon,
      loading: t.loading,
      fs: t.flags.fullscreen,
      focus: t.flags.focus,
    })),
  };
}

// ---------- раскладка ----------
function topOffset() { return htmlFs ? 0 : TOP_BASE + (findOpen ? FIND_H : 0); }
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const top = topOffset();
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
  }
}

// ---------- режимы вкладки ----------
function broadcastFlags(tab) {
  for (const wc of tab.wcs) {
    if (wc.isDestroyed()) continue;
    for (const f of wc.mainFrame.framesInSubtree) {
      try { f.send('flags:set', { ...tab.flags }); } catch (_) {}
    }
  }
}
function setFlag(tab, name, value) {
  if (!tab || !(name in tab.flags)) return;
  tab.flags[name] = !!value;
  broadcastFlags(tab);
  push();
}
function toggleFlag(tab, name) { if (tab) setFlag(tab, name, !tab.flags[name]); }

ipcMain.on('flags:get', (e) => {
  let f = flagMap.get(e.sender.id);
  if (!f) {
    f = pendingPopupFlags || { fullscreen: false, focus: false };
    flagMap.set(e.sender.id, f);
  }
  e.returnValue = { ...f };
});

// ---------- вкладки ----------
function createTab(url, activate = true) {
  const tab = {
    id: ++tabSeq,
    flags: { fullscreen: false, focus: false },
    title: '', favicon: '', loading: false, url: '', errorFor: null,
    wcs: new Set(),
  };
  const view = new WebContentsView({ webPreferences: pagePrefs() });
  tab.view = view;
  const wc = view.webContents;
  tab.wcs.add(wc);
  flagMap.set(wc.id, tab.flags);
  wc.setWebRTCIPHandlingPolicy('default_public_interface_only'); // не светим локальный IP

  win.contentView.addChildView(view);
  view.setVisible(false);
  tabs.push(tab);
  layout();
  wireTab(tab);
  if (activate) activateTab(tab.id);
  wc.loadURL(url || NEWTAB_URL).catch(() => {});
  push();
  return tab;
}

function wireTab(tab) {
  const wc = tab.view.webContents;

  wc.on('page-title-updated', (_e, title) => { tab.title = title; push(); });
  wc.on('page-favicon-updated', (_e, favs) => { tab.favicon = favs[0] || ''; push(); });
  wc.on('did-start-loading', () => { tab.loading = true; push(); });
  wc.on('did-stop-loading', () => { tab.loading = false; push(); });
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) { tab.favicon = ''; }
  });
  wc.on('did-navigate', (_e, url) => {
    if (!url.startsWith('data:text/html')) tab.errorFor = null;
    tab.url = url;
    push();
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) { tab.url = url; push(); }
  });
  wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    tab.errorFor = validatedURL;
    wc.loadURL(errorPage(validatedURL, code, desc)).catch(() => {});
  });
  wc.on('found-in-page', (_e, r) => { findState = { active: r.activeMatchOrdinal, total: r.matches }; push(); });

  wc.on('will-navigate', (e, url) => {
    if (!/^(https?:|file:|about:|blob:|view-source:)/i.test(url)) e.preventDefault();
  });

  wc.setWindowOpenHandler(({ url, disposition, features }) => {
    if (/^(mailto|tel):/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    if (!/^(https?:|about:blank)/i.test(url)) return { action: 'deny' };
    if (disposition === 'new-window' && features) {
      // настоящее всплывающее окно (OAuth, оплата) — сохраняем window.opener
      pendingPopupFlags = tab.flags;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: pagePrefs(false) },
      };
    }
    createTab(url, disposition !== 'background-tab');
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => {
    const cwc = child.webContents;
    const id = cwc.id;
    flagMap.set(id, tab.flags);
    tab.wcs.add(cwc);
    pendingPopupFlags = null;
    cwc.setWebRTCIPHandlingPolicy('default_public_interface_only');
    child.on('closed', () => { flagMap.delete(id); tab.wcs.delete(cwc); });
  });

  // настоящий HTML-fullscreen (видео, игры), когда режим «полный экран» выключен
  wc.on('enter-html-full-screen', () => {
    htmlFs = true;
    if (!win.isFullScreen()) { fsFromHtml = true; win.setFullScreen(true); }
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFs = false;
    if (fsFromHtml) { fsFromHtml = false; win.setFullScreen(false); }
    layout();
  });

  wc.on('before-input-event', (e, input) => handleShortcut(e, input));

  wc.on('context-menu', (_e, p) => {
    const items = [];
    const sep = { type: 'separator' };
    if (p.linkURL) {
      items.push(
        { label: 'Открыть ссылку в новой вкладке', click: () => createTab(p.linkURL, true) },
        { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(p.linkURL) }, sep,
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Открыть картинку в новой вкладке', click: () => createTab(p.srcURL, true) },
        { label: 'Копировать адрес картинки', click: () => clipboard.writeText(p.srcURL) }, sep,
      );
    }
    if (p.isEditable) {
      items.push(
        { role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, sep,
        { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' },
      );
    } else if (p.selectionText) {
      const short = p.selectionText.trim().slice(0, 30);
      items.push(
        { role: 'copy', label: 'Копировать' },
        { label: `Найти «${short}» в Google`, click: () => createTab(SEARCH_URL + encodeURIComponent(p.selectionText.trim()), true) },
      );
    } else {
      items.push(
        { label: 'Назад', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Вперёд', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Обновить', click: () => reloadTab(tab, false) },
      );
    }
    items.push(sep, { label: 'Просмотреть код', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function activateTab(id) {
  const tab = tabById(id);
  if (!tab) return;
  if (findOpen && activeId !== id) closeFind(false);
  activeId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  layout();
  tab.view.webContents.focus();
  push();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tab = tabs[i];
  const url = tab.errorFor || tab.url;
  if (url && url !== NEWTAB_URL && !url.startsWith('data:')) { closedStack.push(url); if (closedStack.length > 15) closedStack.shift(); }
  tabs.splice(i, 1);
  for (const wc of tab.wcs) flagMap.delete(wc.id);
  try { win.contentView.removeChildView(tab.view); } catch (_) {}
  try { tab.view.webContents.close(); } catch (_) {}
  if (!tabs.length) { win.close(); return; }
  if (activeId === id) activateTab(tabs[Math.min(i, tabs.length - 1)].id);
  else push();
}

function cycleTab(dir) {
  const i = tabs.findIndex((t) => t.id === activeId);
  activateTab(tabs[(i + dir + tabs.length) % tabs.length].id);
}
function reopenClosed() { const u = closedStack.pop(); if (u) createTab(u, true); }
function newTabAndFocus() { createTab(NEWTAB_URL, true); focusAddress(); }

function focusAddress() {
  if (!win || win.isDestroyed()) return;
  win.webContents.focus();
  win.webContents.send('ui:focus-address');
}
function reloadTab(tab, hard) {
  if (!tab) return;
  const wc = tab.view.webContents;
  if (tab.errorFor && /^https?:/i.test(tab.errorFor)) { const u = tab.errorFor; tab.errorFor = null; wc.loadURL(u).catch(() => {}); return; }
  hard ? wc.reloadIgnoringCache() : wc.reload();
}
function zoomTab(tab, delta) {
  if (!tab) return;
  const wc = tab.view.webContents;
  wc.setZoomLevel(delta === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta)));
}

// ---------- поиск по странице ----------
function openFind() {
  findOpen = true; findState = { active: 0, total: 0 };
  layout(); push();
  win.webContents.focus();
  win.webContents.send('ui:focus-find');
}
function closeFind(refocus = true) {
  if (!findOpen) return;
  findOpen = false;
  const t = activeTab();
  if (t) { try { t.view.webContents.stopFindInPage('clearSelection'); } catch (_) {} }
  layout(); push();
  if (refocus && t) t.view.webContents.focus();
}

// ---------- горячие клавиши (по физическим клавишам — работают и в русской раскладке) ----------
function handleShortcut(e, input) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const { shift, alt, code } = input;
  const tab = activeTab();
  const run = (fn) => { e.preventDefault(); fn(); };

  if (code === 'F5') return run(() => reloadTab(tab, ctrl));
  if (code === 'F6') return run(focusAddress);
  if (code === 'F11') return run(() => win.setFullScreen(!win.isFullScreen()));
  if (code === 'F12') return run(() => tab && tab.view.webContents.toggleDevTools());
  if (code === 'Escape' && findOpen) { closeFind(); return; }

  if (alt && !ctrl) {
    if (code === 'ArrowLeft') return run(() => tab && tab.view.webContents.navigationHistory.goBack());
    if (code === 'ArrowRight') return run(() => tab && tab.view.webContents.navigationHistory.goForward());
    if (code === 'KeyD') return run(focusAddress);
    return;
  }
  if (!ctrl || alt) return;

  switch (code) {
    case 'KeyT': return run(shift ? reopenClosed : newTabAndFocus);
    case 'KeyW': case 'F4': return run(() => closeTab(activeId));
    case 'Tab': return run(() => cycleTab(shift ? -1 : 1));
    case 'PageDown': return run(() => cycleTab(1));
    case 'PageUp': return run(() => cycleTab(-1));
    case 'KeyL': return run(focusAddress);
    case 'KeyR': return run(() => reloadTab(tab, shift));
    case 'KeyF': return run(() => (shift ? toggleFlag(tab, 'fullscreen') : openFind()));
    case 'KeyH': if (shift) return run(() => toggleFlag(tab, 'focus')); return;
    case 'KeyI': if (shift) return run(() => tab && tab.view.webContents.toggleDevTools()); return;
    case 'Equal': case 'NumpadAdd': return run(() => zoomTab(tab, 0.5));
    case 'Minus': case 'NumpadSubtract': return run(() => zoomTab(tab, -0.5));
    case 'Digit0': case 'Numpad0': return run(() => zoomTab(tab, 0));
    default:
      if (/^Digit[1-9]$/.test(code)) {
        const n = Number(code.slice(5));
        return run(() => { const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1]; if (t) activateTab(t.id); });
      }
  }
}

// ---------- права сайтов ----------
const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
const PERM_TEXT = {
  media: 'использовать камеру и/или микрофон', geolocation: 'узнать ваше местоположение',
  notifications: 'показывать уведомления', 'clipboard-read': 'читать буфер обмена',
  midi: 'использовать MIDI-устройства', 'display-capture': 'записывать экран',
};
const permAnswers = new Map();
const permPending = new Map();

function setupPermissions() {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    let origin = 'null';
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch (_) {}
    const key = `${origin}|${permission}|${(details.mediaTypes || []).join(',')}`;
    if (permAnswers.has(key)) return callback(permAnswers.get(key));
    let p = permPending.get(key);
    if (!p) {
      p = dialog.showMessageBox(win, {
        type: 'question', buttons: ['Разрешить', 'Блокировать'], defaultId: 1, cancelId: 1,
        title: 'Запрос разрешения',
        message: `${origin === 'null' ? 'Страница' : origin} хочет ${PERM_TEXT[permission] || permission}`,
        detail: 'Ответ действует до закрытия браузера.',
      }).then((r) => { const ok = r.response === 0; permAnswers.set(key, ok); permPending.delete(key); return ok; });
      permPending.set(key, p);
    }
    p.then(callback);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    for (const [k, v] of permAnswers) if (v && k.startsWith(`${origin}|${permission}|`)) return true;
    return false;
  });
}

// ---------- приватная сессия ----------
function setupSession() {
  // Имя без префикса "persist:" => сессия только в памяти: куки, кэш, localStorage не пишутся на диск
  ses = session.fromPartition('private-' + crypto.randomUUID());
  // Для сайтов это должен быть обычный Chrome: убираем «Electron/…» и название приложения («JOKER/1.0.0» перед «Chrome/…»)
  const ua = ses.getUserAgent()
    .replace(/\sElectron\/\S+/, '')
    .replace(/\s[\w.-]+\/[\d.]+(?=\sChrome\/)/, '');
  ses.setUserAgent(ua);
  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    details.requestHeaders['DNT'] = '1';
    details.requestHeaders['Sec-GPC'] = '1';
    cb({ requestHeaders: details.requestHeaders });
  });
  setupPermissions();
}

function clearSession() {
  ses.clearStorageData().catch(() => {});
  ses.clearCache().catch(() => {});
  ses.clearAuthCache().catch(() => {});
  permAnswers.clear();
}

// ---------- окно ----------
const themeColors = () => (nativeTheme.shouldUseDarkColors
  ? { color: '#202124', symbolColor: '#e8eaed' } : { color: '#dee1e6', symbolColor: '#3c4043' });

function createWindow() {
  const tc = themeColors();
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 480, minHeight: 320,
    show: false, title: 'JOKER', backgroundColor: tc.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...tc, height: STRIP_H },
    webPreferences: { preload: UI_PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => handleShortcut(e, input));
  win.once('ready-to-show', () => win.show());
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) win.on(ev, layout);
  win.on('app-command', (_e, cmd) => {
    const t = activeTab(); if (!t) return;
    if (cmd === 'browser-backward') t.view.webContents.navigationHistory.goBack();
    if (cmd === 'browser-forward') t.view.webContents.navigationHistory.goForward();
  });
  win.on('closed', () => { win = null; });
  nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setTitleBarOverlay({ ...themeColors(), height: STRIP_H }); });
  return win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

function openMenu(x, y) {
  const tab = activeTab(); if (!tab) return;
  const na = { registerAccelerator: false };
  Menu.buildFromTemplate([
    { label: 'Новая вкладка', accelerator: 'Ctrl+T', ...na, click: newTabAndFocus },
    { label: 'Открыть закрытую вкладку', accelerator: 'Ctrl+Shift+T', ...na, enabled: closedStack.length > 0, click: reopenClosed },
    { type: 'separator' },
    { label: 'Сообщать сайту о полном экране', type: 'checkbox', checked: tab.flags.fullscreen, accelerator: 'Ctrl+Shift+F', ...na, click: () => toggleFlag(tab, 'fullscreen') },
    { label: 'Скрывать переключение окон', type: 'checkbox', checked: tab.flags.focus, accelerator: 'Ctrl+Shift+H', ...na, click: () => toggleFlag(tab, 'focus') },
    { type: 'separator' },
    { label: 'Найти на странице…', accelerator: 'Ctrl+F', ...na, click: openFind },
    {
      label: 'Масштаб',
      submenu: [
        { label: 'Увеличить', accelerator: 'Ctrl+=', ...na, click: () => zoomTab(tab, 0.5) },
        { label: 'Уменьшить', accelerator: 'Ctrl+-', ...na, click: () => zoomTab(tab, -0.5) },
        { label: 'Сбросить', accelerator: 'Ctrl+0', ...na, click: () => zoomTab(tab, 0) },
      ],
    },
    { label: 'Во весь экран', accelerator: 'F11', ...na, click: () => win.setFullScreen(!win.isFullScreen()) },
    { label: 'Инструменты разработчика', accelerator: 'F12', ...na, click: () => tab.view.webContents.toggleDevTools() },
    { type: 'separator' },
    { label: 'Очистить данные сессии', click: clearSession },
    { label: 'Выход', click: () => app.quit() },
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

function tabMenu(id) {
  const tab = tabById(id); if (!tab) return;
  Menu.buildFromTemplate([
    { label: 'Обновить', click: () => reloadTab(tab, false) },
    { label: 'Дублировать', click: () => createTab(tab.errorFor || tab.url, true) },
    { type: 'separator' },
    { label: 'Закрыть', click: () => closeTab(id) },
    { label: 'Закрыть другие вкладки', enabled: tabs.length > 1, click: () => tabs.filter((t) => t.id !== id).forEach((t) => closeTab(t.id)) },
  ]).popup({ window: win });
}

// ---------- IPC интерфейса ----------
const ui = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (win && e.sender === win.webContents) fn(...a); });
ui('ui:ready', push);
ui('nav:go', (text) => {
  const t = activeTab(); if (!t) return;
  t.errorFor = null;
  const wc = t.view.webContents;
  wc.loadURL(toUrl(text)).catch(() => {});
  wc.focus();
});
ui('nav:back', () => { const t = activeTab(); if (t) t.view.webContents.navigationHistory.goBack(); });
ui('nav:forward', () => { const t = activeTab(); if (t) t.view.webContents.navigationHistory.goForward(); });
ui('nav:reload', () => { const t = activeTab(); if (!t) return; t.loading ? t.view.webContents.stop() : reloadTab(t, false); });
ui('tab:new', newTabAndFocus);
ui('tab:close', closeTab);
ui('tab:select', activateTab);
ui('tab:menu', tabMenu);
ui('flag:toggle', (name) => toggleFlag(activeTab(), name));
ui('menu:open', openMenu);
ui('find:query', (text, forward, next) => {
  const t = activeTab(); if (!t) return;
  const wc = t.view.webContents;
  if (!text) { wc.stopFindInPage('clearSelection'); findState = { active: 0, total: 0 }; push(); return; }
  wc.findInPage(text, { forward: forward !== false, findNext: !!next });
});
ui('find:close', () => closeFind(true));

// ---------- запуск ----------
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
app.on('window-all-closed', () => app.quit());
app.on('quit', () => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {} });

app.whenReady().then(async () => {
  setupSession();
  await createWindow();
  const arg = process.argv.slice(1).find((a) => /^https?:\/\//i.test(a));
  if (SELFTEST) {
    await require('./selftest.js')({ win, ses, createTab, setFlag, tabs, closeTab, activateTab });
    return;
  }
  createTab(arg || NEWTAB_URL, true);
  if (!arg) focusAddress();
});
