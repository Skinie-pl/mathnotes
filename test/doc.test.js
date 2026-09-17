'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../renderer/core.js');
const { NotebookDoc } = require('../renderer/doc.js');

// Bundle jest IIFE pod przeglądarkę i dokłada globalThis.Collab. Uruchamiamy go
// w tym samym realm co test — inaczej Yjs odrzucałby wartości zbudowane tutaj,
// bo porównuje konstruktory. Sprawdzenie, że bundle wystarcza sobie z samymi
// globalami przeglądarki, siedzi osobno w test/vendor-bundle.test.js.
function loadY() {
  if (!globalThis.Collab) {
    globalThis.window = globalThis.window || globalThis;
    globalThis.self = globalThis.self || globalThis;
    globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {} };
    const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'collab.bundle.js'), 'utf8');
    new Function(code)();
  }
  return globalThis.Collab.Y;
}

const Y = loadY();

// captureTimeout 0 sprawia, że każda transakcja to osobny krok cofania —
// bez tego szybkie testy zlewałyby się w jeden.
function makeDoc(options) {
  return new NotebookDoc(Y, { captureTimeout: 0, ...options });
}

function penStroke(overrides) {
  return {
    tool: 'pen',
    brush: 'pen',
    color: '#ffffff',
    size: 4,
    pressureEnabled: false,
    pts: [10, 10, 0.5],
    ...overrides,
  };
}

/** Dwukierunkowa synchronizacja jak w sesji online: cudze zmiany mają obcy origin. */
function connect(a, b) {
  const toB = (update, origin) => {
    if (origin !== 'remote') Y.applyUpdate(b.doc, update, 'remote');
  };
  const toA = (update, origin) => {
    if (origin !== 'remote') Y.applyUpdate(a.doc, update, 'remote');
  };
  a.doc.on('update', toB);
  b.doc.on('update', toA);
  return () => {
    a.doc.off('update', toB);
    b.doc.off('update', toA);
  };
}

function strokeIds(notebook) {
  const out = [];
  for (const map of notebook.strokes) out.push(map.get('id'));
  return out;
}

// ===========================================================================
// Schemat
// ===========================================================================

test('addStroke buduje Y.Map zgodny ze schematem, z pts jako Y.Array', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const map = notebook.addStroke(penStroke({ id: 'a1' }));

  assert.deepEqual(
    Object.keys(map.toJSON()).sort(),
    ['brush', 'color', 'id', 'pressureEnabled', 'pts', 'size', 'tool'],
  );
  assert.equal(map.get('id'), 'a1');
  assert.ok(map.get('pts') instanceof Y.Array, 'pts musi być Y.Array, nie zwykłą tablicą');
  assert.deepEqual(map.get('pts').toArray(), [10, 10, 0.5]);
  assert.equal(notebook.strokes.length, 1);
});

test('addStroke sam nadaje id, gdy go nie podano', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const first = notebook.addStroke(penStroke());
  const second = notebook.addStroke(penStroke());

  assert.match(first.get('id'), /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(first.get('id'), second.get('id'));
});

test('addStroke i addImage rzucają na danych spoza formatu', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  assert.throws(() => notebook.addStroke(penStroke({ color: 'czerwony' })), TypeError);
  assert.throws(() => notebook.addStroke(penStroke({ tool: 'laser' })), TypeError);
  assert.throws(() => notebook.addImage({ x: 0, y: 0, w: 10, h: 10, dataUrl: 'javascript:alert(1)' }), TypeError);
  assert.equal(notebook.strokes.length, 0);
});

// ===========================================================================
// Dosypywanie punktów
// ===========================================================================

test('appendPoints dokłada zaokrąglone punkty i mówi ile', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const map = notebook.addStroke(penStroke());
  const added = notebook.appendPoints(map, [20.06, 30.04, 0.123, 40, 50, 0.567]);

  assert.equal(added, 2);
  assert.deepEqual(map.get('pts').toArray(), [10, 10, 0.5, 20.1, 30, 0.12, 40, 50, 0.57]);
});

