// Включает режим «сообщать о полном экране» с самого начала загрузки страницы (регистрируется background.js для выбранных сайтов)
(() => {
  const K = Symbol.for('wnd.s');
  const S = window[K] || Object.defineProperty(window, K, { value: { focus: false, fullscreen: false }, configurable: true })[K];
  S.fullscreen = true;
})();
