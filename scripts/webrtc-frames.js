'use strict';

// Dzielenie wiadomości na ramki dla kanału danych WebRTC.
//
// Kanał ma limit pojedynczej wiadomości (w Chromium ok. 256 kB), a simple-peer
// nie dzieli niczego — woła channel.send() wprost. y-webrtc wysyła całą
// aktualizację Yjs jako jedną wiadomość, więc wklejenie obrazu albo pierwsza
// synchronizacja notatnika z obrazami przekraczały limit: send rzucał wyjątkiem,
// kanał się zamykał i od tej chwili nie docierało już nic, w żadną stronę.
//
// Moduł jest CommonJS, bo wciąga go zarówno bundle (przez esbuild), jak i test.

const FRAME_WHOLE = 0;
const FRAME_PART = 1;
const FRAME_HEADER = 9; // znacznik + id (4) + numer ramki (2) + liczba ramek (2)
const MAX_PAYLOAD = 48 * 1024;

// Twarde granice składania. Druga strona jest niezaufana, więc niedokończone
// wiadomości nie mogą rosnąć w nieskończoność.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 8;

let nextMessageId = 1;

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** @returns {Uint8Array[]} ramki gotowe do wysłania */
function toFrames(bytes) {
  if (bytes.length + 1 <= MAX_PAYLOAD) {
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = FRAME_WHOLE;
    frame.set(bytes, 1);
    return [frame];
  }

  const total = Math.ceil(bytes.length / MAX_PAYLOAD);
  if (total > 0xffff) throw new Error('Wiadomość za duża, żeby ją podzielić na ramki.');
  const id = nextMessageId++ >>> 0;

  const frames = [];
  for (let index = 0; index < total; index++) {
    const chunk = bytes.subarray(index * MAX_PAYLOAD, (index + 1) * MAX_PAYLOAD);
    const frame = new Uint8Array(FRAME_HEADER + chunk.length);
    const view = new DataView(frame.buffer);
    frame[0] = FRAME_PART;
    view.setUint32(1, id, true);
    view.setUint16(5, index, true);
    view.setUint16(7, total, true);
    frame.set(chunk, FRAME_HEADER);
    frames.push(frame);
  }
  return frames;
}

/**
 * Składa ramkę w wiadomość.
 * @param {Map} pending stan składania dla jednego połączenia
 * @returns {Uint8Array|null} kompletna wiadomość albo null, gdy to dopiero kawałek
 */
function collect(pending, bytes) {
  if (bytes.length === 0) return bytes;
  if (bytes[0] === FRAME_WHOLE) return bytes.subarray(1);
  if (bytes[0] !== FRAME_PART || bytes.length < FRAME_HEADER) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = view.getUint32(1, true);
  const index = view.getUint16(5, true);
  const total = view.getUint16(7, true);
  if (total === 0 || index >= total) return null;

  let entry = pending.get(id);
  if (!entry) {
    // Najstarsze niedokończone wiadomości lecą za burtę, zanim zjedzą pamięć.
    while (pending.size >= MAX_PENDING_MESSAGES) pending.delete(pending.keys().next().value);
    entry = { total, parts: new Array(total), bytes: 0, got: 0 };
    pending.set(id, entry);
  }
  // Zmieniona liczba ramek albo powtórzony numer = nadawca kłamie; ignorujemy.
  if (entry.total !== total || entry.parts[index]) return null;

  entry.parts[index] = bytes.subarray(FRAME_HEADER);
  entry.bytes += bytes.length - FRAME_HEADER;
  entry.got += 1;

  if (entry.bytes > MAX_MESSAGE_BYTES) {
    pending.delete(id);
    return null;
  }
  if (entry.got < entry.total) return null;

  pending.delete(id);
  const out = new Uint8Array(entry.bytes);
  let offset = 0;
  for (const part of entry.parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Nakłada dzielenie i składanie na klasę simple-peer. */
function patchPeer(Peer) {
  if (Peer.prototype.__mnFramed) return Peer;
  const originalSend = Peer.prototype.send;
  const originalEmit = Peer.prototype.emit;

  Peer.prototype.send = function send(data) {
    const bytes = asBytes(data);
    if (bytes === null) return originalSend.call(this, data);
    for (const frame of toFrames(bytes)) originalSend.call(this, frame);
  };

  // Ramki składamy, zanim y-webrtc zobaczy zdarzenie 'data'.
  Peer.prototype.emit = function emit(event, ...args) {
    if (event !== 'data') return originalEmit.call(this, event, ...args);
    const bytes = asBytes(args[0]);
    if (bytes === null) return originalEmit.call(this, event, ...args);
    if (!this.__mnPending) this.__mnPending = new Map();
    const complete = collect(this.__mnPending, bytes);
    if (complete === null) return true; // to był kawałek, czekamy na resztę
    return originalEmit.call(this, 'data', complete);
  };

  Peer.prototype.__mnFramed = true;
  return Peer;
}

module.exports = {
  FRAME_HEADER,
  MAX_PAYLOAD,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_MESSAGES,
  asBytes,
  toFrames,
  collect,
  patchPeer,
};
