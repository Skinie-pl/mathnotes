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
    brush: 'round',
    color: '#ffffff',
    size: 2,
    pts: [10, 10, 0.5, 20, 20, 0.5],
    ...overrides,
  };
}

// ===========================================================================
// Tytuł i menu
// ===========================================================================

test('formatTitle: bez nazwy pokazuje "Bez tytułu"', () => {
  assert.equal(core.formatTitle(null, false), 'Bez tytułu — MathNotes');
  assert.equal(core.formatTitle('', false), 'Bez tytułu — MathNotes');
  assert.equal(core.formatTitle('   ', false), 'Bez tytułu — MathNotes');
});

test('formatTitle: niezapisane zmiany oznacza kropka', () => {
  assert.equal(core.formatTitle('algebra', false), 'algebra — MathNotes');
  assert.equal(core.formatTitle('algebra', true), '• algebra — MathNotes');
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
  // Bez tego dodanie akcji dawałoby cichy komunikat „jeszcze niedostępne”.
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('const handlers = {');
  const end = source.indexOf('function dispatch');
  assert.ok(start > 0 && end > start, 'nie znaleziono mapy handlerów w renderer.js');

  const block = source.slice(start, end);
  const missing = core.MENU_ACTIONS.filter((action) => !block.includes("'" + action + "'"));
  assert.deepEqual(missing, [], 'akcje menu bez handlera');
});

// ===========================================================================
// widthFactor — wspólny dla obu ścieżek renderowania
// ===========================================================================

test('widthAt nie zmienia się, gdy kreska rośnie o kolejne punkty', () => {
  // To jest test na błąd „linia skacze po puszczeniu pióra”: gdyby szerokość
  // zależała od długości kreski albo odległości od jej końca, ścieżka
  // inkrementalna policzyłaby co innego niż kanoniczna.
  const growing = stroke({ pts: [10, 10, 0.2, 20, 20, 0.6, 30, 30, 0.9] });
  const before = [0, 1, 2].map((i) => core.widthAt(growing, i));

  growing.pts.push(40, 40, 0.4, 50, 50, 0.1);
  const after = [0, 1, 2].map((i) => core.widthAt(growing, i));

  assert.deepEqual(after, before, 'szerokość istniejących punktów musi być niewrażliwa na dopisanie kolejnych');
});

test('obie ścieżki renderowania liczą te same szerokości odcinków', () => {
  // Kanoniczna (drawStroke) przechodzi całą kreskę od zera. Inkrementalna
  // (drawLatestSegment) liczy tylko odcinki dorzucone od ostatniej klatki.
  // Jeśli te dwie listy się rozjadą, linia „skacze” po puszczeniu pióra.
  const pts = [10, 10, 0.2, 20, 22, 0.55, 33, 31, 0.9, 40, 44, 0.3, 55, 50, 0.15];
  const s = stroke({ pts: [] });

  const incremental = [];
  for (let i = 0; i < pts.length; i += 3) {
    const drawnUpTo = core.pointCount(s);
    s.pts.push(pts[i], pts[i + 1], pts[i + 2]);
    // Nowe odcinki: od ostatniego narysowanego punktu do końca.
    for (let seg = Math.max(0, drawnUpTo - 1); seg < core.pointCount(s) - 1; seg++) {
      incremental.push(core.segmentWidth(s, seg));
    }
  }

  const canonical = [];
  for (let seg = 0; seg < core.pointCount(s) - 1; seg++) canonical.push(core.segmentWidth(s, seg));

  assert.deepEqual(incremental, canonical);
  assert.equal(canonical.length, core.pointCount(s) - 1);
});

test('widthFactor: highlighter i pędzel "fine" mają stałą szerokość', () => {
  for (const pressure of [0, 0.1, 0.5, 1]) {
    assert.equal(core.widthFactor('highlighter', 'round', pressure), core.MAX_WIDTH_FACTOR);
    assert.equal(core.widthFactor('pen', 'fine', pressure), core.MAX_WIDTH_FACTOR);
  }
});

test('widthFactor: pędzel "round" rośnie z naciskiem i nigdy nie schodzi do zera', () => {
  const light = core.widthFactor('pen', 'round', 0.1);
  const heavy = core.widthFactor('pen', 'round', 1);
  assert.ok(light < heavy, 'mocniejszy nacisk = grubsza kreska');
  assert.ok(light >= core.MIN_WIDTH_FACTOR, 'kreska nie może zniknąć przy słabym nacisku');
  assert.equal(heavy, core.MAX_WIDTH_FACTOR);
});