test('appendPoints pomija punkty spoza strony i niepełne trójki', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const map = notebook.addStroke(penStroke());

  assert.equal(notebook.appendPoints(map, [-5, 10, 0.5, core.PAGE_WIDTH + 10, 10, 0.5]), 0);
  assert.equal(notebook.appendPoints(map, [10, 20]), 0, 'niepełna trójka nie przechodzi');
  assert.equal(notebook.appendPoints(map, [NaN, 10, 0.5]), 0);
  assert.deepEqual(map.get('pts').toArray(), [10, 10, 0.5], 'kreska bez zmian');
});

test('appendPoints nie przekracza limitu punktów na kreskę', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const map = notebook.addStroke(penStroke());
  const flood = [];
  for (let i = 0; i < core.MAX_STROKE_POINTS; i++) flood.push(1, 1, 0.5);

  const added = notebook.appendPoints(map, flood);

  assert.equal(added, core.MAX_STROKE_POINTS - 1, 'zmieściło się dokładnie do limitu');
  assert.equal(map.get('pts').length / 3, core.MAX_STROKE_POINTS);
  assert.equal(notebook.appendPoints(map, [5, 5, 0.5]), 0, 'po limicie już nic nie wchodzi');
});

// ===========================================================================
// Gumka
// ===========================================================================

function horizontalLine(notebook, y) {
  const pts = [];
  for (let x = 0; x <= 150; x += 10) pts.push(x, y, 0.5);
  return notebook.addStroke(penStroke({ pts }));
}

test('eraseAt w trybie "object" usuwa kreskę z tablicy', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  horizontalLine(notebook, 100);
  const untouched = notebook.addStroke(penStroke({ pts: [500, 500, 0.5, 510, 510, 0.5] }));

  assert.equal(notebook.eraseAt(75, 100, 15, 'object'), 1);
  assert.deepEqual(strokeIds(notebook), [untouched.get('id')]);
});

test('eraseAt w trybie "area" podmienia kreskę na kawałki z nowymi id', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const original = horizontalLine(notebook, 100);
  const originalId = original.get('id');

  assert.equal(notebook.eraseAt(75, 100, 15, 'area'), 1);
  assert.equal(notebook.strokes.length, 2);

  const ids = strokeIds(notebook);
  assert.equal(ids.includes(originalId), false, 'kawałki dostają własne id');
  assert.equal(new Set(ids).size, 2);
  // Kawałki dziedziczą wygląd oryginału.
  assert.equal(notebook.strokes.get(0).get('color'), '#ffffff');
  assert.equal(notebook.strokes.get(0).get('brush'), 'pen');
});

test('kawałki po cięciu gumką zachowują wszystkie pola oryginału', (t) => {
  // Kawałek, któremu brakuje choćby jednego pola, nie przechodzi walidacji
  // i znika przy najbliższym renderowaniu albo zapisie — bez żadnego błędu.
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const pts = [];
  for (let x = 0; x <= 150; x += 10) pts.push(x, 100, 0.5);
  notebook.addStroke(penStroke({ brush: 'soft', color: '#ff5c5c', size: 9, pressureEnabled: true, pts }));

  assert.equal(notebook.eraseAt(75, 100, 12, 'area'), 1);
  assert.equal(notebook.strokes.length, 2);

  const { state, skipped } = notebook.toState();
  assert.equal(skipped.strokes, 0, 'żaden kawałek nie może odpaść na walidacji');
  assert.equal(state.strokes.length, 2);
  for (const piece of state.strokes) {
    assert.equal(piece.brush, 'soft');
    assert.equal(piece.color, '#ff5c5c');
    assert.equal(piece.size, 9);
    assert.equal(piece.pressureEnabled, true);
  }
});

test('eraseAt odsiewa kreski przez shouldConsider, zanim przeczyta ich punkty', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const odsiana = horizontalLine(notebook, 100);
  const kasowana = horizontalLine(notebook, 100);
  // Id trzeba zdjąć teraz: po skasowaniu Y.Map nie odda już swoich pól.
  const odsianaId = odsiana.get('id');
  const kasowanaId = kasowana.get('id');

  const asked = [];
  // Obie kreski leżą dokładnie pod gumką, ale sito przepuszcza tylko drugą.
  const touched = notebook.eraseAt(75, 100, 15, 'object', (map) => {
    asked.push(map.get('id'));
    return map === kasowana;
  });

  assert.equal(touched, 1);
  assert.deepEqual(asked, [odsianaId, kasowanaId], 'sito dostaje każdą kreskę');
  assert.deepEqual(strokeIds(notebook), [odsianaId], 'odsiana kreska została nietknięta');
});

