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
      this.annotations = this.doc.getArray(core.ANNOTATIONS_KEY);
      this.meta = this.doc.getMap(core.META_KEY);

      // Origin jest per-instancja, żeby dwa dokumenty w jednym procesie
      // nie uznały swoich zmian za własne.
      this.localOrigin = Symbol('mathnotes:local');

      // Cofanie robi UndoManager, nie migawki stanu: w sesji online migawka
      // cofnęłaby też zmiany innych osób. trackedOrigins = tylko my.
      this.undoManager = new Y.UndoManager([this.strokes, this.images, this.annotations, this.meta], {
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
        pressureEnabled: input.pressureEnabled,
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
     *
     * `shouldConsider` to wstępne sito: odczytanie punktów każdej kreski przy
     * każdym ruchu gumki byłoby O(n) po całym dokumencie. Renderer ma bboxy
     * w swoim cache'u i odsiewa nimi, zanim tu cokolwiek przeczytamy. Bez sita
     * działa poprawnie, tylko wolno.
     * @param {(map: object) => boolean} [shouldConsider]
     * @returns {number} ile kresek zostało ruszonych
     */
    eraseAt(x, y, radius, mode, shouldConsider) {
      const hits = [];
      for (let i = 0; i < this.strokes.length; i++) {
        const map = this.strokes.get(i);
        if (shouldConsider && !shouldConsider(map)) continue;
        const stroke = readStroke(map);
        if (!stroke) continue;
        const pieces = core.eraseStroke(stroke, x, y, radius, mode);
        if (pieces === null) continue;
        hits.push({ index: i, stroke, pieces });
      }
      // Tryb „obiekty” kasuje także obrazy — obrazu nie da się przyciąć częściowo.
      const imageHits = [];
      if (mode !== 'area') {
        for (let i = 0; i < this.images.length; i++) {
          const image = core.validateImage(this.images.get(i).toJSON());
          // Tła z PDF-a gumka nie rusza — tak samo jak nie da się go zaznaczyć.
          if (image && !image.locked && core.eraseHitsImage(image, x, y, radius)) imageHits.push(i);
        }
      }

      if (hits.length === 0 && imageHits.length === 0) return 0;

      this.transact(() => {
        for (let k = imageHits.length - 1; k >= 0; k--) this.images.delete(imageHits[k], 1);

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
                // Kawałek dziedziczy WSZYSTKIE pola oryginału poza punktami
                // i identyfikatorem. Pominięcie choćby jednego sprawia, że
                // kawałek nie przechodzi walidacji i znika bez śladu.
                ...stroke,
                id: core.createId(),
                pts,
              }),
            ),
          );
        }
      });

      return hits.length + imageHits.length;
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
        locked: input.locked,
        srcW: input.srcW,
        srcH: input.srcH,
      });
      if (!candidate) throw new TypeError('addImage: obraz nie przechodzi walidacji formatu');
      if (this.images.length >= core.MAX_IMAGES) return null;

      const map = core.imageToYMap(this.Y, candidate);
      this.transact(() => this.images.push([map]));
      return map;
    }

    /** Przesunięcie albo przeskalowanie obrazu. Zwraca false przy danych spoza formatu. */
    updateImage(map, box) {
      if (!map) return false;
      const next = core.validateImage({ ...map.toJSON(), ...box });
      if (!next) return false;
      this.transact(() => {
        map.set('x', next.x);
        map.set('y', next.y);
        map.set('w', next.w);
        map.set('h', next.h);
      });
      return true;
    }

    removeImage(map) {
      const index = this.images.toArray().indexOf(map);
      if (index < 0) return false;
      this.transact(() => this.images.delete(index, 1));
      return true;
    }

    findImage(id) {
      for (let i = 0; i < this.images.length; i++) {
        const map = this.images.get(i);
        if (map && map.get('id') === id) return map;
      }
      return null;
    }

    /**
     * Przesuwa i skaluje zaznaczenie w jednej transakcji — czyli jednym kroku
     * cofania. Najpierw sprawdzamy wszystko, potem zmieniamy: przekształcenie,
     * które wypchnęłoby cokolwiek poza kartkę, nie wykonuje się wcale, zamiast
     * przesunąć połowę zaznaczenia.
     * @param {{ox: number, oy: number, k: number, dx: number, dy: number}} t
     * @returns {boolean} czy zmiana została wykonana
     */
    transformSelection(strokeMaps, imageMaps, t) {
      const strokePlan = [];
      for (const map of strokeMaps) {
        const stroke = core.validateStroke(map.toJSON());
        if (!stroke) continue;
        const moved = core.transformStroke(stroke, t);
        const candidate = core.validateStroke({ ...stroke, ...moved });
        if (!candidate) return false;
        strokePlan.push({ map, candidate });
      }

      const imagePlan = [];
      for (const map of imageMaps) {
        const image = core.validateImage(map.toJSON());
        if (!image) continue;
        const candidate = core.validateImage({ ...image, ...core.transformImage(image, t) });
        if (!candidate) return false;
        imagePlan.push({ map, candidate });
      }

      if (strokePlan.length === 0 && imagePlan.length === 0) return false;

      this.transact(() => {
        for (const { map, candidate } of strokePlan) {
          map.set('size', candidate.size);
          const pts = map.get('pts');
          pts.delete(0, pts.length);
          pts.push(candidate.pts);
        }
        for (const { map, candidate } of imagePlan) {
          map.set('x', candidate.x);
          map.set('y', candidate.y);
          map.set('w', candidate.w);
          map.set('h', candidate.h);
        }
      });
      return true;
    }

    /** Usuwa zaznaczone kreski i obrazy jednym krokiem cofania. */
    removeMany(strokeMaps, imageMaps) {
      const strokeIndexes = [];
      const all = this.strokes.toArray();
      for (const map of strokeMaps) {
        const index = all.indexOf(map);
        if (index >= 0) strokeIndexes.push(index);
      }
      const imageIndexes = [];
      const allImages = this.images.toArray();
      for (const map of imageMaps) {
        const index = allImages.indexOf(map);
        if (index >= 0) imageIndexes.push(index);
      }
      if (strokeIndexes.length === 0 && imageIndexes.length === 0) return 0;

      strokeIndexes.sort((a, b) => b - a);
      imageIndexes.sort((a, b) => b - a);
      this.transact(() => {
        for (const index of strokeIndexes) this.strokes.delete(index, 1);
        for (const index of imageIndexes) this.images.delete(index, 1);
      });
      return strokeIndexes.length + imageIndexes.length;
    }

    addAnnotation(input) {
      const candidate = core.validateAnnotation({
        id: typeof input.id === 'string' ? input.id : core.createId(),
        y: input.y,
        label: input.label,
      });
      if (!candidate) throw new TypeError('addAnnotation: adnotacja nie przechodzi walidacji formatu');
      if (this.annotations.length >= core.MAX_ANNOTATIONS) return null;

      const map = core.annotationToYMap(this.Y, candidate);
      this.transact(() => this.annotations.push([map]));
      return map;
    }

    removeAnnotation(id) {
      for (let i = 0; i < this.annotations.length; i++) {
        if (this.annotations.get(i).get('id') === id) {
          this.transact(() => this.annotations.delete(i, 1));
          return true;
        }
      }
      return false;
    }

    /** Adnotacje posortowane po pionie — tak jak pokazuje je lista. */
    annotationList() {
      const out = [];
      for (const map of this.annotations) {
        const annotation = core.validateAnnotation(map.toJSON());
        if (annotation) out.push(annotation);
      }
      return out.sort((a, b) => a.y - b.y);
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
        this.annotations.delete(0, this.annotations.length);
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
      this.annotations.observeDeep(wrap);
      this.meta.observe(metaWrap);

      return () => {
        this.strokes.unobserveDeep(wrap);
        this.images.unobserveDeep(wrap);
        this.annotations.unobserveDeep(wrap);
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
