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

const TMP_SUFFIX = '.tmp';
const BAK_SUFFIX = '.bak';

// Powyżej tego rozmiaru JSON.parse i tak padłby na limicie długości stringa
// w V8 — lepszy czytelny błąd niż OOM.
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

  try {
    let handle;
    try {
      handle = await fs.open(tmpPath, 'w');
      await handle.writeFile(json, 'utf8');
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

  return { path: filePath, bytes: Buffer.byteLength(json, 'utf8') };
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

  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new NotebookFileError('READ_FAILED', 'Nie udało się odczytać pliku: ' + filePath, err);
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
  TMP_SUFFIX,
  BAK_SUFFIX,
  MAX_FILE_BYTES,
  tmpPathFor,
  backupPathFor,
  saveNotebook,
  readNotebook,
};