test('eraseAt nic nie robi, gdy gumka nie dotyka kresek', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  horizontalLine(notebook, 100);
  assert.equal(notebook.eraseAt(900, 900, 15, 'object'), 0);
  assert.equal(notebook.strokes.length, 1);
});

// ===========================================================================
// Cofanie
// ===========================================================================

test('undo i redo działają na własnych zmianach', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  notebook.addStroke(penStroke({ id: 'a1' }));
  notebook.addStroke(penStroke({ id: 'b2' }));

  assert.equal(notebook.canUndo(), true);
  notebook.undo();
  assert.deepEqual(strokeIds(notebook), ['a1']);

  notebook.undo();
  assert.deepEqual(strokeIds(notebook), []);
  assert.equal(notebook.canUndo(), false);

  notebook.redo();
  assert.deepEqual(strokeIds(notebook), ['a1']);
  notebook.redo();
  assert.deepEqual(strokeIds(notebook), ['a1', 'b2']);
});

test('undo cofa TYLKO moje zmiany, nie cudze', (t) => {
  // To jest powód, dla którego undo robi UndoManager, a nie migawki stanu:
  // migawka cofnęłaby w sesji online także to, co narysował ktoś inny.
  const mine = makeDoc();
  const theirs = makeDoc();
  const disconnect = connect(mine, theirs);
  t.after(() => {
    disconnect();
    mine.destroy();
    theirs.destroy();
  });

  mine.addStroke(penStroke({ id: 'moja' }));
  theirs.addStroke(penStroke({ id: 'cudza' }));

  assert.deepEqual(strokeIds(mine).sort(), ['cudza', 'moja']);

  mine.undo();

  assert.deepEqual(strokeIds(mine), ['cudza'], 'cudza kreska musi zostać');
  assert.deepEqual(strokeIds(theirs), ['cudza'], 'i zniknąć u drugiej osoby tylko moja');
});

test('undo nie ma czego cofać po zmianach wyłącznie cudzych', (t) => {
  const mine = makeDoc();
  const theirs = makeDoc();
  const disconnect = connect(mine, theirs);
  t.after(() => {
    disconnect();
    mine.destroy();
    theirs.destroy();
  });

  theirs.addStroke(penStroke({ id: 'cudza' }));

  assert.equal(mine.strokes.length, 1);
  assert.equal(mine.canUndo(), false, 'cudza zmiana nie trafia do mojej historii');
});

test('stopCapturing robi z pociągnięcia jeden krok cofania', (t) => {
  // Domyślny captureTimeout scaliłby te dwie kreski w jeden krok; jawne
  // domknięcie granicy sprawia, że jedno pociągnięcie = jedno undo.
  const notebook = new NotebookDoc(Y);
  t.after(() => notebook.destroy());

  const first = notebook.addStroke(penStroke({ id: 'a1' }));
  notebook.appendPoints(first, [20, 20, 0.5]);
  notebook.appendPoints(first, [30, 30, 0.5]);
  notebook.stopCapturing();

  notebook.addStroke(penStroke({ id: 'b2' }));

  notebook.undo();
  assert.deepEqual(strokeIds(notebook), ['a1'], 'cofnęło całą drugą kreskę');

  notebook.undo();
  assert.deepEqual(strokeIds(notebook), [], 'i całą pierwszą, razem z dosypanymi punktami');
});

test('wczytanie pliku nie jest zmianą do cofnięcia', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const { state } = core.normalizeState({
    version: 2,
    strokes: [{ id: 'z9', tool: 'pen', brush: 'pen', color: '#00ff00', size: 3, pressureEnabled: false, pts: [1, 2, 0.5, 3, 4, 0.5] }],
  });

  notebook.loadState(state);

  assert.deepEqual(strokeIds(notebook), ['z9']);
  assert.equal(notebook.canUndo(), false, 'otwarcie pliku nie może być cofalne w pustkę');
});

