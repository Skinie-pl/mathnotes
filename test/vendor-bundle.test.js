'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BUNDLE = path.join(__dirname, '..', 'renderer', 'vendor', 'collab.bundle.js');

/**
 * Bundle jest budowany pod przeglądarkę i ładowany przez <script>, więc
 * uruchamiamy go w kontekście z minimalnym zestawem globali — nie w node'owym
 * module. Gdyby zależności zaczęły sięgać po coś spoza tej listy, test padnie
 * tutaj, a nie w środku sesji online.
 */
function loadBundle() {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const sandbox = {
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto,
    TextEncoder,
    TextDecoder,
    WebSocket,
    URL,
    performance,
    navigator: { userAgent: 'test' },
    document: { addEventListener() {}, removeEventListener() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'collab.bundle.js' });
  return sandbox.Collab;
}

test('bundle Collab jest w repo', () => {
  assert.ok(fs.existsSync(BUNDLE), 'brak renderer/vendor/collab.bundle.js — uruchom `npm run vendor`');
});

test('bundle nie łamie CSP renderera', () => {
  // script-src 'self' bez unsafe-eval. Ten sam warunek pilnuje scripts/vendor.js,
  // ale tu chroni też przed ręcznie dłubanym bundlem wrzuconym do repo.
  const code = fs.readFileSync(BUNDLE, 'utf8');
  assert.equal(/(?<![.\w$])eval\s*\(/.test(code), false, 'bundle woła eval');
  assert.equal(/new\s+Function\s*\(/.test(code), false, 'bundle woła new Function');
});

test('bundle wystawia dokładnie Y, WebrtcProvider i awarenessProtocol', () => {
  const Collab = loadBundle();
  assert.deepEqual(Object.keys(Collab).sort(), ['WebrtcProvider', 'Y', 'awarenessProtocol']);
  assert.equal(typeof Collab.Y.Doc, 'function');
  assert.equal(typeof Collab.WebrtcProvider, 'function');
  assert.equal(typeof Collab.awarenessProtocol.Awareness, 'function');
});

test('Yjs z bundle działa na docelowym kształcie dokumentu', () => {
  const { Y } = loadBundle();
  const doc = new Y.Doc();
  const strokes = doc.getArray('strokes');

  // Uwaga: zwykły obiekt zbudowany tutaj pochodzi z innego realm niż bundle
  // w vm i nie przeszedłby kontroli typu w Yjs. Docelowy kształt i tak jest
  // inny — Y.Map z prostymi wartościami — więc testujemy jego.
  const stroke = new Y.Map();
  doc.transact(() => {
    stroke.set('id', 'a1');
    stroke.set('size', 2);
    stroke.set('pts', Y.Array.from([10, 20, 0.5]));
    strokes.push([stroke]);
  });

  assert.equal(strokes.length, 1);
  assert.equal(strokes.get(0).get('id'), 'a1');
  // Array.from przenosi tablicę z realm vm do tego realm — bez tego
  // deepEqual porównywałby też prototypy i zawsze by padał.
  assert.deepEqual(Array.from(strokes.get(0).get('pts').toArray()), [10, 20, 0.5]);
});
