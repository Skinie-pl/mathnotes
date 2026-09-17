// Model dokumentu na Yjs. Jedyne miejsce, które mutuje Y.Doc.
//
// Y wchodzi tu argumentem konstruktora, a nie importem: renderer bierze go
// z window.Collab (zvendorowany bundle), test z tego samego bundle'a wczytanego
// ręcznie. Dzięki temu doc.js nie zna sposobu ładowania biblioteki.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.MathNotesDoc = factory(root.MathNotesCore);
})(typeof self !== 'undefined' ? self : globalThis, function (core) {
  'use strict';

  // Wczytanie pliku nie jest zmianą do cofnięcia — leci innym originem niż
  // lokalne edycje, więc UndoManager go nie śledzi.
  const LOAD_ORIGIN = Symbol('mathnotes:load');

  // Sekcja 4 instrukcji. Przy dłuższej przerwie w rysowaniu kolejne pociągnięcie
  // zaczyna nowy krok cofania; granice i tak domykamy jawnie przez stopCapturing().
  const DEFAULT_CAPTURE_TIMEOUT = 300;

  /** Y.Map kreski → zwykły obiekt przepuszczony przez walidację, albo null. */
  function readStroke(map) {
    if (!map || typeof map.toJSON !== 'function') return null;
    return core.validateStroke(map.toJSON());
  }

  class NotebookDoc {
    constructor(Y, options) {
      const opts = options || {};
      this.Y = Y;
      this.doc = new Y.Doc();

      this.strokes = this.doc.getArray(core.STROKES_KEY);
      this.images = this.doc.getArray(core.IMAGES_KEY);
      this.meta = this.doc.getMap(core.META_KEY);

      // Origin jest per-instancja, żeby dwa dokumenty w jednym procesie
      // nie uznały swoich zmian za własne.
      this.localOrigin = Symbol('mathnotes:local');

      // Cofanie robi UndoManager, nie migawki stanu: w sesji online migawka
      // cofnęłaby też zmiany innych osób. trackedOrigins = tylko my.
      this.undoManager = new Y.UndoManager([this.strokes, this.images, this.meta], {
        trackedOrigins: new Set([this.localOrigin]),
        captureTimeout: opts.captureTimeout === undefined ? DEFAULT_CAPTURE_TIMEOUT : opts.captureTimeout,
      });
    }

    /** Wszystkie lokalne mutacje idą tędy — inaczej UndoManager ich nie zobaczy. */
    transact(fn) {
      return this.doc.transact(fn, this.localOrigin);
    }

    // ------------------------------------------------------------------
    // Kreski
    // ------------------------------------------------------------------

    /**
     * Dokłada kreskę. `pts` zwykle ma jeden punkt — resztę dosypuje appendPoints.
     * Rzuca przy danych spoza formatu: to byłby błąd renderera, nie użytkownika,
     * więc ma być głośny. Renderer przycina współrzędne do strony przed wywołaniem.
     */
    addStroke(input) {
      const candidate = core.validateStroke({
        id: typeof input.id === 'string' ? input.id : core.createId(),
        tool: input.tool,
        brush: input.brush,
        color: input.color,
        size: input.size,
        pts: input.pts,
      });
      if (!candidate) throw new TypeError('addStroke: kreska nie przechodzi walidacji formatu');
      if (this.strokes.length >= core.MAX_STROKES) return null;

      const map = core.strokeToYMap(this.Y, candidate);
      this.transact(() => this.strokes.push([map]));
      return map;
    }

    /**
     * Dosypuje punkty do trwającej kreski. Bierze Y.Map zwrócony przez addStroke,
     * a nie id — to jest ścieżka gorąca, wołana raz na klatkę, i nie może szukać.
     * Punkty spoza strony są pomijane (renderer i tak przycina; to zabezpieczenie).
     * @returns {number} ile punktów faktycznie doszło
     */
    appendPoints(strokeMap, pts) {
      if (!strokeMap || !Array.isArray(pts) || pts.length === 0 || pts.length % 3 !== 0) return 0;
      const target = strokeMap.get('pts');
      if (!target) return 0;

      const room = core.MAX_STROKE_POINTS - Math.floor(target.length / 3);
      if (room <= 0) return 0;

      const accepted = [];
      for (let i = 0; i < pts.length && accepted.length / 3 < room; i += 3) {
        const x = pts[i];
        const y = pts[i + 1];
        const p = pts[i + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < 0 || x > core.PAGE_WIDTH || y < 0 || y > core.MAX_PAGE_HEIGHT) continue;
        accepted.push(
          core.roundCoord(x),
          core.roundCoord(y),
          core.roundPressure(Number.isFinite(p) ? core.clamp(p, 0, 1) : core.DEFAULT_PRESSURE),
        );
      }
      if (accepted.length === 0) return 0;

      // Jedna transakcja na wywołanie, a renderer woła to raz na klatkę —
      // nie raz na punkt.
      this.transact(() => target.push(accepted));
      return accepted.length / 3;
    }

    findStroke(id) {
      // ponytail: liniowe szukanie. Ścieżka gorąca dostaje Y.Map wprost
      // z addStroke, więc to jest droga rzadka (undo, testy, cudze kreski).
      for (let i = 0; i < this.strokes.length; i++) {
        const map = this.strokes.get(i);
        if (map && map.get('id') === id) return map;
      }
      return null;
    }

    /**
     * Kasowanie gumką. Geometria siedzi w core.js; tutaj jest tylko mutacja.
     * @returns {number} ile kresek zostało ruszonych
     */
    eraseAt(x, y, radius, mode) {
      // ponytail: pełny skan z odczytem pts każdej kreski, O(n) na ruch gumki.
      // Przy dużym dokumencie wchodzi tu wstępne odsianie po bboxach z kafli
      // renderera — ale cache kresek należy do renderera, nie do tego modułu.
      const hits = [];
      for (let i = 0; i < this.strokes.length; i++) {
        const stroke = readStroke(this.strokes.get(i));
        if (!stroke) continue;
        const pieces = core.eraseStroke(stroke, x, y, radius, mode);
        if (pieces === null) continue;
        hits.push({ index: i, stroke, pieces });
      }
      if (hits.length === 0) return 0;

      this.transact(() => {
        // Od końca, żeby wcześniejsze indeksy nie rozjechały się po usunięciu.
        for (let k = hits.length - 1; k >= 0; k--) {
          const { index, stroke, pieces } = hits[k];
          this.strokes.delete(index, 1);
          if (pieces.length === 0) continue;
          const room = core.MAX_STROKES - this.strokes.length;
          const kept = pieces.slice(0, Math.max(0, room));
          if (kept.length === 0) continue;
          this.strokes.insert(
            index,
            kept.map((pts) =>
              core.strokeToYMap(this.Y, {
                id: core.createId(),
                tool: stroke.tool,
                brush: stroke.brush,
                color: stroke.color,
                size: stroke.size,
                pts,
              }),
            ),
          );
        }
      });

      return hits.length;
    }

    // ------------------------------------------------------------------
    // Obrazy i meta
    // ------------------------------------------------------------------

    addImage(input) {
      const candidate = core.validateImage({
        id: typeof input.id === 'string' ? input.id : core.createId(),
        x: input.x,
        y: input.y,
        w: input.w,
        h: input.h,
        dataUrl: input.dataUrl,
      });
      if (!candidate) throw new TypeError('addImage: obraz nie przechodzi walidacji formatu');
      if (this.images.length >= core.MAX_IMAGES) return null;

      const map = core.imageToYMap(this.Y, candidate);
      this.transact(() => this.images.push([map]));
      return map;
    }

    setMeta(key, value) {
      const next = core.validateMeta({ ...this.meta.toJSON(), [key]: value });
      if (!(key in next)) throw new TypeError('setMeta: nieznane pole meta: ' + key);
      this.transact(() => this.meta.set(key, next[key]));
      return next[key];
    }

    clear() {
      this.transact(() => {
        this.strokes.delete(0, this.strokes.length);
        this.images.delete(0, this.images.length);
      });
    }

    // ------------------------------------------------------------------
    // Cofanie
    // ------------------------------------------------------------------

    undo() {
      return this.undoManager.undo();
    }

    redo() {
      return this.undoManager.redo();
    }

    canUndo() {
      return this.undoManager.canUndo();
    }

    canRedo() {
      return this.undoManager.canRedo();
    }

    /**
     * Domyka krok cofania. Renderer woła to przy puszczeniu pióra, żeby jedno
     * pociągnięcie było dokładnie jednym undo — niezależnie od captureTimeout.
     */
    stopCapturing() {
      this.undoManager.stopCapturing();
    }

    // ------------------------------------------------------------------
    // Plik
    // ------------------------------------------------------------------

    toState() {
      return core.ydocToState(this.doc);
    }

    /** Podmienia całą zawartość. Nie jest to zmiana do cofnięcia. */
    loadState(state) {
      core.stateToYDoc(this.Y, this.doc, state, LOAD_ORIGIN);
      this.undoManager.clear();
      return this;
    }

    // ------------------------------------------------------------------
    // Obserwacja
    // ------------------------------------------------------------------

    /**
     * @param {(events: Array, transaction: object, local: boolean) => void} handler
     * @returns {() => void} odsubskrybowanie
     */
    observe(handler) {
      const wrap = (events, transaction) =>
        handler(events, transaction, transaction.origin === this.localOrigin);
      const metaWrap = (event, transaction) => wrap([event], transaction);

      this.strokes.observeDeep(wrap);
      this.images.observeDeep(wrap);
      this.meta.observe(metaWrap);

      return () => {
        this.strokes.unobserveDeep(wrap);
        this.images.unobserveDeep(wrap);
        this.meta.unobserve(metaWrap);
      };
    }

    destroy() {
      this.undoManager.destroy();
      this.doc.destroy();
    }
  }

  return { NotebookDoc, LOAD_ORIGIN, DEFAULT_CAPTURE_TIMEOUT };
});
