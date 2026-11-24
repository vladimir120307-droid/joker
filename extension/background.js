'use strict';
// Хранит настройки по сайтам и регистрирует flag-*.js, чтобы режим включался ДО скриптов сайта.
const api = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = typeof globalThis.browser !== 'undefined' && !!globalThis.browser.runtime.getBrowserInfo;
const FEATURES = ['focus', 'fullscreen'];

async function getSettings() {
  const s = await api.storage.local.get(FEATURES);
  const out = {};
  for (const f of FEATURES) out[f] = { all: !!(s[f] && s[f].all), sites: (s[f] && s[f].sites) || [] };
  return out;
}

const hostMatches = (h, host) => host === h || host.endsWith('.' + h);
const modeFor = (st, host) => (st.all ? 'all' : st.sites.some((h) => hostMatches(h, host)) ? 'site' : 'off');

function patternsFor(host) {
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return [`*://${host}/*`];
  return [`*://${host}/*`, `*://*.${host}/*`];
}

// запросы на синхронизацию выполняются строго по очереди
let chain = Promise.resolve();
const syncScripts = () => (chain = chain.then(doSync, doSync));

async function doSync() {
  const s = await getSettings();
  const have = new Map((await api.scripting.getRegisteredContentScripts()).map((x) => [x.id, x]));
  for (const f of FEATURES) {
    const id = 'jk-' + f;
    const matches = s[f].all ? ['<all_urls>'] : s[f].sites.flatMap(patternsFor);
    const cur = have.get(id);
    // уже зарегистрировано ровно так, как нужно — не трогаем (иначе на старте браузера образуется окно без защиты)
    if (cur && matches.length && JSON.stringify([...cur.matches].sort()) === JSON.stringify([...matches].sort())) continue;
    if (cur) await api.scripting.unregisterContentScripts({ ids: [id] });
    if (!matches.length) continue;
    await api.scripting.registerContentScripts([{
      id, js: [`flag-${f}.js`], matches, allFrames: true, runAt: 'document_start', world: 'MAIN',
      persistAcrossSessions: true,
      ...(IS_FIREFOX ? { matchAboutBlank: true } : { matchOriginAsFallback: true }),
    }]);
  }
}

// Мгновенно применить режим во всех фреймах уже открытой вкладки
async function applyLive(tabId, detail) {
  try {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: (d) => { window.dispatchEvent(new CustomEvent('wnd:s', { detail: d })); },
      args: [detail],
    });
  } catch (_) { /* служебные страницы браузера — туда внедряться нельзя */ }
  await showBadge(tabId);
}

async function showBadge(tabId) {
  try {
    const r = await api.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => { const S = window[Symbol.for('wnd.s')]; return S ? { f: !!S.fullscreen, h: !!S.focus } : null; },
    });
    const v = r && r[0] && r[0].result;
    await api.action.setBadgeText({ tabId, text: v ? (v.f ? 'F' : '') + (v.h ? 'H' : '') : '' });
    await api.action.setBadgeBackgroundColor({ tabId, color: '#1a73e8' });
  } catch (_) {}
}

async function getState(host) {
  const s = await getSettings();
  return { modes: { focus: modeFor(s.focus, host), fullscreen: modeFor(s.fullscreen, host) } };
}

async function setMode({ feature, mode, host, tabId }) {
  if (!FEATURES.includes(feature) || !['off', 'site', 'all'].includes(mode) || !host) throw new Error('bad request');
  const s = await getSettings();
  const st = s[feature];
  st.sites = st.sites.filter((h) => !hostMatches(h, host));
  st.all = mode === 'all';
  if (mode === 'site') st.sites.push(host);
  await api.storage.local.set({ [feature]: st });
  await syncScripts();
  if (tabId != null) await applyLive(tabId, { [feature]: mode !== 'off' });
  return getState(host);
}

async function handleMessage(msg) {
  if (msg && msg.type === 'get') return getState(msg.host);
  if (msg && msg.type === 'set') return setMode(msg);
  throw new Error('unknown message');
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

// Горячие клавиши: переключают режим на текущей вкладке (без запоминания для сайта)
api.commands.onCommand.addListener(async (cmd) => {
  const feature = cmd === 'toggle-fullscreen' ? 'fullscreen' : cmd === 'toggle-focus' ? 'focus' : null;
  if (!feature) return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  let next = true;
  try {
    const r = await api.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: (f) => { const S = window[Symbol.for('wnd.s')]; return S ? !S[f] : true; },
      args: [feature],
    });
    next = !!(r && r[0] && r[0].result);
  } catch (_) { return; }
  await applyLive(tab.id, { [feature]: next });
});

api.runtime.onInstalled.addListener(syncScripts);
api.runtime.onStartup.addListener(syncScripts);
