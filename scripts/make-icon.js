'use strict';

// Renderuje ikonę aplikacji do build/icon.png. Rysujemy ją w Electronie,
// żeby nie dokładać zależności graficznej tylko dla jednego pliku.
// Resztę formatów (.icns, .ico) generuje electron-builder z tego PNG.
//
//   npm run icon

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'build', 'icon.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });

  await win.loadFile(path.join(__dirname, 'icon.html'));
  const dataUrl = await win.webContents.executeJavaScript('window.__icon');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('Zapisano ' + path.relative(path.join(__dirname, '..'), OUT));
  app.exit(0);
});