test('widthFactor: brak nacisku od urządzenia spada na wartość domyślną', () => {
  const fallback = core.widthFactor('pen', 'round', core.DEFAULT_PRESSURE);
  assert.equal(core.widthFactor('pen', 'round', undefined), fallback);
  assert.equal(core.widthFactor('pen', 'round', NaN), fallback);
  assert.equal(core.widthFactor('pen', 'round', 0), fallback, 'zero = urządzenie bez nacisku, nie zerowa kreska');
});

test('widthFactor: nacisk spoza zakresu jest przycinany', () => {
  assert.equal(core.widthFactor('pen', 'round', 5), core.widthFactor('pen', 'round', 1));
  assert.equal(core.widthFactor('pen', 'round', -3), core.widthFactor('pen', 'round', core.DEFAULT_PRESSURE));
});

// ===========================================================================
// Wygładzanie i bboxy
// ===========================================================================

test('shouldKeepPoint odrzuca próbki bliżej niż próg', () => {
  assert.equal(core.shouldKeepPoint(0, 0, 0.1, 0.1), false);
  assert.equal(core.shouldKeepPoint(0, 0, 5, 0), true);
  assert.equal(core.shouldKeepPoint(0, 0, 3, 0, 10), false, 'próg da się nadpisać');
});

test('strokeBounds dokłada margines na grubość kreski', () => {
  const s = stroke({ size: 10, brush: 'fine', pts: [100, 200, 0.5, 300, 400, 0.5] });
  const b = core.strokeBounds(s);
  const pad = core.maxWidth(s) / 2 + 1;

  assert.equal(b.minX, 100 - pad);
  assert.equal(b.maxX, 300 + pad);
  assert.equal(b.minY, 200 - pad);
  assert.equal(b.maxY, 400 + pad);
  assert.equal(core.strokeBounds(stroke({ pts: [] })), null);
});

test('tileRange mapuje bbox na kafle w pionie', () => {
  const H = core.TILE_HEIGHT;
  assert.deepEqual(core.tileRange({ minX: 0, maxX: 1, minY: 10, maxY: 20 }), { first: 0, last: 0 });
  assert.deepEqual(core.tileRange({ minX: 0, maxX: 1, minY: H - 5, maxY: H + 5 }), { first: 0, last: 1 });
  // Margines bboxa może zejść nad górną krawędź strony — kafel ujemny nie istnieje.
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
  return stroke({ size: 2, brush: 'fine', pts, ...extra });
}

const XS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];

test('gumka nie rusza kreski, której nie dotyka', () => {
  assert.equal(core.eraseStroke(line(XS, 100), 600, 600, 15, 'whole'), null);
  assert.equal(core.eraseStroke(line(XS, 100), 600, 600, 15, 'split'), null);
});

test('gumka w trybie "whole" kasuje całą kreskę', () => {
  assert.deepEqual(core.eraseStroke(line(XS, 100), 75, 100, 15, 'whole'), []);
});

