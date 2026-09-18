'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = require('../renderer/core.js');
const nf = require('../notebook-file.js');

function stroke(overrides) {
  return {
    id: 'a1',
    tool: 'pen',
    brush: 'pen',
    color: '#ffffff',
    size: 4,
    pressureEnabled: false,
    pts: [10, 10, 0.5, 20, 20, 0.5],
    ...overrides,
  };
}

function image(overrides) {
  return {
    id: 'img1',
    x: 10,
    y: 10,
    w: 100,
    h: 50,
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    ...overrides,
  };
}

// ===========================================================================
// Tytuł i menu
// ===========================================================================

test('formatTitle: bez nazwy pokazuje "Nowy notatnik"', () => {
  assert.equal(core.formatTitle(null, false), 'MathNotes — Nowy notatnik');
  assert.equal(core.formatTitle('   ', false), 'MathNotes — Nowy notatnik');
});

test('formatTitle: niezapisane zmiany oznacza kropka na końcu', () => {
  assert.equal(core.formatTitle('algebra.json', false), 'MathNotes — algebra.json');
  assert.equal(core.formatTitle('algebra.json', true), 'MathNotes — algebra.json •');
});

test('MENU_ACTIONS: bez duplikatów, same stringi, zamrożone', () => {
  const actions = core.MENU_ACTIONS;
  assert.ok(Object.isFrozen(actions));
  assert.ok(actions.every((a) => typeof a === 'string' && a.includes(':')));
  assert.equal(new Set(actions).size, actions.length, 'duplikat akcji menu');
});

test('każda akcja menu ma handler w rendererze', () => {
  // main.js pilnuje, że pozycja menu wskazuje istniejącą akcję. To jest druga
  // połowa tej samej umowy: że po stronie renderera ktoś ją obsługuje.
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('const handlers = {');
  const end = source.indexOf('function dispatch');
  assert.ok(start > 0 && end > start, 'nie znaleziono mapy handlerów w renderer.js');

  const block = source.slice(start, end);
  const missing = core.MENU_ACTIONS.filter((action) => !block.includes("'" + action + "'"));
  assert.deepEqual(missing, [], 'akcje menu bez handlera');
});

// ===========================================================================
// Szerokość kreski — wspólna dla obu ścieżek renderowania
// ===========================================================================

test('widthAt nie zmienia się, gdy kreska rośnie o kolejne punkty', () => {
  // To jest test na błąd „linia skacze po puszczeniu pióra”. Miękki pędzel
  // narasta na starcie kreski — ale liczy to od indeksu OD POCZĄTKU, więc
  // dopisanie punktów na końcu nie może ruszyć niczego wstecz.
  const growing = stroke({ brush: 'soft', pressureEnabled: true, pts: [10, 10, 0.2, 20, 20, 0.6, 30, 30, 0.9] });
  const before = [0, 1, 2].map((i) => core.widthAt(growing, i));

  growing.pts.push(40, 40, 0.4, 50, 50, 0.1);
  const after = [0, 1, 2].map((i) => core.widthAt(growing, i));

  assert.deepEqual(after, before, 'szerokość istniejących punktów musi być niewrażliwa na dopisanie kolejnych');
});

test('nacisk działa dopiero po włączeniu', () => {
  const off = stroke({ pressureEnabled: false });
  assert.equal(core.widthFactor(off, 0.1, 0), 1);
  assert.equal(core.widthFactor(off, 1, 0), 1, 'wyłączony nacisk daje stałą grubość');

  const on = stroke({ pressureEnabled: true });
  assert.equal(core.widthFactor(on, 0, 0), core.PRESSURE_BASE + core.DEFAULT_PRESSURE * core.PRESSURE_RANGE);
  assert.equal(core.widthFactor(on, 1, 0), core.MAX_PRESSURE_FACTOR);
  assert.ok(core.widthFactor(on, 0.2, 0) < core.widthFactor(on, 0.8, 0));
  assert.ok(core.widthFactor(on, 0.01, 0) >= core.PRESSURE_BASE, 'kreska nie może zniknąć');
});

