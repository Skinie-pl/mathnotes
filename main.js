'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const { APP_NAME, MENU_ACTIONS } = require('./renderer/core.js');
const { saveNotebook, readNotebook } = require('./notebook-file.js');

const isMac = process.platform === 'darwin';
const INDEX_HTML = path.join(__dirname, 'index.html');

const NOTEBOOK_FILTERS = [{ name: 'Notatki matematyczne', extensions: ['json'] }];
const MAX_RECENT = 8;
const MAX_PDF_BYTES = 200 * 1024 * 1024;

/** @type {BrowserWindow | null} */
let mainWindow = null;

// Ścieżka bieżącego pliku żyje wyłącznie tutaj. Renderer jej nie zna i nie może
// jej podać — ścieżki biorą się tylko z natywnych dialogów albo z listy
// ostatnich plików, którą też trzyma proces główny.
let currentPath = null;
let unsaved = false;
let forceClose = false;
let annotationLinesVisible = true;
let lightTheme = false;
// Plik z „Ostatnich” może przyjść, zanim renderer zdąży się zgłosić.
let pendingOpen = null;
let rendererReady = false;

// ---------------------------------------------------------------------------
// Katalog notatek i lista ostatnich plików
// ---------------------------------------------------------------------------

function notesDir() {
  return path.join(app.getPath('documents'), APP_NAME);
}