test('gumka w trybie "split" dzieli kreskę na dwa kawałki', () => {
  const pieces = core.eraseStroke(line(XS, 100), 75, 100, 15, 'split');

  assert.equal(pieces.length, 2);
  const left = pieces[0].filter((_, i) => i % 3 === 0);
  const right = pieces[1].filter((_, i) => i % 3 === 0);
  assert.deepEqual(left, [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(right, [100, 110, 120, 130, 140, 150]);
  // Nacisk jedzie razem z punktem, kawałki są pełnymi trójkami.
  assert.ok(pieces.every((p) => p.length % 3 === 0));
});

test('gumka łapie długi odcinek, którego oba końce są poza okręgiem', () => {
  const longJump = stroke({ size: 2, brush: 'fine', pts: [0, 100, 0.5, 300, 100, 0.5] });
  assert.deepEqual(core.eraseStroke(longJump, 150, 100, 15, 'whole'), []);
  // Po przecięciu zostają dwa pojedyncze punkty — okruchy, nie kreski.
  assert.deepEqual(core.eraseStroke(longJump, 150, 100, 15, 'split'), []);
});

test('gumka uwzględnia grubość kreski, nie tylko jej oś', () => {
  const thick = stroke({ size: 40, brush: 'fine', pts: [100, 100, 0.5, 200, 100, 0.5] });
  const thin = stroke({ size: 1, brush: 'fine', pts: [100, 100, 0.5, 200, 100, 0.5] });
  // Środek gumki 25 px nad osią: gruba kreska sięga, cienka nie.
  assert.deepEqual(core.eraseStroke(thick, 150, 75, 6, 'whole'), []);
  assert.equal(core.eraseStroke(thin, 150, 75, 6, 'whole'), null);
});

test('distanceToSegmentSquared radzi sobie z odcinkiem zerowej długości', () => {
  assert.equal(core.distanceToSegmentSquared(3, 4, 0, 0, 0, 0), 25);
  assert.equal(core.distanceToSegmentSquared(5, 5, 0, 0, 10, 0), 25);
});

// ===========================================================================
// Walidacja kresek
// ===========================================================================

test('validateStroke przepuszcza poprawną kreskę i zaokrągla wartości', () => {
  const ok = core.validateStroke(stroke({ pts: [10.06, 20.04, 0.123, 30, 40, 0.567] }));
  assert.deepEqual(ok.pts, [10.1, 20, 0.12, 30, 40, 0.57]);
});

test('validateStroke wycina nieznane pola', () => {
  const ok = core.validateStroke({ ...stroke(), evil: 'payload', onload: 'x' });
  assert.deepEqual(Object.keys(ok).sort(), ['brush', 'color', 'id', 'pts', 'size', 'tool']);
});

test('validateStroke odrzuca wszystko, co odstaje od formatu', () => {
  const bad = [
    null,
    'kreska',
    [],
    stroke({ id: '' }),
    stroke({ id: '../../etc/passwd' }),
    stroke({ id: 'x'.repeat(65) }),
    stroke({ tool: 'laser' }),
    stroke({ brush: 'airbrush' }),
    stroke({ color: 'red' }),
    stroke({ color: '#fff' }),
    stroke({ color: '#xxyyzz' }),
    stroke({ size: 0 }),
    stroke({ size: 1000 }),
    stroke({ size: NaN }),
    stroke({ pts: [] }),
    stroke({ pts: [1, 2] }),
    stroke({ pts: [1, 2, 0.5, 3] }),
    stroke({ pts: 'nie tablica' }),
    stroke({ pts: [NaN, 10, 0.5] }),
    stroke({ pts: [10, Infinity, 0.5] }),
    stroke({ pts: [-1, 10, 0.5] }),
    stroke({ pts: [core.PAGE_WIDTH + 1, 10, 0.5] }),
    stroke({ pts: [10, -1, 0.5] }),
    stroke({ pts: [10, core.MAX_PAGE_HEIGHT + 1, 0.5] }),
    stroke({ pts: [10, 10, 1.5] }),
    stroke({ pts: [10, 10, -0.1] }),
    stroke({ pts: [10, 10, '0.5'] }),
  ];
  for (const value of bad) {
    assert.equal(core.validateStroke(value), null, 'powinno odpaść: ' + JSON.stringify(value));
  }
});

test('validateStroke odrzuca kreskę ponad limitem punktów', () => {
  const tooMany = new Array((core.MAX_STROKE_POINTS + 1) * 3).fill(1);
  assert.equal(core.validateStroke(stroke({ pts: tooMany })), null);

  const atLimit = [];
  for (let i = 0; i < core.MAX_STROKE_POINTS; i++) atLimit.push(1, 1, 0.5);
  assert.ok(core.validateStroke(stroke({ pts: atLimit })), 'dokładnie na limicie ma przejść');
});

// ===========================================================================
// Walidacja obrazów
// ===========================================================================

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

test('validateImage przepuszcza png, jpeg i webp', () => {
  for (const type of ['png', 'jpeg', 'webp']) {
    const ok = core.validateImage(image({ dataUrl: 'data:image/' + type + ';base64,AAAA' }));
    assert.ok(ok, type + ' powinien przejść');
    assert.deepEqual(Object.keys(ok).sort(), ['dataUrl', 'h', 'id', 'w', 'x', 'y']);
  }
});

test('validateImage odrzuca inne schematy i typy', () => {
  const bad = [
    image({ dataUrl: 'data:image/svg+xml;base64,AAAA' }),
    image({ dataUrl: 'data:image/gif;base64,AAAA' }),
    image({ dataUrl: 'data:text/html;base64,AAAA' }),
    image({ dataUrl: 'javascript:alert(1)' }),
    image({ dataUrl: 'https://example.com/x.png' }),
    image({ dataUrl: 'data:image/png;base64,<script>' }),
    image({ dataUrl: 42 }),
    image({ w: 0 }),
    image({ h: -5 }),
    image({ x: -1 }),
    image({ x: core.PAGE_WIDTH - 10, w: 100 }),
    image({ id: 'zły id' }),
  ];
  for (const value of bad) {
    assert.equal(core.validateImage(value), null, 'powinno odpaść: ' + String(value.dataUrl).slice(0, 40));
  }
});

test('validateImage odrzuca obraz ponad limitem rozmiaru', () => {
  const prefix = 'data:image/png;base64,';
  const tooBig = prefix + 'A'.repeat(core.MAX_IMAGE_BYTES);
  assert.equal(core.validateImage(image({ dataUrl: tooBig })), null);
});

// ===========================================================================
// Format pliku i migracje
// ===========================================================================

test('createEmptyState ma bieżącą wersję formatu', () => {
  const empty = core.createEmptyState();
  assert.equal(empty.version, core.FILE_FORMAT_VERSION);
  assert.deepEqual(empty.strokes, []);
  assert.deepEqual(empty.images, []);
  assert.equal(empty.meta.background, 'plain');
});

test('normalizeState przepuszcza poprawny plik v2', () => {
  const { state, skipped } = core.normalizeState({
    version: 2,
    meta: { title: 'Całki', background: 'grid' },
    strokes: [stroke()],
    images: [image()],
  });

  assert.equal(state.version, 2);
  assert.equal(state.meta.title, 'Całki');
  assert.equal(state.meta.background, 'grid');
  assert.equal(state.strokes.length, 1);
  assert.equal(state.images.length, 1);
  assert.deepEqual(skipped, { strokes: 0, images: 0 });
});

test('normalizeState migruje v1: punkty-obiekty na płaskie pts', () => {
  const { state } = core.normalizeState({
    version: 1,
    meta: { title: 'stary' },
    strokes: [
      {
        id: 'a1',
        tool: 'pen',
        brush: 'round',
        color: '#ffffff',
        size: 2,
        points: [
          { x: 1, y: 2, pressure: 0.5 },
          { x: 3, y: 4, pressure: 0.6 },
        ],
      },
    ],
  });

  assert.equal(state.version, 2);
  assert.deepEqual(state.strokes[0].pts, [1, 2, 0.5, 3, 4, 0.6]);
  assert.equal('points' in state.strokes[0], false, 'stare pole nie może przeżyć migracji');
});

test('normalizeState: brak numeru wersji to najstarszy format', () => {
  const { state } = core.normalizeState({
    strokes: [
      { id: 'a1', tool: 'pen', brush: 'fine', color: '#00ff00', size: 3, points: [{ x: 5, y: 6 }, { x: 7, y: 8 }] },
    ],
  });

  assert.deepEqual(state.strokes[0].pts, [5, 6, core.DEFAULT_PRESSURE, 7, 8, core.DEFAULT_PRESSURE]);
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
    version: 2,
    strokes: [stroke(), stroke({ color: 'czerwony' }), null, stroke({ id: 'b2' })],
    images: [image(), image({ dataUrl: 'javascript:alert(1)' })],
  });

  assert.equal(state.strokes.length, 2);
  assert.equal(state.images.length, 1);
  assert.deepEqual(skipped, { strokes: 2, images: 1 });
});

test('normalizeState nie wpuszcza więcej obrazów niż limit', () => {
  const images = [];
  for (let i = 0; i < core.MAX_IMAGES + 5; i++) images.push(image({ id: 'img' + i }));

  const { state, skipped } = core.normalizeState({ version: 2, images });

  assert.equal(state.images.length, core.MAX_IMAGES);
  assert.equal(skipped.images, 5);
});

test('format przeżywa zapis na dysk i odczyt', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mathnotes-core-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notatnik.json');

  const { state } = core.normalizeState({
    version: 2,
    meta: { title: 'Ćwiczenia — całki', background: 'grid' },
    strokes: [stroke(), stroke({ id: 'b2', tool: 'highlighter', brush: 'fine', color: '#ffee00', size: 12 })],
    images: [image()],
  });

  await nf.saveNotebook(file, state);
  const { state: reloaded, skipped } = core.normalizeState(await nf.readNotebook(file));

  assert.deepEqual(reloaded, state, 'round-trip nie może zgubić ani zmienić niczego');
  assert.deepEqual(skipped, { strokes: 0, images: 0 });
});
