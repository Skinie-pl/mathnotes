'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const { APP_NAME, MENU_ACTIONS, MAX_IMAGE_BYTES } = require('./renderer/core.js');
const { saveNotebook, readNotebook } = require('./notebook-file.js');

const isMac = process.platform === 'darwin';
const INDEX_HTML = path.join(__dirname, 'index.html');

const NOTEBOOK_FILTERS = [{ name: 'Notatnik MathNotes', extensions: ['json'] }];
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** @type {BrowserWindow | null} */
let mainWindow = null;

// Ścieżka bieżącego pliku żyje wyłącznie tutaj. Renderer jej nie zna i nie może
// jej podać — ścieżki biorą się tylko z natywnych dialogów albo z listy
// ostatnich plików systemu.
let currentPath = null;
let unsaved = false;
let forceClose = false;
// Plik z „Ostatnich” może przyjść, zanim renderer zdąży się zgłosić.
let pendingOpen = null;
let rendererReady = false;

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

  mainWindow.on('close', (event) => {
    if (forceClose || !unsaved) return;

    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: 'Niezapisane zmiany',
      message: 'Notatnik ma niezapisane zmiany.',
      detail: 'Jeśli zamkniesz okno bez zapisania, zmiany przepadną.',
      buttons: ['Zapisz', 'Nie zapisuj', 'Anuluj'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });

    if (choice === 2) return;
    if (choice === 1) {
      forceClose = true;
      mainWindow.close();
      return;
    }
    // „Zapisz”: renderer ma stan dokumentu, więc to on zapisuje i odmeldowuje
    // się przez window:ready-to-close. Brak odpowiedzi = okno zostaje otwarte.
    mainWindow.webContents.send('app:save-and-close');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
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
// IPC — każdy handler sprawdza nadawcę i kształt argumentów
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
  return mainWindow !== null && event.sender === mainWindow.webContents;
}

function fileLabel(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function rememberPath(filePath) {
  currentPath = filePath;
  app.addRecentDocument(filePath);
}

async function openFromPath(filePath) {
  const raw = await readNotebook(filePath);
  rememberPath(filePath);
  return { name: fileLabel(filePath), raw };
}

ipcMain.handle('notebook:open', async (event) => {
  if (!isTrustedSender(event)) return { canceled: true };

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Otwórz notatnik',
    properties: ['openFile'],
    filters: NOTEBOOK_FILTERS,
  });
  if (canceled || filePaths.length === 0) return { canceled: true };

  try {
    return await openFromPath(filePaths[0]);
  } catch (err) {
    dialog.showMessageBoxSync(mainWindow, {
      type: 'error',
      title: 'Nie udało się otworzyć',
      message: err.message,
      buttons: ['OK'],
    });
    return { canceled: true };
  }
});

ipcMain.handle('notebook:save', async (event, payload) => {
  if (!isTrustedSender(event)) return { canceled: true };
  if (payload === null || typeof payload !== 'object') return { canceled: true };
  const { state, saveAs } = payload;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return { canceled: true };

  let target = saveAs === true ? null : currentPath;
  if (!target) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Zapisz notatnik',
      defaultPath: currentPath ?? 'notatnik.json',
      filters: NOTEBOOK_FILTERS,
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    target = result.filePath;
  }

  try {
    await saveNotebook(target, state);
  } catch (err) {
    dialog.showMessageBoxSync(mainWindow, {
      type: 'error',
      title: 'Nie udało się zapisać',
      message: err.message,
      buttons: ['OK'],
    });
    return { canceled: true };
  }

  rememberPath(target);
  return { name: fileLabel(target) };
});

ipcMain.handle('notebook:new', (event) => {
  if (!isTrustedSender(event)) return false;
  currentPath = null;
  return true;
});

ipcMain.handle('image:pick', async (event) => {
  if (!isTrustedSender(event)) return { canceled: true };

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Wstaw obraz',
    properties: ['openFile'],
    filters: [{ name: 'Obrazy', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };

  const filePath = filePaths[0];
  const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
  if (!mime) return { canceled: true, reason: 'Nieobsługiwany format obrazu.' };

  const bytes = await fs.readFile(filePath);
  const dataUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
  if (dataUrl.length > MAX_IMAGE_BYTES) {
    return { canceled: true, reason: 'Obraz jest za duży (limit 5 MB po zakodowaniu).' };
  }

  return { dataUrl };
});

// Kod zaproszenia kopiuje main, bo navigator.clipboard nie działa na file://.
// Limit długości, żeby renderer nie mógł tędy wypchnąć dowolnej ilości danych.
ipcMain.on('clipboard:write', (event, text) => {
  if (!isTrustedSender(event)) return;
  if (typeof text !== 'string' || text.length === 0 || text.length > 1000) return;
  clipboard.writeText(text);
});

// Stan „są niezapisane zmiany” trzyma renderer; main potrzebuje go tylko po to,
// żeby zapytać przy zamykaniu okna.
ipcMain.on('notebook:dirty', (event, dirty) => {
  if (!isTrustedSender(event)) return;
  unsaved = dirty === true;
});

ipcMain.on('window:ready-to-close', (event) => {
  if (!isTrustedSender(event)) return;
  forceClose = true;
  mainWindow.close();
});

ipcMain.on('renderer:ready', (event) => {
  if (!isTrustedSender(event)) return;
  rendererReady = true;
  if (pendingOpen) {
    const payload = pendingOpen;
    pendingOpen = null;
    mainWindow.webContents.send('notebook:opened', payload);
  }
});

// ---------------------------------------------------------------------------
// Otwieranie z systemu (lista „Ostatnie pliki”, przeciągnięcie na ikonę)
// ---------------------------------------------------------------------------

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openFromPath(filePath)
    .then((payload) => {
      if (rendererReady && mainWindow) mainWindow.webContents.send('notebook:opened', payload);
      else pendingOpen = payload;
    })
    .catch((err) => {
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'Nie udało się otworzyć',
        message: err.message,
        buttons: ['OK'],
      });
    });
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
      item('Tło strony', 'view:background', 'CmdOrCtrl+G'),
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
