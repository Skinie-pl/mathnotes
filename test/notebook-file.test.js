'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const nf = require('../notebook-file.js');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mathnotes-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(p) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

test('zapis tworzy plik z poprawnym JSON-em i nie zostawia .tmp', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'notatnik.json');

  const result = await nf.saveNotebook(file, { version: 2, strokes: [] });

  assert.equal(result.path, file);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 2, strokes: [] });
  assert.equal(await exists(nf.tmpPathFor(file)), false, 'plik .tmp musi zniknąć');
  assert.equal(await exists(nf.backupPathFor(file)), false, 'pierwszy zapis nie ma czego backupować');
});

test('kolejny zapis przenosi poprzednią wersję do .bak', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'notatnik.json');

  await nf.saveNotebook(file, { version: 2, tag: 'pierwszy' });
  await nf.saveNotebook(file, { version: 2, tag: 'drugi' });

  assert.deepEqual(await nf.readNotebook(file), { version: 2, tag: 'drugi' });
  assert.deepEqual(JSON.parse(await fs.readFile(nf.backupPathFor(file), 'utf8')), {
    version: 2,
    tag: 'pierwszy',
  });

  // .bak trzyma dokładnie jedną wersję wstecz, nie historię.
  await nf.saveNotebook(file, { version: 2, tag: 'trzeci' });
  assert.deepEqual(JSON.parse(await fs.readFile(nf.backupPathFor(file), 'utf8')), {
    version: 2,
    tag: 'drugi',
  });
});

test('odczyt zwraca to, co zapisano', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'notatnik.json');
  const state = {
    version: 2,
    meta: { title: 'Całki — ćwiczenia' },
    strokes: [{ id: 'a1', tool: 'pen', color: '#ffffff', size: 2, brush: 'round', pts: [1.5, 2.5, 0.8] }],
    images: [],
  };

  await nf.saveNotebook(file, state);

  assert.deepEqual(await nf.readNotebook(file), state);
});

test('nieudany zapis nie rusza pliku docelowego i sprząta .tmp', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'notatnik.json');

  await nf.saveNotebook(file, { version: 2, tag: 'dobry' });

  // Katalog w miejscu .bak wywala copyFile już po zapisaniu .tmp.
  await fs.mkdir(nf.backupPathFor(file));

  await assert.rejects(nf.saveNotebook(file, { version: 2, tag: 'zly' }), { code: 'WRITE_FAILED' });

  assert.deepEqual(await nf.readNotebook(file), { version: 2, tag: 'dobry' }, 'plik docelowy bez zmian');
  assert.equal(await exists(nf.tmpPathFor(file)), false, 'plik .tmp musi zostać posprzątany');
});

test('zapis odrzuca złe argumenty, zanim dotknie dysku', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'notatnik.json');

  await assert.rejects(nf.saveNotebook('notatnik.json', {}), { code: 'BAD_PATH' });
  await assert.rejects(nf.saveNotebook('', {}), { code: 'BAD_PATH' });
  await assert.rejects(nf.saveNotebook(file, null), { code: 'BAD_STATE' });
  await assert.rejects(nf.saveNotebook(file, [1, 2, 3]), { code: 'BAD_STATE' });
  await assert.rejects(nf.saveNotebook(file, { n: 1n }), { code: 'BAD_STATE' });

  assert.equal(await exists(file), false);
  assert.equal(await exists(nf.tmpPathFor(file)), false);
});

test('odczyt odrzuca uszkodzone i nie-obiektowe pliki', async (t) => {
  const dir = await tempDir(t);

  const broken = path.join(dir, 'uszkodzony.json');
  await fs.writeFile(broken, '{"version": 2, ');
  await assert.rejects(nf.readNotebook(broken), { code: 'INVALID_JSON' });

  const arrayRoot = path.join(dir, 'tablica.json');
  await fs.writeFile(arrayRoot, '[1,2,3]');
  await assert.rejects(nf.readNotebook(arrayRoot), { code: 'INVALID_JSON' });

  await assert.rejects(nf.readNotebook(path.join(dir, 'nie-ma.json')), { code: 'READ_FAILED' });
  await assert.rejects(nf.readNotebook(dir), { code: 'READ_FAILED' });
});

test('odczyt odrzuca plik ponad limitem rozmiaru', async (t) => {
  const dir = await tempDir(t);
  const huge = path.join(dir, 'ogromny.json');

  // Rzadki plik: rozmiar w metadanych rośnie, miejsce na dysku nie.
  const handle = await fs.open(huge, 'w');
  await handle.truncate(nf.MAX_FILE_BYTES + 1);
  await handle.close();

  await assert.rejects(nf.readNotebook(huge), { code: 'TOO_LARGE' });
});
