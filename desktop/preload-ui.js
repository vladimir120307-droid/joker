'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch, cb) => ipcRenderer.on(ch, (_e, ...a) => cb(...a));

contextBridge.exposeInMainWorld('api', {
  onState: (cb) => on('state', cb),
  onFocusAddress: (cb) => on('ui:focus-address', cb),
  onFocusFind: (cb) => on('ui:focus-find', cb),
  ready: () => ipcRenderer.send('ui:ready'),
  go: (text) => ipcRenderer.send('nav:go', String(text)),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  newTab: () => ipcRenderer.send('tab:new'),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  selectTab: (id) => ipcRenderer.send('tab:select', id),
  tabMenu: (id) => ipcRenderer.send('tab:menu', id),
  toggle: (name) => ipcRenderer.send('flag:toggle', name),
  menu: (x, y) => ipcRenderer.send('menu:open', x, y),
  find: (text, forward, next) => ipcRenderer.send('find:query', String(text), !!forward, !!next),
  closeFind: () => ipcRenderer.send('find:close'),
});