test('nacisk spoza zakresu jest przycinany, brak nacisku spada na wartość domyślną', () => {
  const on = stroke({ pressureEnabled: true });
  const fallback = core.widthFactor(on, core.DEFAULT_PRESSURE, 0);
  assert.equal(core.widthFactor(on, 5, 0), core.widthFactor(on, 1, 0));
  assert.equal(core.widthFactor(on, undefined, 0), fallback);
  assert.equal(core.widthFactor(on, NaN, 0), fallback);
  assert.equal(core.widthFactor(on, 0, 0), fallback, 'zero = urządzenie bez nacisku, nie zerowa kreska');
});

test('narastanie miękkiego pędzla dotyczy tylko jego i tylko początku kreski', () => {
  assert.equal(core.taperFactor(0), 1 / (core.TAPER_RAMP + 1));
  assert.equal(core.taperFactor(core.TAPER_RAMP), 1);
  assert.equal(core.taperFactor(999), 1);

  const soft = stroke({ brush: 'soft' });
  const hard = stroke({ brush: 'pen' });
  assert.ok(core.widthFactor(soft, 0.5, 0) < core.widthFactor(soft, 0.5, 99));
  assert.equal(core.widthFactor(hard, 0.5, 0), core.widthFactor(hard, 0.5, 99), 'zwykły pędzel nie narasta');
});

// ===========================================================================
// Wygładzanie i bboxy
// ===========================================================================

test('smoothPoint odrzuca próbki gęstsze niż próg i przyciąga do poprzedniej', () => {
  assert.deepEqual(core.smoothPoint(NaN, NaN, 5, 7), { x: 5, y: 7 }, 'pierwszy punkt wchodzi bez zmian');
  assert.equal(core.smoothPoint(0, 0, 0.5, 0), null, 'zbyt blisko poprzedniego');

  const smoothed = core.smoothPoint(0, 0, 10, 0);
  assert.ok(smoothed.x < 10 && smoothed.x > 0, 'punkt jest przyciągany do poprzedniego');
  assert.equal(smoothed.x, 10 * (1 - core.SMOOTHING));
});

test('strokeBounds dokłada margines na grubość, a miękkiemu pędzlowi także na poświatę', () => {
  const hard = stroke({ size: 10, pts: [100, 200, 0.5, 300, 400, 0.5] });
  const soft = stroke({ size: 10, brush: 'soft', pts: [100, 200, 0.5, 300, 400, 0.5] });

  const hardPad = core.maxWidth(hard) / 2 + 1;
  assert.equal(core.strokeBounds(hard).minX, 100 - hardPad);
  assert.ok(core.maxWidth(soft) > core.maxWidth(hard), 'poświata rozlewa się poza grubość');
  assert.equal(core.strokeBounds(stroke({ pts: [] })), null);
});

test('tileRange mapuje bbox na kafle w pionie', () => {
  const H = core.TILE_HEIGHT;
  assert.deepEqual(core.tileRange({ minX: 0, maxX: 1, minY: 10, maxY: 20 }), { first: 0, last: 0 });
  assert.deepEqual(core.tileRange({ minX: 0, maxX: 1, minY: H - 5, maxY: H + 5 }), { first: 0, last: 1 });
  assert.deepEqual(core.tileRange({ minX: 0, maxX: 1, minY: -6, maxY: 5 }), { first: 0, last: 0 });
});

test('boundsIntersect', () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  assert.equal(core.boundsIntersect(a, { minX: 5, minY: 5, maxX: 20, maxY: 20 }), true);
  assert.equal(core.boundsIntersect(a, { minX: 11, minY: 0, maxX: 20, maxY: 10 }), false);
  assert.equal(core.boundsIntersect(a, null), false);
});

// ===========================================================================
// Gumka
// ===========================================================================

function line(xs, y, extra) {
  const pts = [];
  for (const x of xs) pts.push(x, y, 0.5);
  return stroke({ size: 2, pts, ...extra });
}

const XS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];

