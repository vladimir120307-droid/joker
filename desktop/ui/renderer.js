'use strict';
const $ = (id) => document.getElementById(id);
const urlInput = $('url');
let userEditing = false;
let shown = { id: null, url: null };

const X_SVG = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const LOCK_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const WARN_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>';

function render(s) {
  // ---- вкладки ----
  const box = $('tabs');
  const want = s.tabs.map((t) => t.id).join(',');
  if (box.dataset.ids !== want) {
    box.dataset.ids = want;
    box.textContent = '';
    for (const t of s.tabs) {
      const el = document.createElement('div');
      el.className = 'tab';
      el.dataset.id = t.id;
      el.innerHTML = '<span class="lead"></span><span class="title"></span><span class="dots"></span><button class="x" title="Закрыть вкладку">' + X_SVG + '</button>';
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); api.closeTab(t.id); }
        else if (e.button === 0 && !e.target.closest('.x')) api.selectTab(t.id);
      });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.tabMenu(t.id); });
      el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); api.closeTab(t.id); });
      box.appendChild(el);
    }
  }
  for (const t of s.tabs) {
    const el = box.querySelector(`.tab[data-id="${t.id}"]`);
    if (!el) continue;
    el.classList.toggle('active', t.id === s.activeId);
    el.title = t.title;
    el.querySelector('.title').textContent = t.title;
    const lead = el.querySelector('.lead');
    if (t.loading) {
      if (!lead.firstChild || lead.firstChild.className !== 'spin') lead.innerHTML = '<span class="spin"></span>';
    } else if (t.favicon) {
      if (!lead.firstChild || lead.firstChild.dataset.src !== t.favicon) {
        const f = document.createElement('span');
        f.className = 'fav'; f.dataset.src = t.favicon;
        f.style.backgroundImage = `url("${t.favicon.replace(/"/g, '%22')}")`;
        lead.textContent = ''; lead.appendChild(f);
      }
    } else if (!lead.firstChild || lead.firstChild.className !== 'fav blank') {
      lead.innerHTML = '<span class="fav blank"></span>';
    }
    const dots = el.querySelector('.dots');
    dots.textContent = '';
    if (t.fs) { const d = document.createElement('i'); d.className = 'dot'; d.title = 'Полный экран'; dots.appendChild(d); }
    if (t.focus) { const d = document.createElement('i'); d.className = 'dot'; d.title = 'Скрытие переключения'; dots.appendChild(d); }
  }

  // ---- панель адреса ----
  const a = s.active;
  if (a) {
    $('back').disabled = !a.canBack;
    $('fwd').disabled = !a.canForward;
    $('ic-reload').hidden = a.loading;
    $('ic-stop').hidden = !a.loading;
    $('t-fs').classList.toggle('on', a.flags.fullscreen);
    $('t-focus').classList.toggle('on', a.flags.focus);
    $('t-fs').setAttribute('aria-pressed', a.flags.fullscreen);
    $('t-focus').setAttribute('aria-pressed', a.flags.focus);
    const sec = $('sec');
    sec.className = 'sec';
    if (a.https) sec.innerHTML = LOCK_SVG;
    else if (a.http) { sec.classList.add('warn'); sec.innerHTML = WARN_SVG + '<span>Не защищено</span>'; }
    else sec.textContent = '';

    const changed = shown.id !== s.activeId || shown.url !== a.url;
    if (changed && (!userEditing || shown.id !== s.activeId)) {
      urlInput.value = a.url;
      userEditing = false;
    }
    shown = { id: s.activeId, url: a.url };
  }

  // ---- поиск ----
  $('find').hidden = !s.find.open;
  $('find-n').textContent = s.find.open && $('find-q').value ? `${s.find.active}/${s.find.total}` : '';
}

api.onState(render);
api.ready();

// ---- события интерфейса ----
$('back').onclick = () => api.back();
$('fwd').onclick = () => api.forward();
$('reload').onclick = () => api.reload();
$('newtab').onclick = () => api.newTab();
$('t-fs').onclick = () => api.toggle('fullscreen');
$('t-focus').onclick = () => api.toggle('focus');
$('menu').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); api.menu(r.right - 4, r.bottom); };

urlInput.addEventListener('input', () => { userEditing = true; });
urlInput.addEventListener('focus', () => urlInput.select());
urlInput.addEventListener('blur', () => { userEditing = false; urlInput.value = shown.url ?? ''; });
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { userEditing = false; api.go(urlInput.value); }
  else if (e.key === 'Escape') { userEditing = false; urlInput.value = shown.url ?? ''; urlInput.select(); }
});
api.onFocusAddress(() => { urlInput.focus(); urlInput.select(); });

const fq = $('find-q');
const doFind = (forward, next) => api.find(fq.value, forward, next);
fq.addEventListener('input', () => doFind(true, false));
fq.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey, true); }
  else if (e.key === 'Escape') api.closeFind();
});
$('find-next').onclick = () => doFind(true, true);
$('find-prev').onclick = () => doFind(false, true);
$('find-close').onclick = () => api.closeFind();
api.onFocusFind(() => { fq.focus(); fq.select(); });