// ===========================================================================
// Plik
// ===========================================================================

test('toState i loadState to round-trip', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  notebook.setMeta('title', 'Całki');
  const map = notebook.addStroke(penStroke({ id: 'a1' }));
  notebook.appendPoints(map, [20, 20, 0.6]);
  notebook.addImage({ id: 'img1', x: 10, y: 10, w: 100, h: 50, dataUrl: 'data:image/png;base64,AAAA' });

  const { state, skipped } = notebook.toState();
  assert.deepEqual(skipped, { strokes: 0, images: 0, annotations: 0 });
  assert.equal(state.version, core.FILE_FORMAT_VERSION);
  assert.equal(state.meta.title, 'Całki');

  const reloaded = makeDoc();
  t.after(() => reloaded.destroy());
  reloaded.loadState(state);

  assert.deepEqual(reloaded.toState().state, state);
});

test('toState pomija kreski, które ktoś wstawił poza API', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  notebook.addStroke(penStroke({ id: 'dobra' }));

  // Tak wygląda kreska wstawiona wprost do Y.Doc przez inną osobę w sesji.
  const evil = new Y.Map();
  evil.set('id', 'zla');
  evil.set('tool', 'pen');
  evil.set('brush', 'pen');
  evil.set('color', 'javascript:alert(1)');
  evil.set('size', 4);
  evil.set('pressureEnabled', false);
  evil.set('pts', Y.Array.from([10, 10, 0.5]));
  notebook.doc.transact(() => notebook.strokes.push([evil]), 'remote');

  const { state, skipped } = notebook.toState();

  assert.deepEqual(
    state.strokes.map((s) => s.id),
    ['dobra'],
  );
  assert.equal(skipped.strokes, 1);
});

test('loadState podmienia zawartość, a nie dokleja', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  notebook.addStroke(penStroke({ id: 'stara' }));
  const { state } = core.normalizeState({
    version: 2,
    strokes: [{ id: 'nowa', tool: 'pen', brush: 'pen', color: '#ffffff', size: 4, pressureEnabled: false, pts: [1, 2, 0.5] }],
  });

  notebook.loadState(state);

  assert.deepEqual(strokeIds(notebook), ['nowa']);
});

// ===========================================================================
// Scalanie dwóch Y.Doc
// ===========================================================================

test('dwa dokumenty edytowane w rozłączeniu zbiegają się do tego samego stanu', (t) => {
  const a = makeDoc();
  const b = makeDoc();
  t.after(() => {
    a.destroy();
    b.destroy();
  });

  // Wspólny punkt wyjścia.
  a.addStroke(penStroke({ id: 'wspolna' }));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');

  // Rozłączone edycje po obu stronach.
  a.addStroke(penStroke({ id: 'od-a' }));
  b.addStroke(penStroke({ id: 'od-b' }));

  // Wymiana w obie strony.
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');

  assert.deepEqual(strokeIds(a).sort(), ['od-a', 'od-b', 'wspolna']);
  assert.deepEqual(strokeIds(a), strokeIds(b), 'obie strony widzą tę samą kolejność');
  assert.deepEqual(a.toState().state, b.toState().state);
});

test('punkty dosypywane równolegle do dwóch kresek nie gubią się', (t) => {
  const a = makeDoc();
  const b = makeDoc();
  const disconnect = connect(a, b);
  t.after(() => {
    disconnect();
    a.destroy();
    b.destroy();
  });

  const mine = a.addStroke(penStroke({ id: 'a-kreska' }));
  const theirs = b.addStroke(penStroke({ id: 'b-kreska' }));

  a.appendPoints(mine, [20, 20, 0.5, 30, 30, 0.5]);
  b.appendPoints(theirs, [40, 40, 0.5]);

  const byId = (notebook, id) => notebook.findStroke(id).get('pts').toArray();

  assert.deepEqual(byId(a, 'a-kreska'), byId(b, 'a-kreska'));
  assert.deepEqual(byId(a, 'b-kreska'), byId(b, 'b-kreska'));
  assert.equal(byId(a, 'a-kreska').length / 3, 3);
  assert.equal(byId(a, 'b-kreska').length / 3, 2);
});