test('promień gumki rośnie z grubością, ale w rozsądnych granicach', () => {
  assert.equal(core.eraserScreenRadius(1), 6, 'dolna granica');
  assert.equal(core.eraserScreenRadius(30), 28, 'górna granica');
  assert.ok(core.eraserScreenRadius(10) > core.eraserScreenRadius(4));
});

test('gumka nie rusza kreski, której nie dotyka', () => {
  assert.equal(core.eraseStroke(line(XS, 100), 600, 600, 15, 'object'), null);
  assert.equal(core.eraseStroke(line(XS, 100), 600, 600, 15, 'area'), null);
});

test('tryb "object" kasuje całą kreskę', () => {
  assert.deepEqual(core.eraseStroke(line(XS, 100), 75, 100, 15, 'object'), []);
});

test('tryb "area" wycina fragment i zostawia dwa kawałki', () => {
  const pieces = core.eraseStroke(line(XS, 100), 75, 100, 15, 'area');

  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[0].filter((_, i) => i % 3 === 0), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(pieces[1].filter((_, i) => i % 3 === 0), [100, 110, 120, 130, 140, 150]);
  assert.ok(pieces.every((p) => p.length % 3 === 0), 'kawałki są pełnymi trójkami');
});

test('gumka łapie długi odcinek, którego oba końce są poza okręgiem', () => {
  const longJump = stroke({ size: 2, pts: [0, 100, 0.5, 300, 100, 0.5] });
  assert.deepEqual(core.eraseStroke(longJump, 150, 100, 15, 'object'), []);
  // Po przecięciu zostają dwa pojedyncze punkty — okruchy, nie kreski.
  assert.deepEqual(core.eraseStroke(longJump, 150, 100, 15, 'area'), []);
});

test('gumka uwzględnia grubość kreski, nie tylko jej oś', () => {
  const thick = stroke({ size: 30, pts: [100, 100, 0.5, 200, 100, 0.5] });
  const thin = stroke({ size: 1, pts: [100, 100, 0.5, 200, 100, 0.5] });
  // Oś kreski leży na y=100. Środek gumki 18 px wyżej: gruba kreska sięga
  // tam swoją połową grubości (15 px + 6 px promienia), cienka nie.
  assert.deepEqual(core.eraseStroke(thick, 150, 82, 6, 'object'), []);
  assert.equal(core.eraseStroke(thin, 150, 82, 6, 'object'), null);
});

test('gumka sięga obrazu z marginesem własnego promienia', () => {
  const img = image({ x: 100, y: 100, w: 50, h: 40 });
  assert.equal(core.eraseHitsImage(img, 120, 120, 5), true, 'środek obrazu');
  assert.equal(core.eraseHitsImage(img, 96, 120, 5), true, 'tuż obok, w zasięgu promienia');
  assert.equal(core.eraseHitsImage(img, 80, 120, 5), false);
});

// ===========================================================================
// Walidacja
// ===========================================================================

test('validateStroke przepuszcza poprawną kreskę i zaokrągla wartości', () => {
  const ok = core.validateStroke(stroke({ pts: [10.06, 20.04, 0.123, 30, 40, 0.567] }));
  assert.deepEqual(ok.pts, [10.1, 20, 0.12, 30, 40, 0.57]);
  assert.equal(ok.pressureEnabled, false);
});

test('validateStroke wycina nieznane pola', () => {
  const ok = core.validateStroke({ ...stroke(), evil: 'payload', onload: 'x' });
  assert.deepEqual(
    Object.keys(ok).sort(),
    ['brush', 'color', 'id', 'pressureEnabled', 'pts', 'size', 'tool'],
  );
});

