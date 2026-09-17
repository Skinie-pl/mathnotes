'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const frames = require('../scripts/webrtc-frames.js');

function losowe(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 7 + (i % 13)) & 0xff;
  return out;
}

function przepusc(bytes) {
  const pending = new Map();
  let complete = null;
  for (const frame of frames.toFrames(bytes)) {
    const result = frames.collect(pending, frame);
    if (result) complete = result;
  }
  return complete;
}

test('mała wiadomość idzie jedną ramką i wraca bez zmian', () => {
  const data = losowe(1000);
  const list = frames.toFrames(data);
  assert.equal(list.length, 1);
  assert.deepEqual(przepusc(data), data);
});

test('duża wiadomość jest dzielona i składana co do bajtu', () => {
  // Tyle właśnie wystarczyło, żeby kanał WebRTC się zamykał: jeden wklejony obraz.
  const data = losowe(900 * 1024);
  const list = frames.toFrames(data);

  assert.ok(list.length > 1, 'musi powstać więcej niż jedna ramka');
  for (const frame of list) {
    assert.ok(frame.length <= frames.MAX_PAYLOAD + frames.FRAME_HEADER, 'ramka mieści się w limicie kanału');
  }
  assert.deepEqual(przepusc(data), data);
});

test('ramki złożone nie po kolei dają ten sam wynik', () => {
  const data = losowe(300 * 1024);
  const list = frames.toFrames(data);
  const pending = new Map();

  let complete = null;
  for (const frame of [...list].reverse()) {
    const result = frames.collect(pending, frame);
    if (result) complete = result;
  }
  assert.deepEqual(complete, data);
});

test('dwie wiadomości przeplatane w locie nie mieszają się', () => {
  const a = losowe(200 * 1024);
  const b = losowe(150 * 1024);
  const framesA = frames.toFrames(a);
  const framesB = frames.toFrames(b);
  const pending = new Map();

  const wyniki = [];
  const dlugosc = Math.max(framesA.length, framesB.length);
  for (let i = 0; i < dlugosc; i++) {
    if (framesA[i]) {
      const r = frames.collect(pending, framesA[i]);
      if (r) wyniki.push(r);
    }
    if (framesB[i]) {
      const r = frames.collect(pending, framesB[i]);
      if (r) wyniki.push(r);
    }
  }

  assert.equal(wyniki.length, 2);
  assert.ok(wyniki.some((r) => Buffer.from(r).equals(Buffer.from(a))));
  assert.ok(wyniki.some((r) => Buffer.from(r).equals(Buffer.from(b))));
});

test('uszkodzone i złośliwe ramki są pomijane, nie składane', () => {
  const pending = new Map();
  // Za krótka na nagłówek.
  assert.equal(frames.collect(pending, new Uint8Array([1, 2, 3])), null);

  // Numer ramki poza zadeklarowaną liczbą.
  const zly = new Uint8Array(frames.FRAME_HEADER + 4);
  const view = new DataView(zly.buffer);
  zly[0] = 1;
  view.setUint32(1, 77, true);
  view.setUint16(5, 9, true); // numer 9
  view.setUint16(7, 2, true); // z dwóch
  assert.equal(frames.collect(pending, zly), null);
  assert.equal(pending.size, 0, 'nic się nie odkłada w pamięci');
});

test('niedokończone wiadomości nie rosną w nieskończoność', () => {
  // Druga strona jest niezaufana: może wysyłać pierwsze ramki i nigdy ich nie dokończyć.
  const pending = new Map();
  for (let i = 0; i < frames.MAX_PENDING_MESSAGES * 4; i++) {
    const [first] = frames.toFrames(losowe(200 * 1024));
    frames.collect(pending, first);
  }
  assert.ok(pending.size <= frames.MAX_PENDING_MESSAGES, 'liczba rozgrzebanych wiadomości jest ograniczona');
});

test('asBytes przepuszcza tylko dane binarne', () => {
  assert.ok(frames.asBytes(new Uint8Array([1])) instanceof Uint8Array);
  assert.ok(frames.asBytes(new ArrayBuffer(4)) instanceof Uint8Array);
  assert.equal(frames.asBytes('tekst'), null);
  assert.equal(frames.asBytes({}), null);
});