// ===========================================================================
// Obserwacja
// ===========================================================================

test('observe rozróżnia zmiany własne od cudzych', (t) => {
  const mine = makeDoc();
  const theirs = makeDoc();
  const disconnect = connect(mine, theirs);
  const seen = [];
  const unobserve = mine.observe((events, transaction, local) => seen.push(local));
  t.after(() => {
    unobserve();
    disconnect();
    mine.destroy();
    theirs.destroy();
  });

  mine.addStroke(penStroke({ id: 'moja' }));
  theirs.addStroke(penStroke({ id: 'cudza' }));

  assert.deepEqual(seen, [true, false]);

  unobserve();
  mine.addStroke(penStroke({ id: 'po-odpieciu' }));
  assert.equal(seen.length, 2, 'po odsubskrybowaniu nic nie dochodzi');
});

test('setMeta czyści wartość i zgłasza nieznane pole', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  assert.equal(notebook.setMeta('title', '  Całki  '), 'Całki');
  assert.throws(() => notebook.setMeta('onload', 'x'), TypeError);
});

// ===========================================================================
// Obrazy i adnotacje
// ===========================================================================

function sampleImage(notebook, overrides) {
  return notebook.addImage({
    x: 100,
    y: 100,
    w: 80,
    h: 60,
    dataUrl: 'data:image/png;base64,AAAA',
    ...overrides,
  });
}

test('updateImage przesuwa i skaluje, odrzucając wartości spoza formatu', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const map = sampleImage(notebook);

  assert.equal(notebook.updateImage(map, { x: 200, y: 300 }), true);
  assert.deepEqual([map.get('x'), map.get('y'), map.get('w')], [200, 300, 80]);

  assert.equal(notebook.updateImage(map, { w: 160, h: 120 }), true);
  assert.equal(map.get('w'), 160);

  assert.equal(notebook.updateImage(map, { w: 0 }), false, 'zerowa szerokość odpada');
  assert.equal(notebook.updateImage(map, { x: NaN }), false);
  assert.equal(map.get('w'), 160, 'odrzucona zmiana nie rusza obrazu');
});

test('removeImage i findImage', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const map = sampleImage(notebook, { id: 'i1' });
  assert.equal(notebook.findImage('i1'), map);
  assert.equal(notebook.removeImage(map), true);
  assert.equal(notebook.images.length, 0);
  assert.equal(notebook.findImage('i1'), null);
  assert.equal(notebook.removeImage(map), false, 'drugie usunięcie nie robi nic');
});

test('gumka w trybie "object" kasuje także obrazy, w "area" nie', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  sampleImage(notebook, { id: 'i1' });
  assert.equal(notebook.eraseAt(120, 120, 10, 'area'), 0, 'obrazu nie da się przyciąć częściowo');
  assert.equal(notebook.images.length, 1);

  assert.equal(notebook.eraseAt(120, 120, 10, 'object'), 1);
  assert.equal(notebook.images.length, 0);
});

test('transformSelection przesuwa i skaluje w jednym kroku cofania', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const a = notebook.addStroke(penStroke({ id: 'a1', pts: [100, 100, 0.5, 200, 200, 0.5] }));
  const img = sampleImage(notebook, { id: 'i1', x: 100, y: 100, w: 40, h: 20 });

  assert.equal(
    notebook.transformSelection([a], [img], { ox: 0, oy: 0, k: 1, dx: 50, dy: -30 }),
    true,
  );
  assert.deepEqual(a.get('pts').toArray(), [150, 70, 0.5, 250, 170, 0.5]);
  assert.deepEqual([img.get('x'), img.get('y')], [150, 70]);

  // Jedna transakcja = jeden krok cofania dla całego zaznaczenia.
  notebook.undo();
  assert.deepEqual(a.get('pts').toArray(), [100, 100, 0.5, 200, 200, 0.5]);
  assert.deepEqual([img.get('x'), img.get('y')], [100, 100]);
});