test('validateStroke odrzuca wszystko, co odstaje od formatu', () => {
  const bad = [
    null,
    'kreska',
    [],
    stroke({ id: '../../etc/passwd' }),
    stroke({ id: 'x'.repeat(65) }),
    stroke({ tool: 'laser' }),
    stroke({ brush: 'airbrush' }),
    stroke({ color: 'red' }),
    stroke({ color: '#fff' }),
    stroke({ size: 0 }),
    stroke({ size: 31 }),
    stroke({ size: NaN }),
    stroke({ pressureEnabled: 'tak' }),
    stroke({ pressureEnabled: undefined }),
    stroke({ pts: [] }),
    stroke({ pts: [1, 2, 0.5, 3] }),
    stroke({ pts: 'nie tablica' }),
    stroke({ pts: [NaN, 10, 0.5] }),
    stroke({ pts: [10, Infinity, 0.5] }),
    stroke({ pts: [core.MIN_WORLD_X - 1, 10, 0.5] }),
    stroke({ pts: [core.MAX_WORLD_X + 1, 10, 0.5] }),
    stroke({ pts: [10, core.MIN_WORLD_Y - 1, 0.5] }),
    stroke({ pts: [10, core.MAX_WORLD_Y + 1, 0.5] }),
    stroke({ pts: [10, 10, 1.5] }),
    stroke({ pts: [10, 10, '0.5'] }),
  ];
  for (const value of bad) {
    assert.equal(core.validateStroke(value), null, 'powinno odpaść: ' + JSON.stringify(value));
  }
});

test('validateStroke odrzuca kreskę ponad limitem punktów', () => {
  const tooMany = new Array((core.MAX_STROKE_POINTS + 1) * 3).fill(1);
  assert.equal(core.validateStroke(stroke({ pts: tooMany })), null);
});

test('validateImage przepuszcza png, jpeg i webp, odrzuca resztę', () => {
  for (const type of ['png', 'jpeg', 'webp']) {
    assert.ok(core.validateImage(image({ dataUrl: 'data:image/' + type + ';base64,AAAA' })), type);
  }
  const bad = [
    image({ dataUrl: 'data:image/svg+xml;base64,AAAA' }),
    image({ dataUrl: 'data:text/html;base64,AAAA' }),
    image({ dataUrl: 'javascript:alert(1)' }),
    image({ dataUrl: 'https://example.com/x.png' }),
    image({ dataUrl: 'data:image/png;base64,<script>' }),
    image({ dataUrl: 42 }),
    image({ w: 0 }),
    image({ h: -5 }),
    image({ x: core.MAX_WORLD_X - 10, w: 100 }),
    image({ id: 'zły id' }),
  ];
  for (const value of bad) {
    assert.equal(core.validateImage(value), null, 'powinno odpaść: ' + String(value.dataUrl).slice(0, 40));
  }
  assert.equal(core.validateImage(image({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(core.MAX_IMAGE_BYTES) })), null);
});

test('validateAnnotation czyści etykietę i pilnuje granic', () => {
  const ok = core.validateAnnotation({ id: 'a1', y: 123.46, label: '  Całki​ oznaczone  ' });
  assert.deepEqual(ok, { id: 'a1', y: 123.5, label: 'Całki oznaczone' });

  assert.equal(core.validateAnnotation({ id: 'a1', y: 0, label: '' }).label, 'Bez nazwy');
  assert.equal(core.validateAnnotation({ id: 'a1', y: 0, label: 'x'.repeat(500) }).label.length, core.MAX_LABEL_LENGTH);
  assert.equal(core.validateAnnotation({ id: 'zły id', y: 0 }), null);
  assert.equal(core.validateAnnotation({ id: 'a1', y: NaN }), null);
  assert.equal(core.validateAnnotation({ id: 'a1', y: core.MAX_WORLD_Y + 1 }), null);
  assert.equal(core.validateAnnotation(null), null);
});

// ===========================================================================
// Format pliku i migracje
// ===========================================================================

test('createEmptyState ma bieżącą wersję formatu', () => {
  const empty = core.createEmptyState();
  assert.equal(empty.version, core.FILE_FORMAT_VERSION);
  assert.deepEqual(empty.strokes, []);
  assert.deepEqual(empty.images, []);
  assert.deepEqual(empty.annotations, []);
});

