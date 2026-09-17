'use strict';

// Okablowanie DOM/canvas. Logika bez DOM mieszka w renderer/core.js.
(function () {
  const { PAGE_WIDTH, MENU_ACTIONS, formatTitle } = window.MathNotesCore;

  const page = document.getElementById('page');
  page.style.width = PAGE_WIDTH + 'px';

  // -------------------------------------------------------------------------
  // Tytuł okna jako pasek stanu
  // -------------------------------------------------------------------------

  let docName = null;
  let dirty = false;
  let flashTimer = 0;

  function refreshTitle() {
    if (flashTimer) return; // flash ma pierwszeństwo, tytuł wróci sam
    document.title = formatTitle(docName, dirty);
  }

  function flashTitle(message, ms = 1600) {
    clearTimeout(flashTimer);
    document.title = message;
    flashTimer = setTimeout(() => {
      flashTimer = 0;
      refreshTitle();
    }, ms);
  }

  // -------------------------------------------------------------------------
  // Akcje menu
  // -------------------------------------------------------------------------

  // Handlery dochodzą etapami. Do czasu implementacji akcja mówi o tym w tytule,
  // zamiast milczeć.
  const handlers = Object.create(null);

  function dispatch(action) {
    const handler = handlers[action];
    if (handler) handler();
    else if (MENU_ACTIONS.includes(action)) flashTitle('Jeszcze niedostępne: ' + action);
    else flashTitle('Nieznana akcja menu: ' + action);
  }

  window.api.onMenu(dispatch);

  refreshTitle();
})();