test('transformSelection nie rusza niczego, gdy cokolwiek wyszłoby poza kartkę', (t) => {
  // Przesunięcie połowy zaznaczenia byłoby gorsze niż nieprzesunięcie niczego.
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  // Liczone od krawędzi świata, żeby test nie zależał od bieżącej szerokości kartki.
  const przyKrawedzi = core.MAX_WORLD_X - 50;
  const zostaje = notebook.addStroke(penStroke({ id: 'a1', pts: [100, 100, 0.5, 120, 120, 0.5] }));
  const wypada = notebook.addStroke(
    penStroke({ id: 'b2', pts: [przyKrawedzi, 100, 0.5, przyKrawedzi + 20, 120, 0.5] }),
  );

  assert.equal(
    notebook.transformSelection([zostaje, wypada], [], { ox: 0, oy: 0, k: 1, dx: 200, dy: 0 }),
    false,
  );
  assert.deepEqual(zostaje.get('pts').toArray(), [100, 100, 0.5, 120, 120, 0.5], 'pierwsza kreska nietknięta');
  assert.deepEqual(wypada.get('pts').toArray(), [przyKrawedzi, 100, 0.5, przyKrawedzi + 20, 120, 0.5]);
});

test('skalowanie zaznaczenia zmienia też grubość kreski', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const a = notebook.addStroke(penStroke({ size: 4, pts: [100, 100, 0.5, 150, 100, 0.5] }));
  notebook.transformSelection([a], [], { ox: 100, oy: 100, k: 2, dx: 0, dy: 0 });

  assert.equal(a.get('size'), 8);
  assert.deepEqual(a.get('pts').toArray(), [100, 100, 0.5, 200, 100, 0.5]);
});

test('removeMany usuwa kreski i obrazy jednym krokiem cofania', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  const a = notebook.addStroke(penStroke({ id: 'a1' }));
  const b = notebook.addStroke(penStroke({ id: 'b2' }));
  const img = sampleImage(notebook, { id: 'i1' });
  notebook.stopCapturing();

  assert.equal(notebook.removeMany([a], [img]), 2);
  assert.deepEqual(strokeIds(notebook), ['b2']);
  assert.equal(notebook.images.length, 0);

  notebook.undo();
  assert.deepEqual(strokeIds(notebook).sort(), ['a1', 'b2'], 'jedno cofnięcie przywraca całą paczkę');
  assert.equal(notebook.images.length, 1);

  assert.equal(notebook.removeMany([], []), 0, 'puste zaznaczenie to brak zmiany');
});

test('adnotacje: dodawanie, usuwanie i lista posortowana po pionie', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  notebook.addAnnotation({ id: 'n2', y: 900, label: 'Rozdział 2' });
  notebook.addAnnotation({ id: 'n1', y: 100, label: '  Rozdział 1  ' });
  notebook.addAnnotation({ id: 'n3', y: 500, label: '' });

  assert.deepEqual(notebook.annotationList().map((a) => a.id), ['n1', 'n3', 'n2']);
  assert.equal(notebook.annotationList()[0].label, 'Rozdział 1');
  assert.equal(notebook.annotationList()[1].label, 'Bez nazwy', 'pusta etykieta dostaje zastępnik');

  assert.equal(notebook.removeAnnotation('n3'), true);
  assert.equal(notebook.removeAnnotation('nie-ma'), false);
  assert.deepEqual(notebook.annotationList().map((a) => a.id), ['n1', 'n2']);
});

test('addAnnotation rzuca na danych spoza formatu', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  assert.throws(() => notebook.addAnnotation({ y: NaN, label: 'x' }), TypeError);
  assert.throws(() => notebook.addAnnotation({ y: core.MAX_WORLD_Y + 1, label: 'x' }), TypeError);
  assert.equal(notebook.annotations.length, 0);
});

test('clear czyści także adnotacje i da się to cofnąć', (t) => {
  const notebook = makeDoc();
  t.after(() => notebook.destroy());

  notebook.addStroke(penStroke());
  sampleImage(notebook);
  notebook.addAnnotation({ y: 100, label: 'Rozdział 1' });

  notebook.clear();
  assert.deepEqual(
    [notebook.strokes.length, notebook.images.length, notebook.annotations.length],
    [0, 0, 0],
  );

  notebook.undo();
  assert.deepEqual(
    [notebook.strokes.length, notebook.images.length, notebook.annotations.length],
    [1, 1, 1],
  );
});
