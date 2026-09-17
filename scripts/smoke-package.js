'use strict';

// Sprawdza, że SPAKOWANA aplikacja naprawdę działa, a nie tylko wstaje.
// Paczka, której brakuje jednego skryptu, uruchamia się bez błędu i wygląda
// normalnie — po prostu nic nie reaguje. Sam fakt, że proces żyje, niczego
// nie dowodzi, więc łączymy się z nią po protokole DevTools, czytamy stan
// renderera i rysujemy jedną kreskę.
//
//   node scripts/smoke-package.js dist/MathNotes-1.1.0-mac-arm64/MathNotes.app

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 9333;
const target = process.argv[2];

if (!target) {
  console.error('Podaj ścieżkę do .app albo .exe z paczki.');
  process.exit(2);
}

/**
 * @returns {{cmd: string, args: string[]}} czym uruchomić sprawdzaną wersję
 */
function launcherFor(bundle) {
  if (bundle.endsWith('.app')) {
    const name = path.basename(bundle, '.app');
    return { cmd: path.join(bundle, 'Contents', 'MacOS', name), args: [] };
  }
  // Katalog projektu — sprawdzamy wersję ze źródeł, tę samą, którą daje `npm start`.
  if (fs.existsSync(path.join(bundle, 'package.json'))) {
    const electron = path.join(bundle, 'node_modules', '.bin', 'electron');
    return { cmd: electron, args: [bundle] };
  }
  return { cmd: bundle, args: [] };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await fetch('http://127.0.0.1:' + PORT + '/json/list').then((r) => r.json());
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Jeszcze nie wstało.
    }
    await wait(500);
  }
  throw new Error('Nie udało się połączyć z aplikacją po porcie DevTools.');
}

function cdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('Połączenie DevTools padło.')));
  });

  return {
    ready,
    close: () => socket.close(),
    send(method, params) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params: params || {} }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
  };
}

async function main() {
  const { cmd, args } = launcherFor(target);
  if (!fs.existsSync(cmd)) throw new Error('Nie ma pliku wykonywalnego: ' + cmd);

  const child = spawn(cmd, [...args, '--remote-debugging-port=' + PORT], { stdio: 'ignore', detached: true });
  const problems = [];

  try {
    const page = await findPage();
    const session = cdp(page.webSocketDebuggerUrl);
    await session.ready;

    // 1. Czy renderer w ogóle się wykonał i wpiął moduły.
    const wired = await session.evaluate(
      "JSON.stringify({ tytul: document.title, core: typeof window.MathNotesCore, doc: typeof window.MathNotesDoc," +
        " online: typeof window.MathNotesOnline, collab: typeof window.Collab, jspdf: typeof window.jspdf," +
        " api: typeof (window.api && window.api.onMenu), skryptow: document.querySelectorAll('script').length })",
    );
    const stan = JSON.parse(wired);
    console.log('stan renderera:', wired);

    for (const [klucz, oczekiwane] of [
      ['core', 'object'],
      ['doc', 'object'],
      ['online', 'object'],
      ['collab', 'object'],
      ['jspdf', 'object'],
      ['api', 'function'],
    ]) {
      if (stan[klucz] !== oczekiwane) problems.push('brak ' + klucz + ' (jest ' + stan[klucz] + ')');
    }
    // renderer.js ustawia tytuł; gdyby nie wszedł, zostałby statyczny z index.html.
    if (!stan.tytul.includes('—')) problems.push('renderer.js nie ustawił tytułu okna: ' + stan.tytul);

    // 2. Czy rysowanie działa — pojedyncza kreska musi zabrudzić dokument.
    const mouse = (type, x, y) =>
      session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 });

    await mouse('mousePressed', 420, 320);
    for (let i = 1; i <= 24; i++) {
      await mouse('mouseMoved', 420 + i * 9, 320 + Math.round(Math.sin(i / 3) * 26));
      await wait(12);
    }
    await mouse('mouseReleased', 636, 320);
    await wait(600);

    const afterDraw = await session.evaluate('document.title');
    console.log('tytuł po narysowaniu kreski:', afterDraw);
    if (!afterDraw.trim().endsWith('•')) {
      problems.push('rysowanie nie zmieniło dokumentu (tytuł: ' + afterDraw + ')');
    }

    session.close();
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }

  if (problems.length > 0) {
    console.error('\nPACZKA NIE DZIAŁA:');
    for (const problem of problems) console.error('  - ' + problem);
    process.exit(1);
  }
  console.log('\nPaczka działa: moduły wpięte, rysowanie zmienia dokument.');
}

main().catch((err) => {
  console.error('Błąd testu paczki:', err.message);
  process.exit(1);
});