test('normalizeState przepuszcza poprawny plik w bieżącej wersji', () => {
  const { state, skipped } = core.normalizeState({
    version: core.FILE_FORMAT_VERSION,
    meta: { title: 'Całki' },
    strokes: [stroke()],
    images: [image()],
    annotations: [{ id: 'n1', y: 500, label: 'Rozdział 2' }],
  });

  assert.equal(state.version, core.FILE_FORMAT_VERSION);
  assert.equal(state.meta.title, 'Całki');
  assert.deepEqual(state.meta.grid, core.DEFAULT_GRID);
  assert.equal(state.strokes.length, 1);
  assert.equal(state.images.length, 1);
  assert.equal(state.annotations.length, 1);
  assert.deepEqual(skipped, { strokes: 0, images: 0, annotations: 0 });
});

test('normalizeState wczytuje plik z MathNotes 1.0, który nie ma numeru wersji', () => {
  // Dokładny kształt zapisywany przez poprzednią wersję programu: punkty jako
  // obiekty {x, y, p}, grubość jako `width`, obrazy jako `width`/`height`.
  const { state, skipped } = core.normalizeState({
    strokes: [
      {
        id: 'abc_123',
        tool: 'pen',
        brush: 'soft',
        color: '#ff5c5c',
        width: 6,
        pressureEnabled: true,
        points: [
          { x: 1, y: 2, p: 0.4 },
          { x: 3, y: 4, p: 0.8 },
        ],
      },
    ],
    images: [{ id: 'i1', dataUrl: 'data:image/png;base64,AAAA', x: 5, y: 6, width: 80, height: 60 }],
    annotations: [{ id: 'n1', y: 300, label: 'Zadanie 4' }],
  });

  assert.equal(state.version, core.FILE_FORMAT_VERSION);
  assert.deepEqual(skipped, { strokes: 0, images: 0, annotations: 0 });

  const migrated = state.strokes[0];
  assert.deepEqual(migrated.pts, [1, 2, 0.4, 3, 4, 0.8]);
  assert.equal(migrated.size, 6, 'width przechodzi na size');
  assert.equal(migrated.brush, 'soft');
  assert.equal(migrated.pressureEnabled, true);
  assert.equal('points' in migrated, false, 'stare pole nie może przeżyć migracji');
  assert.equal('width' in migrated, false);

  assert.equal(state.images[0].w, 80, 'width przechodzi na w');
  assert.equal(state.images[0].h, 60);
  assert.equal(state.annotations[0].label, 'Zadanie 4');
});

