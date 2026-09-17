'use strict';

// Jedyny most renderer↔Node. Wyłącznie jawnie nazwane metody —
// nigdy surowy ipcRenderer ani require.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /**
   * Subskrypcja akcji z natywnego menu. Zwraca funkcję odsubskrybowującą.
   * @param {(action: string) => void} handler
   */
  onMenu(handler) {
    if (typeof handler !== 'function') throw new TypeError('onMenu: oczekiwano funkcji');
    const listener = (_event, action) => {
      if (typeof action === 'string') handler(action);
    };
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
