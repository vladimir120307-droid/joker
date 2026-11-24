'use strict';
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const FEATURES = ['fullscreen', 'focus'];

(async () => {
  // ?tab=ID позволяет открыть popup как обычную страницу (для тестов)
  const q = new URLSearchParams(location.search).get('tab');
  const tab = q ? await api.tabs.get(Number(q)) : (await api.tabs.query({ active: true, currentWindow: true }))[0];

  let host = null;
  try {
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname.replace(/^www\./, '');
  } catch (_) {}

  if (!host) {
    $('host').textContent = '';
    $('status').textContent = 'На этой странице расширение не работает (служебная страница браузера).';
    for (const f of FEATURES) $(f).disabled = true;
    return;
  }
  $('host').textContent = host;

  const paint = (modes) => {
    for (const f of FEATURES) {
      $(f).value = modes[f];
      $(f).closest('.row').classList.toggle('on', modes[f] !== 'off');
    }
  };
  paint((await api.runtime.sendMessage({ type: 'get', host })).modes);

  for (const f of FEATURES) {
    $(f).addEventListener('change', async () => {
      const r = await api.runtime.sendMessage({ type: 'set', feature: f, mode: $(f).value, host, tabId: tab.id });
      if (r && r.modes) paint(r.modes);
      else $('status').textContent = 'Ошибка: ' + (r && r.error);
    });
  }
})();