test('migracja z 1.0 uzupełnia pola, których stare pliki mogły nie mieć', () => {
  const { state } = core.normalizeState({
    strokes: [{ id: 'a1', color: '#ffffff', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
  });

  const migrated = state.strokes[0];
  assert.equal(migrated.tool, 'pen');
  assert.equal(migrated.brush, 'pen');
  assert.equal(migrated.size, 4, 'domyślna grubość');
  assert.equal(migrated.pressureEnabled, false);
  assert.deepEqual(migrated.pts, [1, 2, core.DEFAULT_PRESSURE, 3, 4, core.DEFAULT_PRESSURE]);
});

test('normalizeState migruje v2 przez v3 aż do bieżącej wersji', () => {
  const { state } = core.normalizeState({
    version: 2,
    meta: { title: 'stary', background: 'grid' },
    strokes: [stroke({ id: 'z9' })],
  });

  assert.equal(state.version, core.FILE_FORMAT_VERSION);
  assert.equal(state.meta.title, 'stary');
  assert.equal('background' in state.meta, false, 'stare tło strony zniknęło z formatu');
  assert.deepEqual(state.meta.grid, core.DEFAULT_GRID, 'v3 → v4 dokłada ustawienia kratki');
  assert.deepEqual(state.annotations, []);
  assert.equal(state.strokes[0].id, 'z9');
});

test('ustawienia kratki przechodzą przez walidację i round-trip', () => {
  const { state } = core.normalizeState({
    version: core.FILE_FORMAT_VERSION,
    meta: { title: '', grid: { enabled: true, color: '#5CD6A0', opacity: 0.42 } },
  });
  assert.deepEqual(state.meta.grid, { enabled: true, color: '#5CD6A0', opacity: 0.42 });

  // Wartości spoza zakresu dostają bezpieczne zastępniki, nie wywalają pliku.
  assert.deepEqual(core.validateGrid({ enabled: 'tak', color: 'zielony', opacity: 9 }), {
    enabled: false,
    color: core.DEFAULT_GRID.color,
    opacity: 1,
  });
  assert.equal(core.validateGrid({ opacity: 0 }).opacity, 0.02, 'zerowa przezroczystość byłaby niewidoczna');
  assert.deepEqual(core.validateGrid(null), core.DEFAULT_GRID);
});

test('normalizeState odmawia otwarcia pliku z przyszłości', () => {
  assert.throws(() => core.normalizeState({ version: core.FILE_FORMAT_VERSION + 1 }), {
    code: 'UNSUPPORTED_VERSION',
  });
  assert.throws(() => core.normalizeState({ version: 0 }), { code: 'INVALID_STATE' });
  assert.throws(() => core.normalizeState(null), { code: 'INVALID_STATE' });
  assert.throws(() => core.normalizeState([]), { code: 'INVALID_STATE' });
});

test('normalizeState pomija uszkodzone elementy i mówi ile', () => {
  const { state, skipped } = core.normalizeState({
    version: 3,
    strokes: [stroke(), stroke({ color: 'czerwony' }), null],
    images: [image(), image({ dataUrl: 'javascript:alert(1)' })],
    annotations: [{ id: 'n1', y: 10, label: 'ok' }, { id: 'n2', y: 'nie liczba' }],
  });

  assert.equal(state.strokes.length, 1);
  assert.equal(state.images.length, 1);
  assert.equal(state.annotations.length, 1);
  assert.deepEqual(skipped, { strokes: 2, images: 1, annotations: 1 });
});

test('normalizeState nie wpuszcza więcej obrazów niż limit', () => {
  const images = [];
  for (let i = 0; i < core.MAX_IMAGES + 5; i++) images.push(image({ id: 'img' + i }));
  const { state, skipped } = core.normalizeState({ version: 3, images });
  assert.equal(state.images.length, core.MAX_IMAGES);
  assert.equal(skipped.images, 5);
});

test('format przeżywa zapis na dysk i odczyt', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mathnotes-core-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notatnik.json');

  const { state } = core.normalizeState({
    version: 3,
    meta: { title: 'Ćwiczenia — całki' },
    strokes: [stroke(), stroke({ id: 'b2', brush: 'soft', color: '#ffd75c', size: 12, pressureEnabled: true })],
    images: [image()],
    annotations: [{ id: 'n1', y: 700, label: 'Rozdział 3' }],
  });

  await nf.saveNotebook(file, state);
  const { state: reloaded, skipped } = core.normalizeState(await nf.readNotebook(file));

  assert.deepEqual(reloaded, state, 'round-trip nie może zgubić ani zmienić niczego');
  assert.deepEqual(skipped, { strokes: 0, images: 0, annotations: 0 });
});

// ===========================================================================
// Kratka, motyw i przekształcenia zaznaczenia
// ===========================================================================

test('rozstaw kratki trzyma się czytelnego zakresu na ekranie', () => {
  // Przy każdym powiększeniu oczko ma sensowny rozmiar w pikselach: nie zlewa
  // się w szarość i nie rozjeżdża na pół ekranu.
  for (const scale of [0.1, 0.32, 0.5, 1, 2, 4, 12, 20]) {
    const { minor, major } = core.gridStep(scale);
    const onScreen = minor * scale;
    assert.ok(onScreen >= core.GRID_MIN_SCREEN, 'za gęsto przy skali ' + scale + ': ' + onScreen);
    assert.ok(onScreen < core.GRID_MIN_SCREEN * core.GRID_DIVISIONS, 'za rzadko przy skali ' + scale);
    assert.equal(major, minor * core.GRID_DIVISIONS);
  }
});

test('przybliżanie wprowadza drobniejsze oczka, oddalanie je zabiera', () => {
  const daleko = core.gridStep(0.2).minor;
  const blisko = core.gridStep(5).minor;
  assert.ok(blisko < daleko, 'po przybliżeniu krok musi zmaleć');
});

test('tryb biały odwraca skrajne szarości, a kolory zostawia', () => {
  assert.equal(core.themeInk('#ffffff', 'light'), '#000000');
  assert.equal(core.themeInk('#eeeeee', 'light'), '#111111');
  assert.equal(core.themeInk('#ff5c5c', 'light'), '#ff5c5c', 'nasycony kolor czyta się na obu tłach');
  assert.equal(core.themeInk('#ffffff', 'dark'), '#ffffff', 'w ciemnym motywie nic nie ruszamy');
});

test('transformStroke przesuwa, skaluje i pilnuje granic grubości', () => {
  const s = stroke({ size: 4, pts: [100, 100, 0.5, 200, 200, 0.5] });

  const moved = core.transformStroke(s, { ox: 0, oy: 0, k: 1, dx: 10, dy: -20 });
  assert.deepEqual(moved.pts, [110, 80, 0.5, 210, 180, 0.5]);
  assert.equal(moved.size, 4, 'samo przesunięcie nie zmienia grubości');

  const scaled = core.transformStroke(s, { ox: 100, oy: 100, k: 2, dx: 0, dy: 0 });
  assert.deepEqual(scaled.pts, [100, 100, 0.5, 300, 300, 0.5]);
  assert.equal(scaled.size, 8);

  const huge = core.transformStroke(s, { ox: 0, oy: 0, k: 100, dx: 0, dy: 0 });
  assert.equal(huge.size, core.MAX_STROKE_SIZE, 'grubość nie ucieka poza format');
});

test('transformImage skaluje prostokąt względem punktu zaczepienia', () => {
  const box = core.transformImage({ x: 100, y: 100, w: 40, h: 20 }, { ox: 100, oy: 100, k: 2, dx: 0, dy: 0 });
  assert.deepEqual(box, { x: 100, y: 100, w: 80, h: 40 });
});

test('unionBounds i transformBounds', () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const b = { minX: 20, minY: -5, maxX: 30, maxY: 5 };
  assert.deepEqual(core.unionBounds([a, null, b]), { minX: 0, minY: -5, maxX: 30, maxY: 10 });
  assert.equal(core.unionBounds([]), null);

  const moved = core.transformBounds(a, { ox: 0, oy: 0, k: 2, dx: 5, dy: 0 });
  assert.deepEqual(moved, { minX: 5, minY: 0, maxX: 25, maxY: 20 });
});

