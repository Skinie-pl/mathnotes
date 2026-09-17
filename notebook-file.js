'use strict';

// Atomowy zapis notatnika. Bezpieczeństwo danych użytkownika jest ważniejsze
// niż uproszczenie kodu — nigdy writeFileSync wprost na plik docelowy.
//
// Kolejność zapisu:
//   1. pełny zapis do <plik>.tmp + fsync  — dane są na dysku, plik docelowy nietknięty
//   2. kopia dotychczasowego <plik> do <plik>.bak
//   3. atomowy rename <plik>.tmp → <plik>
//   4. fsync katalogu, żeby sam rename też był trwały
//
// Krok 2 jest kopią, nie rename'em: dzięki temu plik docelowy istnieje
// nieprzerwanie aż do atomowej podmiany w kroku 3.

const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Notatnik to w większości tablice liczb i base64 obrazów — jedno i drugie
// pakuje się kilkukrotnie. Plik nadal nazywa się .json i nadal zawiera
// wersjonowany JSON, tylko spakowany; starsze, nieskompresowane notatniki
// czytają się dalej bez żadnej migracji.
const GZIP_MAGIC = [0x1f, 0x8b];

function isGzip(buffer) {
  return buffer.length >= 2 && buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1];
}

const TMP_SUFFIX = '.tmp';
const BAK_SUFFIX = '.bak';

// Powyżej tego rozmiaru JSON.parse i tak padłby na limicie długości stringa
// w V8 — lepszy czytelny błąd niż OOM. Dotyczy tekstu PO rozpakowaniu, bo to
// on trafia do pamięci; skompresowany plik bywa wielokrotnie mniejszy.
const MAX_FILE_BYTES = 256 * 1024 * 1024;

class NotebookFileError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NotebookFileError';
    this.code = code;
  }
}

function tmpPathFor(filePath) {
  return filePath + TMP_SUFFIX;
}

function backupPathFor(filePath) {
  return filePath + BAK_SUFFIX;
}

// Ścieżki pochodzą wyłącznie z natywnych dialogów albo z listy ostatnich plików,
// ale sprawdzamy je i tak — to granica zaufania.
function assertPath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new NotebookFileError('BAD_PATH', 'Ścieżka pliku musi być niepustym tekstem.');
  }
  if (!path.isAbsolute(filePath)) {
    throw new NotebookFileError('BAD_PATH', 'Ścieżka pliku musi być bezwzględna: ' + filePath);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Trwałość samego rename'u wymaga fsync katalogu. Best-effort: nieudany
// fsync katalogu nie unieważnia zapisu, który już się powiódł.
async function syncDirectory(dirPath) {
  if (process.platform === 'win32') return; // Windows nie pozwala otworzyć katalogu
  let handle;
  try {
    handle = await fs.open(dirPath, 'r');
    await handle.sync();
  } catch {
    // ignorujemy
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeQuietly(filePath) {
  await fs.rm(filePath, { force: true }).catch(() => {});
}

/**
 * Zapisuje stan notatnika atomowo, zostawiając poprzednią wersję w <plik>.bak.
 * @param {string} filePath bezwzględna ścieżka pliku docelowego
 * @param {object} state stan do serializacji (kształt pilnuje core.js)
 */
async function saveNotebook(filePath, state) {
  assertPath(filePath);
  if (!isPlainObject(state)) {
    throw new NotebookFileError('BAD_STATE', 'Stan notatnika musi być obiektem.');
  }

  let json;
  try {
    // Zapis kompaktowy, nie wcięty: przy dokumencie z dziesiątkami tysięcy
    // kresek wcięcie na każdą liczbę w `pts` potroiłoby rozmiar pliku.
    json = JSON.stringify(state);
  } catch (err) {
    throw new NotebookFileError('BAD_STATE', 'Stanu notatnika nie da się zserializować do JSON.', err);
  }
  if (json === undefined) {
    throw new NotebookFileError('BAD_STATE', 'Stanu notatnika nie da się zserializować do JSON.');
  }

  const tmpPath = tmpPathFor(filePath);
  const bakPath = backupPathFor(filePath);

  const payload = await gzip(Buffer.from(json, 'utf8'));

  try {
    let handle;
    try {
      handle = await fs.open(tmpPath, 'w');
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle?.close();
    }

    try {
      await fs.copyFile(filePath, bakPath);
    } catch (err) {
      // Pierwszy zapis do nowej ścieżki — nie ma czego backupować.
      if (err.code !== 'ENOENT') throw err;
    }

    await fs.rename(tmpPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (err) {
    await removeQuietly(tmpPath); // nie zostawiamy śmiecia po nieudanym zapisie
    throw new NotebookFileError('WRITE_FAILED', 'Nie udało się zapisać pliku: ' + filePath, err);
  }

  return { path: filePath, bytes: payload.length, rawBytes: Buffer.byteLength(json, 'utf8') };
}

/**
 * Wczytuje notatnik z dysku. Zwraca surowy obiekt JSON — migracje wersji
 * i walidacja kształtu to zadanie normalizeState w core.js.
 * @param {string} filePath bezwzględna ścieżka pliku
 */
async function readNotebook(filePath) {
  assertPath(filePath);

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (err) {
    throw new NotebookFileError('READ_FAILED', 'Nie udało się otworzyć pliku: ' + filePath, err);
  }
  if (!stats.isFile()) {
    throw new NotebookFileError('READ_FAILED', 'To nie jest plik: ' + filePath);
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new NotebookFileError('TOO_LARGE', 'Plik jest za duży, żeby go wczytać: ' + filePath);
  }

  let raw;
  try {
    raw = await fs.readFile(filePath);
  } catch (err) {
    throw new NotebookFileError('READ_FAILED', 'Nie udało się odczytać pliku: ' + filePath, err);
  }

  let text;
  if (isGzip(raw)) {
    try {
      // maxOutputLength chroni przed bombą zipową: mały plik nie może rozwinąć
      // się do gigabajtów w pamięci procesu głównego.
      text = (await gunzip(raw, { maxOutputLength: MAX_FILE_BYTES })).toString('utf8');
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new NotebookFileError('TOO_LARGE', 'Plik po rozpakowaniu jest za duży: ' + filePath);
      }
      throw new NotebookFileError('INVALID_JSON', 'Nie udało się rozpakować pliku: ' + filePath, err);
    }
  } else {
    text = raw.toString('utf8');
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new NotebookFileError('INVALID_JSON', 'Plik nie jest poprawnym JSON-em: ' + filePath, err);
  }
  if (!isPlainObject(value)) {
    throw new NotebookFileError('INVALID_JSON', 'Plik nie zawiera obiektu notatnika: ' + filePath);
  }

  return value;
}

module.exports = {
  NotebookFileError,
  isGzip,
  TMP_SUFFIX,
  BAK_SUFFIX,
  MAX_FILE_BYTES,
  tmpPathFor,
  backupPathFor,
  saveNotebook,
  readNotebook,
};
