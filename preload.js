'use strict';

// Jedyny most renderer↔Node. Wyłącznie jawnie nazwane metody —
// nigdy surowy ipcRenderer ani require.
//
// Zwróć uwagę, czego tu NIE MA: żadna metoda nie przyjmuje ścieżki pliku.
// Ścieżki biorą się w main.js z natywnych dialogów albo z listy ostatnich
// plików, którą również trzyma proces główny — nigdy z tekstu od renderera
// czy z sesji online.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler, unwrap) {
  if (typeof handler !== 'function') throw new TypeError(channel + ': oczekiwano funkcji');
  const listener = (_event, ...args) => unwrap(handler, ...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  /** Akcje z natywnego menu. Zwraca funkcję odsubskrybowującą. */
  onMenu(handler) {
    return subscribe('menu', handler, (fn, action, payload) => {
      if (typeof action === 'string') fn(action, payload);
    });
  },

  /** Notatnik otwarty spoza okna (lista „Ostatnie pliki”, ikona aplikacji). */
  onOpened(handler) {
    return subscribe('notebook:opened', handler, (fn, payload) => {
      if (payload !== null && typeof payload === 'object') fn(payload);
    });
  },

  /** Prośba o zapis przed zamknięciem okna. Po udanym zapisie wołaj readyToClose(). */
  onSaveAndClose(handler) {
    return subscribe('app:save-and-close', handler, (fn) => fn());
  },

  /** @returns {Promise<{name: string, raw: object} | {canceled: true}>} */
  openNotebook() {
    return ipcRenderer.invoke('notebook:open');
  },

  /** @returns {Promise<{name: string} | {canceled: true}>} */
  saveNotebook(state, saveAs) {
    return ipcRenderer.invoke('notebook:save', { state, saveAs: saveAs === true });
  },

  /** Cichy zapis w tle do już znanego pliku. Bez dialogów i bez błędów na wierzchu. */
  autosave(state) {
    return ipcRenderer.invoke('notebook:autosave', { state });
  },

  /** Zapomina bieżącą ścieżkę, żeby następny zapis zapytał o nową. */
  newNotebook() {
    return ipcRenderer.invoke('notebook:new');
  },

  /**
   * Wybór PDF-a do pisania po nim. Main czyta plik sam i oddaje same bajty.
   * @returns {Promise<{name: string, bytes: Uint8Array} | {canceled: true}>}
   */
  openPdf() {
    return ipcRenderer.invoke('pdf:open');
  },

  /** @returns {Promise<{name: string} | {canceled: true}>} */
  savePdf(data, suggestedName) {
    return ipcRenderer.invoke('pdf:save', { data, suggestedName });
  },

  /** Kopiuje krótki tekst (kod zaproszenia) do schowka systemowego. */
  copyText(text) {
    ipcRenderer.send('clipboard:write', typeof text === 'string' ? text : '');
  },

  setDirty(dirty) {
    ipcRenderer.send('notebook:dirty', dirty === true);
  },

  ready() {
    ipcRenderer.send('renderer:ready');
  },

  readyToClose() {
    ipcRenderer.send('window:ready-to-close');
  },
});