test('wklejany obraz mieści się w kartce niezależnie od powiększenia', () => {
  // To był powód, dla którego wklejanie potrafiło nic nie robić: obraz liczony
  // względem ekranu wychodził przy oddaleniu szerszy niż kartka i odpadał
  // na walidacji granic.
  for (const [w, h] of [[2560, 1440], [300, 200], [100, 4000]]) {
    for (const center of [{ x: 0, y: 0 }, { x: 450, y: 900 }, { x: 5000, y: 5000 }]) {
      const box = core.fitImageIntoPage(w, h, center.x, center.y, 0.7);
      const image = core.validateImage({
        id: 'i1',
        ...box,
        dataUrl: 'data:image/png;base64,AAAA',
      });
      assert.ok(image, 'obraz ' + w + 'x' + h + ' przy środku ' + JSON.stringify(center) + ' musi przejść walidację');
      assert.ok(Math.abs(box.w / box.h - w / h) < 0.02, 'proporcje zachowane');
    }
  }
});

// --- Strony wczytanego PDF-a -------------------------------------------------

test('layoutPdfPages układa strony w pionie, wyśrodkowane, z marginesem po bokach', () => {
  const layout = core.layoutPdfPages([
    { width: 595, height: 842 }, // A4 pionowo
    { width: 842, height: 595 }, // A4 poziomo
  ]);

  assert.equal(layout.length, 2);
  for (const box of layout) {
    assert.equal(box.w, core.PDF_PAGE_WIDTH, 'strona jest węższa niż pole robocze');
    assert.ok(box.x > 0, 'z lewej zostaje margines na notatki');
    assert.equal(
      core.PAGE_WIDTH - (box.x + box.w),
      box.x,
      'margines z prawej jest taki sam jak z lewej — strona jest wyśrodkowana',
    );
  }
  // Proporcje muszą zostać zachowane, inaczej tekst byłby rozciągnięty.
  assert.ok(Math.abs(layout[0].h - core.PDF_PAGE_WIDTH * (842 / 595)) < 1);
  assert.ok(Math.abs(layout[1].h - core.PDF_PAGE_WIDTH * (595 / 842)) < 1);
  assert.equal(layout[0].y, 0);
  assert.equal(layout[1].y, layout[0].h + core.PDF_PAGE_GAP, 'druga strona zaczyna się pod pierwszą');
});