function recentFilePath() {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

async function ensureNotesDir() {
  await fs.mkdir(notesDir(), { recursive: true }).catch(() => {});
}

async function loadRecent() {
  try {
    const raw = JSON.parse(await fs.readFile(recentFilePath(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    const existing = [];
    for (const item of raw) {
      if (typeof item !== 'string' || !path.isAbsolute(item)) continue;
      if (await fs.access(item).then(() => true, () => false)) existing.push(item);
    }
    return existing.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

async function rememberPath(filePath) {
  currentPath = filePath;
  try {
    app.addRecentDocument(filePath);
  } catch {
    // Nie każda platforma to wspiera.
  }
  const list = (await loadRecent()).filter((item) => item !== filePath);
  list.unshift(filePath);
  await fs.writeFile(recentFilePath(), JSON.stringify(list.slice(0, MAX_RECENT)), 'utf8').catch(() => {});
  await buildMenu();
}

// ---------------------------------------------------------------------------
// Okno
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#000000',
    title: APP_NAME,
    // Na macOS menu siedzi w pasku systemowym i okno go nie potrzebuje.
    // Na Windowsie i Linuksie menu JEST w oknie, więc chowanie go za Altem
    // (autoHideMenuBar) zabierało jedyne dojście do „Otwórz…", eksportu PDF
    // czy trybu online. Wąski pasek na górze to mniejsza strata niż funkcje,
    // których nie da się znaleźć.
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

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
  return path.basename(filePath);
}

function showError(title, message) {
  dialog.showMessageBoxSync(mainWindow ?? undefined, {
    type: 'error',
    title,
    message,
    buttons: ['OK'],
  });
}

async function openFromPath(filePath) {
  const raw = await readNotebook(filePath);
  await rememberPath(filePath);
  return { name: fileLabel(filePath), raw };
}

async function pushOpened(filePath) {
  try {
    const payload = await openFromPath(filePath);
    if (rendererReady && mainWindow) mainWindow.webContents.send('notebook:opened', payload);
    else pendingOpen = payload;
  } catch (err) {
    showError('Nie udało się otworzyć', err.message);
  }
}

ipcMain.handle('notebook:open', async (event) => {
  if (!isTrustedSender(event)) return { canceled: true };
  await ensureNotesDir();

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Otwórz notatnik',
    defaultPath: notesDir(),
    properties: ['openFile'],
    filters: NOTEBOOK_FILTERS,
  });
  if (canceled || filePaths.length === 0) return { canceled: true };

  try {
    return await openFromPath(filePaths[0]);
  } catch (err) {
    showError('Nie udało się otworzyć', err.message);
    return { canceled: true };
  }
});

// Wczytanie PDF-a do pisania po nim. Renderer dostaje wyłącznie bajty — nazwa
// pliku idzie osobno i tylko do pokazania, a ścieżka nie opuszcza main.js.
ipcMain.handle('pdf:open', async (event) => {
  if (!isTrustedSender(event)) return { canceled: true };

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Wczytaj PDF jako tło',
    properties: ['openFile'],
    filters: [{ name: 'Dokumenty PDF', extensions: ['pdf'] }],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };

  try {
    const stat = await fs.stat(filePaths[0]);
    if (stat.size > MAX_PDF_BYTES) {
      showError('Plik jest za duży', 'PDF może mieć najwyżej ' + Math.round(MAX_PDF_BYTES / 1024 / 1024) + ' MB.');
      return { canceled: true };
    }
    const bytes = await fs.readFile(filePaths[0]);
    return { name: path.basename(filePaths[0]), bytes: new Uint8Array(bytes) };
  } catch (err) {
    showError('Nie udało się wczytać PDF-a', err.message);
    return { canceled: true };
  }
});

ipcMain.handle('notebook:save', async (event, payload) => {
  if (!isTrustedSender(event)) return { canceled: true };
  if (payload === null || typeof payload !== 'object') return { canceled: true };
  const { state, saveAs } = payload;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return { canceled: true };
  await ensureNotesDir();

  let target = saveAs === true ? null : currentPath;
  if (!target) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Zapisz notatnik jako',
      defaultPath: currentPath ?? path.join(notesDir(), 'notatnik.json'),
      filters: NOTEBOOK_FILTERS,
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    target = result.filePath;
  }

  try {
    await saveNotebook(target, state);
  } catch (err) {
    showError('Nie udało się zapisać', err.message);
    return { canceled: true };
  }

  await rememberPath(target);
  return { name: fileLabel(target) };
});

// Cichy zapis w tle: bez dialogu, bez okienek błędu. Gdy notatnik nie ma
// jeszcze pliku, autozapis po prostu nie ma dokąd pisać.
ipcMain.handle('notebook:autosave', async (event, payload) => {
  if (!isTrustedSender(event)) return { ok: false };
  if (payload === null || typeof payload !== 'object') return { ok: false };
  const { state } = payload;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return { ok: false };
  if (!currentPath) return { ok: false, reason: 'no-path' };

  try {
    await saveNotebook(currentPath, state);
    return { ok: true, name: fileLabel(currentPath) };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('notebook:new', (event) => {
  if (!isTrustedSender(event)) return false;
  currentPath = null;
  return true;
});

ipcMain.handle('pdf:save', async (event, payload) => {
  if (!isTrustedSender(event)) return { canceled: true };
  if (payload === null || typeof payload !== 'object') return { canceled: true };

  const { data, suggestedName } = payload;
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  if (!bytes || bytes.length === 0 || bytes.length > MAX_PDF_BYTES) return { canceled: true };

  await ensureNotesDir();
  const safeName = typeof suggestedName === 'string' ? path.basename(suggestedName) : 'notatnik.pdf';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Eksportuj do PDF',
    defaultPath: path.join(notesDir(), safeName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  try {
    await fs.writeFile(result.filePath, Buffer.from(bytes));
  } catch (err) {
    showError('Nie udało się zapisać PDF-a', err.message);
    return { canceled: true };
  }
  return { name: fileLabel(result.filePath) };
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
  pushOpened(filePath);
});

// ---------------------------------------------------------------------------
// Menu (po polsku, natywne — nie custom UI)
// ---------------------------------------------------------------------------

function send(action, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu', action, payload);
}

// Pozycja menu wskazuje akcję z MENU_ACTIONS. Literówka wysadza start aplikacji,
// zamiast dawać martwy przycisk.
function item(label, action, accelerator) {
  if (!MENU_ACTIONS.includes(action)) {
    throw new Error('Nieznana akcja menu: ' + action);
  }
  return { label, accelerator, click: () => send(action) };
}

async function buildMenu() {
  const recent = await loadRecent();
  const recentSubmenu = recent.length
    ? recent.map((filePath) => ({
        label: path.basename(filePath),
        // Ścieżka nie przechodzi przez renderer — main czyta plik sam.
        click: () => pushOpened(filePath),
      }))
    : [{ label: '(brak ostatnich plików)', enabled: false }];

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
      { label: 'Otwórz ostatnie', submenu: recentSubmenu },
      { type: 'separator' },
      item('Zapisz', 'file:save', 'CmdOrCtrl+S'),
      item('Zapisz jako…', 'file:save-as', 'CmdOrCtrl+Shift+S'),
      item('Eksportuj do PDF…', 'file:export-pdf'),
      { type: 'separator' },
      item('Wczytaj PDF jako tło…', 'file:import-pdf'),
      { type: 'separator' },
      isMac ? { role: 'close', label: 'Zamknij okno' } : { role: 'quit', label: 'Zamknij' },
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
      { role: 'cut', label: 'Wytnij' },
      { role: 'copy', label: 'Kopiuj' },
      // Wklejenie obrazu ze schowka obsługuje zdarzenie `paste` w rendererze.
      { role: 'paste', label: 'Wklej' },
      { role: 'selectAll', label: 'Zaznacz wszystko' },
      { type: 'separator' },
      item('Skróty klawiszowe…', 'edit:keymap'),
    ],
  });

  template.push({
    label: 'Widok',
    submenu: [
      {
        label: 'Tryb biały',
        type: 'checkbox',
        checked: lightTheme,
        click: (menuItem) => {
          lightTheme = menuItem.checked;
          send('view:theme', menuItem.checked ? 'light' : 'dark');
        },
      },
      item('Kratka w tle…', 'view:grid'),
      { type: 'separator' },
      {
        label: 'Pokaż linie adnotacji',
        type: 'checkbox',
        checked: annotationLinesVisible,
        click: (menuItem) => {
          annotationLinesVisible = menuItem.checked;
          send('view:annotation-lines', menuItem.checked);
        },
      },
      { type: 'separator' },
      item('Resetuj widok', 'view:reset', 'CmdOrCtrl+0'),
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Pełny ekran' },
      { role: 'toggleDevTools', label: 'Narzędzia deweloperskie' },
    ],
  });

  template.push({
    label: 'Online',
    submenu: [
      item('Rozpocznij sesję online…', 'online:start'),
      item('Dołącz do sesji…', 'online:join'),
      { type: 'separator' },
      item('Kopiuj kod zaproszenia', 'online:copy-invite'),
      item('Zakończ sesję online', 'online:leave'),
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
    title: APP_NAME,
    message: APP_NAME,
    detail:
      'Notatnik matematyczny na tablet graficzny.\n' +
      'Wersja ' + app.getVersion() + '\n' +
      'Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome,
    buttons: ['OK'],
  });
}

// ---------------------------------------------------------------------------
// Cykl życia
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  await ensureNotesDir();
  await buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// --- TYMCZASOWY HARNESS QA (nie commitować) ---
if (process.env.MN_SYNC2) {
  const { writeFileSync } = require('node:fs');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => { console.log('QA TIMEOUT'); app.exit(2); }, 120000);
  const makeWindow = (x) => {
    const w = new BrowserWindow({
      width: 820, height: 620, x, y: 40, show: true, backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.loadFile(INDEX_HTML);
    return w;
  };

  app.whenReady().then(async () => {
    await wait(1200);
    const A = makeWindow(20); const B = makeWindow(860);
    await wait(2500);
    const jsA = (c) => A.webContents.executeJavaScript(c);
    const jsB = (c) => B.webContents.executeJavaScript(c);

    // Ile jasnych pikseli na kartce — czyli czy cokolwiek widać.
    const piksele = (js) => js(
      "(() => { const c=document.getElementById('canvas'); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;" +
      " let n=0; for(let i=0;i<d.length;i+=4) if(d[i]>40||d[i+1]>40||d[i+2]>40) n++; return n; })()");

    await jsA("document.getElementById('online-status-btn').click()"); await wait(300);
    await jsA("document.getElementById('online-join-start').click()"); await wait(4000);
    const kod = await jsA("document.getElementById('online-share-code').value");
    await jsA("document.getElementById('online-share-close').click()");
    await jsB("document.getElementById('online-status-btn').click()"); await wait(300);
    await jsB(`document.getElementById('online-join-input').value = ${JSON.stringify(kod)}`);
    await jsB("document.getElementById('online-join-ok').click()"); await wait(6000);
    await jsB("document.getElementById('online-share-close').click()"); await wait(500);

    console.log('QA start          B piksele=' + await piksele(jsB));

    await jsA("window.__qa.dodajKreske('#ffffff')"); await wait(2500);
    console.log('QA po kresce      B piksele=' + await piksele(jsB) + '  B stan=' + await jsB('JSON.stringify(window.__qa.state())'));

    await jsA("window.__qa.dodajAdnotacje('Rozdzial 1')"); await wait(2500);
    console.log('QA po adnotacji   B piksele=' + await piksele(jsB) + '  B stan=' + await jsB('JSON.stringify(window.__qa.state())'));

    await jsA('window.__qa.dodajObraz(60)'); await wait(4000);
    console.log('QA po obrazie     B piksele=' + await piksele(jsB) + '  B stan=' + await jsB('JSON.stringify(window.__qa.state())'));
    console.log('QA B bitmapy=' + await jsB("window.__qa.bitmapy ? window.__qa.bitmapy() : 'brak'"));

    writeFileSync('/tmp/qa-sync-A.png', (await A.webContents.capturePage()).toPNG());
    writeFileSync('/tmp/qa-sync-B.png', (await B.webContents.capturePage()).toPNG());
    console.log('QA A piksele=' + await piksele(jsA));
    app.exit(0);
  }).catch((e) => { console.log('QA BLAD:', e && e.message); app.exit(3); });
}
