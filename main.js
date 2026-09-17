'use strict';

const { app, BrowserWindow, Menu, dialog } = require('electron');
const path = require('node:path');
const { APP_NAME, MENU_ACTIONS } = require('./renderer/core.js');

const isMac = process.platform === 'darwin';
const INDEX_HTML = path.join(__dirname, 'index.html');

/** @type {BrowserWindow | null} */
let mainWindow = null;

// ---------------------------------------------------------------------------
// Okno
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#000000',
    title: APP_NAME,
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(INDEX_HTML);
}

// ---------------------------------------------------------------------------
// Blokada nawigacji i nowych okien (dotyczy każdego webContents, także przyszłych)
// ---------------------------------------------------------------------------

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    // Renderer ładuje wyłącznie lokalny index.html. Reload (ten sam URL) przepuszczamy.
    if (url !== contents.getURL()) event.preventDefault();
  });

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-attach-webview', (event) => event.preventDefault());
});

// ---------------------------------------------------------------------------
// Menu (po polsku, natywne — nie custom UI)
// ---------------------------------------------------------------------------

function send(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu', action);
}

// Pozycja menu wskazuje akcję z MENU_ACTIONS. Literówka wysadza start aplikacji,
// zamiast dawać martwy przycisk.
function item(label, action, accelerator) {
  if (!MENU_ACTIONS.includes(action)) {
    throw new Error('Nieznana akcja menu: ' + action);
  }
  return { label, accelerator, click: () => send(action) };
}

function buildMenu() {
  const template = [];

  if (isMac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { label: 'O programie ' + APP_NAME, click: showAbout },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Ukryj ' + APP_NAME },
        { role: 'hideOthers', label: 'Ukryj pozostałe' },
        { role: 'unhide', label: 'Pokaż wszystko' },
        { type: 'separator' },
        { role: 'quit', label: 'Zakończ ' + APP_NAME },
      ],
    });
  }

  template.push({
    label: 'Plik',
    submenu: [
      item('Nowy', 'file:new', 'CmdOrCtrl+N'),
      item('Otwórz…', 'file:open', 'CmdOrCtrl+O'),
      ...(isMac
        ? [{ role: 'recentDocuments', label: 'Ostatnie pliki', submenu: [{ role: 'clearRecentDocuments', label: 'Wyczyść listę' }] }]
        : []),
      { type: 'separator' },
      item('Zapisz', 'file:save', 'CmdOrCtrl+S'),
      item('Zapisz jako…', 'file:save-as', 'CmdOrCtrl+Shift+S'),
      { type: 'separator' },
      item('Wstaw obraz…', 'file:insert-image', 'CmdOrCtrl+Shift+I'),
      { type: 'separator' },
      isMac ? { role: 'close', label: 'Zamknij okno' } : { role: 'quit', label: 'Zakończ' },
    ],
  });

  template.push({
    label: 'Edycja',
    submenu: [
      // Świadomie nie role:'undo' — cofanie robi Y.UndoManager w rendererze,
      // nie undo DOM-owe pola tekstowego.
      item('Cofnij', 'edit:undo', 'CmdOrCtrl+Z'),
      item('Ponów', 'edit:redo', 'CmdOrCtrl+Shift+Z'),
      { type: 'separator' },
      item('Wyczyść notatnik', 'edit:clear'),
    ],
  });

  template.push({
    label: 'Widok',
    submenu: [
      item('Powiększ', 'view:zoom-in', 'CmdOrCtrl+Plus'),
      item('Pomniejsz', 'view:zoom-out', 'CmdOrCtrl+-'),
      item('Rozmiar rzeczywisty', 'view:zoom-reset', 'CmdOrCtrl+0'),
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Pełny ekran' },
      { role: 'toggleDevTools', label: 'Narzędzia deweloperskie' },
    ],
  });

  template.push({
    label: 'Online',
    submenu: [
      item('Rozpocznij sesję online', 'online:start'),
      item('Dołącz do sesji…', 'online:join'),
      { type: 'separator' },
      item('Kopiuj kod zaproszenia', 'online:copy-invite'),
      item('Zakończ sesję', 'online:leave'),
      { type: 'separator' },
      item('Ustawienia połączenia…', 'online:settings'),
    ],
  });

  template.push({ role: 'windowMenu', label: 'Okno' });

  template.push({
    label: 'Pomoc',
    submenu: [{ label: 'O programie ' + APP_NAME, click: showAbout }],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'info',
    title: 'O programie ' + APP_NAME,
    message: APP_NAME + ' ' + app.getVersion(),
    detail:
      'Offline notatnik matematyczny na tablet graficzny.\n' +
      'Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome,
    buttons: ['OK'],
  });
}

// ---------------------------------------------------------------------------
// Cykl życia
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