test('margines obok strony PDF-a mieści się w polu roboczym, więc da się po nim pisać', () => {
  const [strona] = core.layoutPdfPages([{ width: 595, height: 842 }]);
  // Punkt w pasku po lewej stronie kartki PDF-a musi być legalnym miejscem na atrament.
  assert.ok(core.pointInPage(strona.x / 2, 100), 'lewy margines jest do pisania');
  assert.ok(core.pointInPage(strona.x + strona.w + strona.x / 2, 100), 'prawy margines też');
});

test('layoutPdfPages zaczyna od podanej wysokości, żeby nie przykryć notatek', () => {
  const layout = core.layoutPdfPages([{ width: 100, height: 100 }], 5000);
  assert.equal(layout[0].y, 5000);
});

test('layoutPdfPages odrzuca bzdurne rozmiary, zamiast liczyć NaN', () => {
  assert.equal(core.layoutPdfPages([]), null);
  assert.equal(core.layoutPdfPages(null), null);
  assert.equal(core.layoutPdfPages([{ width: 0, height: 100 }]), null);
  assert.equal(core.layoutPdfPages([{ width: 100, height: -1 }]), null);
  assert.equal(core.layoutPdfPages([{ width: Number.NaN, height: 100 }]), null);
  assert.equal(core.layoutPdfPages([{ width: 100, height: 100 }], -1), null);
});

test('layoutPdfPages urywa się na dole świata zamiast kłaść strony poza nim', () => {
  const duzo = new Array(core.MAX_PDF_PAGES).fill({ width: 10, height: 10000 });
  const layout = core.layoutPdfPages(duzo);
  assert.ok(layout.length < duzo.length, 'nie wszystkie strony się mieszczą');
  for (const box of layout) {
    assert.ok(box.y + box.h <= core.MAX_WORLD_Y, 'żadna strona nie wystaje poza świat');
  }
});

test('obraz jest zablokowany tylko wtedy, gdy jawnie tak powiedziano', () => {
  const dataUrl = 'data:image/png;base64,aGVsbG8=';
  const base = { id: 'a1', x: 0, y: 0, w: 10, h: 10, dataUrl };

  assert.equal(core.validateImage(base).locked, false, 'domyślnie obraz jest ruchomy');
  assert.equal(core.validateImage({ ...base, locked: true }).locked, true);
  // Wartości „prawdziwe inaczej” nie mogą zamrozić obrazu przez przypadek.
  assert.equal(core.validateImage({ ...base, locked: 'tak' }).locked, false);
  assert.equal(core.validateImage({ ...base, locked: 1 }).locked, false);
});

test('pliki sprzed wersji 5 dostają ruchome obrazy, a nie zamrożone tło', () => {
  const stary = {
    version: 4,
    meta: { title: 'Stary' },
    strokes: [],
    images: [{ id: 'i1', x: 0, y: 0, w: 10, h: 10, dataUrl: 'data:image/png;base64,aGVsbG8=' }],
    annotations: [],
  };
  const { state } = core.normalizeState(stary);
  assert.equal(state.version, core.FILE_FORMAT_VERSION);
  assert.equal(state.images[0].locked, false, 'ręcznie wklejony obraz zostaje ruchomy');
});
