'use strict';

// Jedyny most renderer↔Node. Wyłącznie jawnie nazwane metody —
// nigdy surowy ipcRenderer ani require.
//
// Zwróć uwagę, czego tu NIE MA: żadna metoda nie przyjmuje ścieżki pliku.
// Ścieżki biorą się w main.js z natywnych dialogów albo z listy ostatnich
// plików systemu, nigdy z tekstu od renderera czy z sesji online.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler, unwrap) {
  if (typeof handler !== 'function') throw new TypeError(channel + ': oczekiwano funkcji');
  const listener = (_event, payload) => unwrap(handler, payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  /** Akcje z natywnego menu. Zwraca funkcję odsubskrybowującą. */
  onMenu(handler) {
    return subscribe('menu', handler, (fn, action) => {
      if (typeof action === 'string') fn(action);
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

  /** Zapomina bieżącą ścieżkę, żeby następny zapis zapytał o nową. */
  newNotebook() {
    return ipcRenderer.invoke('notebook:new');
  },

  /** @returns {Promise<{dataUrl: string} | {canceled: true, reason?: string}>} */
  pickImage() {
    return ipcRenderer.invoke('image:pick');
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
