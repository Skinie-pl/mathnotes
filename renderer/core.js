// Logika bez DOM. Ładowana przez <script> w rendererze oraz przez require() w testach.
// Wszystko, co da się przetestować bez canvasa, mieszka tutaj, nie w renderer.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MathNotesCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const APP_NAME = 'MathNotes';
  const UNTITLED = 'Bez tytułu';

  // Kartka, nie płótno: stała szerokość, przewijanie wyłącznie w pionie.
  const PAGE_WIDTH = 1400;

  // Jedyne źródło prawdy dla akcji menu. main.js buduje z tego menu,
  // renderer.js buduje z tego mapę handlerów — literówka nie przejdzie po cichu.
  const MENU_ACTIONS = Object.freeze([
    'file:new',
    'file:open',
    'file:save',
    'file:save-as',
    'file:insert-image',
    'edit:undo',
    'edit:redo',
    'edit:clear',
    'view:zoom-in',
    'view:zoom-out',
    'view:zoom-reset',
    'online:start',
    'online:join',
    'online:copy-invite',
    'online:leave',
    'online:settings',
  ]);

  // Status notatnika żyje w tytule okna — świadomie zamiast paska stanu,
  // który zjadałby pion ekranu na tablecie.
  function formatTitle(name, dirty) {
    const label = name && String(name).trim() ? String(name).trim() : UNTITLED;
    return (dirty ? '• ' : '') + label + ' — ' + APP_NAME;
  }

  return { APP_NAME, UNTITLED, PAGE_WIDTH, MENU_ACTIONS, formatTitle };
});
