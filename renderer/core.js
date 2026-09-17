// Logika bez DOM. Ładowana przez <script> w rendererze oraz przez require() w testach.
// Wszystko, co da się przetestować bez canvasa, mieszka tutaj, nie w renderer.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MathNotesCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const APP_NAME = 'MathNotes';
  const UNTITLED = 'Bez tytułu';

  // Każda zmiana kształtu zapisywanego stanu = bump wersji + krok w normalizeState.
  const FILE_FORMAT_VERSION = 2;

  // Kartka, nie płótno: stała szerokość, przewijanie wyłącznie w pionie.
  const PAGE_WIDTH = 1400;
  // Pion jest „nieskończony”, ale nie nieograniczony — walidacja musi mieć
  // czego się trzymać, a kafle muszą się kiedyś kończyć.
  const MAX_PAGE_HEIGHT = 2000000;
  // Cache gotowych kresek trzymamy w kafelkach w pionie.
  const TILE_HEIGHT = 2000;
  const GRID_SIZE = 40;

  const TOOLS = Object.freeze(['pen', 'highlighter']);
  const BRUSHES = Object.freeze(['round', 'fine']);
  const ERASE_MODES = Object.freeze(['whole', 'split']);
  const BACKGROUNDS = Object.freeze(['plain', 'grid', 'lines']);

  const MIN_STROKE_SIZE = 0.5;
  const MAX_STROKE_SIZE = 64;

  // Limity z sekcji 7 instrukcji — dane od innych osób są niezaufane.
  const MAX_STROKE_POINTS = 20000;
  const MAX_STROKES = 50000;
  const MAX_IMAGES = 1000;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_TITLE_LENGTH = 200;
  // Sesja online przerywa sie po przekroczeniu tego rozmiaru dokumentu.
  const MAX_DOC_BYTES = 200 * 1024 * 1024;

  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const DATA_URL_PREFIX_RE = /^data:image\/(png|jpeg|webp);base64,/;
  const BASE64_BODY_RE = /^[A-Za-z0-9+/]*={0,2}$/;

  // --- Kalibracja pióra -----------------------------------------------------
  // Sprzęt nigdy nie jest idealny: różne tablety mapują nacisk inaczej, a część
  // urządzeń nie zgłasza go wcale. To są pokrętła do strojenia, nie stałe fizyczne.
  const PRESSURE_GAMMA = 0.7; // wyżej = trzeba mocniej docisnąć, żeby pogrubić
  const MIN_WIDTH_FACTOR = 0.35; // kreska nigdy nie schodzi do zera
  const MAX_WIDTH_FACTOR = 1;
  const DEFAULT_PRESSURE = 0.5; // gdy urządzenie nie zgłasza nacisku
  // Próbki bliżej niż to od ostatniego zachowanego punktu odrzucamy.
  const MIN_POINT_DISTANCE = 0.7;

  class StateFormatError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'StateFormatError';
      this.code = code;
    }
  }

  // Jedyne źródło prawdy dla akcji menu. main.js buduje z tego menu,
  // renderer.js buduje z tego mapę handlerów — literówka nie przejdzie po cichu.
  const MENU_ACTIONS = Object.freeze([
    'file:new',
    'file:open',
    'file:save',
    'file:save-as',
    'file:insert-image',
    'edit:undo',
    'edit:redo',
    'edit:clear',
    'view:zoom-in',
    'view:zoom-out',
    'view:zoom-reset',
    'view:background',
    'online:start',
    'online:join',
    'online:copy-invite',
    'online:leave',
    'online:settings',
  ]);

  // ==========================================================================
  // Drobiazgi
  // ==========================================================================

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function clamp(value, lo, hi) {
    return value < lo ? lo : value > hi ? hi : value;
  }

  // Zaokrąglenia z sekcji 4: 0,1 px i 0,01 nacisku — żeby aktualizacje Yjs były małe.
  function roundCoord(value) {
    return Math.round(value * 10) / 10;
  }

  function roundPressure(value) {
    return Math.round(value * 100) / 100;
  }

  // Status notatnika żyje w tytule okna — świadomie zamiast paska stanu,
  // który zjadałby pion ekranu na tablecie.
  function formatTitle(name, dirty) {
    const label = name && String(name).trim() ? String(name).trim() : UNTITLED;
    return (dirty ? '• ' : '') + label + ' — ' + APP_NAME;
  }

  // Alfabet base64url — pasuje do ID_RE, więc identyfikator nigdy nie wymaga
  // uciekania i nie da się nim wyjść poza swoje miejsce.
  const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

  /** 96 bitów z CSPRNG. Nigdy Math.random — id zderzają się w sesji online. */
  function createId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const byte of bytes) out += ID_ALPHABET[byte & 63];
    return out;
  }

  // ==========================================================================
  // Szerokość kreski — wspólna dla obu ścieżek renderowania
  // ==========================================================================

  // KRYTYCZNE: wynik zależy wyłącznie od danych lokalnych punktu (nacisk, pędzel).
  // Gdyby zależał od długości kreski albo pozycji punktu względem końca, ścieżka
  // inkrementalna (drawLatestSegment) i kanoniczna (drawStroke) policzyłyby inaczej
  // i linia „skoczyłaby” w momencie puszczenia pióra. Żadnych zwężeń na końcach.
  function widthFactor(tool, brush, pressure) {
    if (tool === 'highlighter' || brush === 'fine') return MAX_WIDTH_FACTOR;
    const p = isFiniteNumber(pressure) && pressure > 0 ? clamp(pressure, 0, 1) : DEFAULT_PRESSURE;
    return MIN_WIDTH_FACTOR + (MAX_WIDTH_FACTOR - MIN_WIDTH_FACTOR) * Math.pow(p, PRESSURE_GAMMA);
  }

  function pointCount(stroke) {
    return stroke && stroke.pts ? Math.floor(stroke.pts.length / 3) : 0;
  }

  /** Szerokość kreski w punkcie o indeksie i. Obie ścieżki renderowania wołają to samo. */
  function widthAt(stroke, i) {
    const pressure = stroke.pts[i * 3 + 2];
    return stroke.size * widthFactor(stroke.tool, stroke.brush, pressure);
  }

  function maxWidth(stroke) {
    return stroke.size * MAX_WIDTH_FACTOR;
  }

  /**
   * Szerokość odcinka między punktem i a i+1. Kreska jest rysowana odcinek po
   * odcinku z zaokrąglonymi końcami, więc TO jest liczba, którą muszą zgodnie
   * policzyć obie ścieżki renderowania: drawLatestSegment w trakcie pociągnięcia
   * i drawStroke przy przerysowaniu. Zależy wyłącznie od dwóch sąsiednich
   * punktów — nigdy od długości kreski.
   */
  function segmentWidth(stroke, i) {
    return (widthAt(stroke, i) + widthAt(stroke, i + 1)) / 2;
  }

  // ==========================================================================
  // Wygładzanie
  // ==========================================================================

  // Filtr jest przyczynowy: decyduje tylko o nowym punkcie i nigdy nie rusza
  // wcześniejszych. Każde wygładzanie, które poprawia punkty wstecz, rozjechałoby
  // ścieżkę inkrementalną z kanoniczną — czyli ten sam błąd co niestały widthFactor.
  function shouldKeepPoint(lastX, lastY, x, y, minDistance) {
    const min = isFiniteNumber(minDistance) ? minDistance : MIN_POINT_DISTANCE;
    const dx = x - lastX;
    const dy = y - lastY;
    return dx * dx + dy * dy >= min * min;
  }

  // ==========================================================================
  // Bboxy
  // ==========================================================================

  function strokeBounds(stroke) {
    const n = pointCount(stroke);
    if (n === 0) return null;
    const pts = stroke.pts;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // Margines na grubość kreski i zaokrąglone końce, żeby unieważnianie kafli
    // nie ucinało brzegu.
    const pad = maxWidth(stroke) / 2 + 1;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  function imageBounds(image) {
    return { minX: image.x, minY: image.y, maxX: image.x + image.w, maxY: image.y + image.h };
  }

  function boundsIntersect(a, b) {
    if (!a || !b) return false;
    return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
  }

  /** Zakres kafli w pionie, których dotyka bbox. */
  function tileRange(bounds) {
    if (!bounds) return null;
    return {
      first: Math.max(0, Math.floor(bounds.minY / TILE_HEIGHT)),
      last: Math.max(0, Math.floor(bounds.maxY / TILE_HEIGHT)),
    };
  }

  // ==========================================================================
  // Geometria gumki
  // ==========================================================================

  function distanceToSegmentSquared(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
    const cx = ax + t * dx - px;
    const cy = ay + t * dy - py;
    return cx * cx + cy * cy;
  }

  /**
   * Kasowanie kreski okręgiem gumki.
   * @returns {null} kreska nietknięta
   * @returns {Array<number[]>} [] = skasowana w całości, inaczej lista nowych `pts`
   */
  function eraseStroke(stroke, cx, cy, radius, mode) {
    const n = pointCount(stroke);
    if (n === 0) return null;
    const pts = stroke.pts;

    // Punkt trafiony, gdy okrąg gumki sięga rysowanej grubości w tym miejscu.
    const hitPoint = new Array(n);
    let touched = false;
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 3] - cx;
      const dy = pts[i * 3 + 1] - cy;
      const r = radius + widthAt(stroke, i) / 2;
      hitPoint[i] = dx * dx + dy * dy <= r * r;
      if (hitPoint[i]) touched = true;
    }

    // Długi odcinek może przeciąć gumkę, mając oba końce poza nią.
    const hitSegment = new Array(Math.max(0, n - 1));
    for (let i = 0; i < n - 1; i++) {
      if (hitPoint[i] || hitPoint[i + 1]) {
        hitSegment[i] = true;
        continue;
      }
      const r = radius + Math.max(widthAt(stroke, i), widthAt(stroke, i + 1)) / 2;
      const distSq = distanceToSegmentSquared(
        cx,
        cy,
        pts[i * 3],
        pts[i * 3 + 1],
        pts[(i + 1) * 3],
        pts[(i + 1) * 3 + 1],
      );
      hitSegment[i] = distSq <= r * r;
      if (hitSegment[i]) touched = true;
    }

    if (!touched) return null;
    if (mode !== 'split') return [];

    // ponytail: cięcie przebiega po granicy punktu, nie po dokładnym przecięciu
    // z okręgiem. Przy typowym rozstawie próbek (<1 px) różnica jest podpikselowa;
    // jeśli kiedyś zacznie być widoczna, tu wchodzi docinanie odcinka do okręgu.
    const pieces = [];
    let run = [];

    const flush = () => {
      // Pojedynczy punkt po cięciu to niewidoczny okruch — nie zostawiamy śmieci.
      if (run.length >= 2) {
        const flat = [];
        for (const i of run) flat.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
        pieces.push(flat);
      }
      run = [];
    };

    for (let i = 0; i < n; i++) {
      if (hitPoint[i]) {
        flush();
        continue;
      }
      if (run.length > 0 && hitSegment[i - 1]) flush();
      run.push(i);
    }
    flush();

    return pieces;
  }

  // ==========================================================================
  // Walidacja — fail closed
  // ==========================================================================

  function validPoint(x, y) {
    return (
      isFiniteNumber(x) &&
      isFiniteNumber(y) &&
      x >= 0 &&
      x <= PAGE_WIDTH &&
      y >= 0 &&
      y <= MAX_PAGE_HEIGHT
    );
  }

  /**
   * Sprawdza i normalizuje kreskę. Zwraca świeży obiekt wyłącznie ze znanymi
   * polami (nieznane odpadają) albo null, jeśli cokolwiek jest nie tak.
   */
  function validateStroke(value) {
    if (!isPlainObject(value)) return null;
    if (typeof value.id !== 'string' || !ID_RE.test(value.id)) return null;
    if (!TOOLS.includes(value.tool)) return null;
    if (!BRUSHES.includes(value.brush)) return null;
    if (typeof value.color !== 'string' || !COLOR_RE.test(value.color)) return null;
    if (!isFiniteNumber(value.size) || value.size < MIN_STROKE_SIZE || value.size > MAX_STROKE_SIZE) {
      return null;
    }

    const raw = value.pts;
    if (!Array.isArray(raw)) return null;
    if (raw.length === 0 || raw.length % 3 !== 0) return null;
    if (raw.length / 3 > MAX_STROKE_POINTS) return null;

    const pts = new Array(raw.length);
    for (let i = 0; i < raw.length; i += 3) {
      const x = raw[i];
      const y = raw[i + 1];
      const p = raw[i + 2];
      if (!validPoint(x, y)) return null;
      if (!isFiniteNumber(p) || p < 0 || p > 1) return null;
      pts[i] = roundCoord(x);
      pts[i + 1] = roundCoord(y);
      pts[i + 2] = roundPressure(p);
    }

    return {
      id: value.id,
      tool: value.tool,
      brush: value.brush,
      color: value.color,
      size: value.size,
      pts,
    };
  }

  function validateImage(value) {
    if (!isPlainObject(value)) return null;
    if (typeof value.id !== 'string' || !ID_RE.test(value.id)) return null;
    if (!isFiniteNumber(value.w) || !isFiniteNumber(value.h) || value.w <= 0 || value.h <= 0) {
      return null;
    }
    if (!validPoint(value.x, value.y)) return null;
    if (!validPoint(value.x + value.w, value.y + value.h)) return null;

    const url = value.dataUrl;
    if (typeof url !== 'string') return null;
    // Rozmiar sprawdzamy przed regexem, żeby nie puszczać wyrażenia po 50 MB tekstu.
    if (url.length > MAX_IMAGE_BYTES) return null;
    const prefix = DATA_URL_PREFIX_RE.exec(url);
    if (!prefix) return null;
    if (!BASE64_BODY_RE.test(url.slice(prefix[0].length))) return null;

    return {
      id: value.id,
      x: roundCoord(value.x),
      y: roundCoord(value.y),
      w: roundCoord(value.w),
      h: roundCoord(value.h),
      dataUrl: url,
    };
  }

  function validateMeta(value) {
    const meta = isPlainObject(value) ? value : {};
    const title = typeof meta.title === 'string' ? meta.title.slice(0, MAX_TITLE_LENGTH) : '';
    const background = BACKGROUNDS.includes(meta.background) ? meta.background : 'plain';
    return { title, background };
  }

  // ==========================================================================
  // Format pliku
  // ==========================================================================

  function createEmptyState() {
    return {
      version: FILE_FORMAT_VERSION,
      meta: { title: '', background: 'plain' },
      strokes: [],
      images: [],
    };
  }

  // v1 to kształt sprzed przejścia na Yjs: punkty jako obiekty {x, y, pressure}.
  // v2 spłaszcza je do [x, y, pressure, ...], żeby aktualizacje CRDT były małe.
  function migrateV1ToV2(raw) {
    const strokes = Array.isArray(raw.strokes) ? raw.strokes : [];
    return {
      version: 2,
      meta: raw.meta,
      images: raw.images,
      strokes: strokes.map((stroke) => {
        if (!isPlainObject(stroke) || !Array.isArray(stroke.points)) return stroke;
        const pts = [];
        for (const point of stroke.points) {
          if (!isPlainObject(point)) continue;
          pts.push(point.x, point.y, isFiniteNumber(point.pressure) ? point.pressure : DEFAULT_PRESSURE);
        }
        const { points, ...rest } = stroke;
        return { ...rest, pts };
      }),
    };
  }

  const MIGRATIONS = { 1: migrateV1ToV2 };

  /**
   * Doprowadza surowy JSON z pliku (albo z sesji) do bieżącego formatu.
   * Elementy, które nie przejdą walidacji, są pomijane — a nie po cichu naprawiane.
   * @returns {{state: object, skipped: {strokes: number, images: number}}}
   */
  function normalizeState(raw) {
    if (!isPlainObject(raw)) {
      throw new StateFormatError('INVALID_STATE', 'Stan notatnika musi być obiektem.');
    }

    let version = Number.isInteger(raw.version) ? raw.version : 1; // brak wersji = najstarszy format
    if (version < 1) {
      throw new StateFormatError('INVALID_STATE', 'Nieprawidłowy numer wersji formatu: ' + raw.version);
    }
    if (version > FILE_FORMAT_VERSION) {
      throw new StateFormatError(
        'UNSUPPORTED_VERSION',
        'Plik pochodzi z nowszej wersji programu (format ' + version + ').',
      );
    }

    let value = raw;
    while (version < FILE_FORMAT_VERSION) {
      value = MIGRATIONS[version](value);
      version += 1;
    }

    const state = createEmptyState();
    state.meta = validateMeta(value.meta);

    const skipped = { strokes: 0, images: 0 };

    const rawStrokes = Array.isArray(value.strokes) ? value.strokes : [];
    for (const item of rawStrokes) {
      if (state.strokes.length >= MAX_STROKES) {
        skipped.strokes += 1;
        continue;
      }
      const stroke = validateStroke(item);
      if (stroke) state.strokes.push(stroke);
      else skipped.strokes += 1;
    }

    const rawImages = Array.isArray(value.images) ? value.images : [];
    for (const item of rawImages) {
      if (state.images.length >= MAX_IMAGES) {
        skipped.images += 1;
        continue;
      }
      const image = validateImage(item);
      if (image) state.images.push(image);
      else skipped.images += 1;
    }

    return { state, skipped };
  }

  // ==========================================================================
  // Konwersja JSON ↔ Y.Doc
  // ==========================================================================
  //
  // Y trafia tu argumentem, a nie przez import: core.js ma zostać modułem bez
  // zależności, ładowalnym zarówno przez <script>, jak i przez require() w teście.

  const STROKES_KEY = 'strokes';
  const IMAGES_KEY = 'images';
  const META_KEY = 'meta';

  function strokeToYMap(Y, stroke) {
    const map = new Y.Map();
    map.set('id', stroke.id);
    map.set('tool', stroke.tool);
    map.set('brush', stroke.brush);
    map.set('color', stroke.color);
    map.set('size', stroke.size);
    map.set('pts', Y.Array.from(stroke.pts));
    return map;
  }

  function imageToYMap(Y, image) {
    const map = new Y.Map();
    map.set('id', image.id);
    map.set('x', image.x);
    map.set('y', image.y);
    map.set('w', image.w);
    map.set('h', image.h);
    map.set('dataUrl', image.dataUrl);
    return map;
  }

  /**
   * Y.Doc → stan do zapisania w pliku. Zawartość dokumentu mogła przyjść od
   * innych osób, więc każdy element przechodzi walidację; niepoprawne odpadają.
   * @returns {{state: object, skipped: {strokes: number, images: number}}}
   */
  function ydocToState(doc) {
    const state = createEmptyState();
    const skipped = { strokes: 0, images: 0 };

    state.meta = validateMeta(doc.getMap(META_KEY).toJSON());

    for (const item of doc.getArray(STROKES_KEY)) {
      if (state.strokes.length >= MAX_STROKES) {
        skipped.strokes += 1;
        continue;
      }
      const stroke = validateStroke(item && typeof item.toJSON === 'function' ? item.toJSON() : item);
      if (stroke) state.strokes.push(stroke);
      else skipped.strokes += 1;
    }

    for (const item of doc.getArray(IMAGES_KEY)) {
      if (state.images.length >= MAX_IMAGES) {
        skipped.images += 1;
        continue;
      }
      const image = validateImage(item && typeof item.toJSON === 'function' ? item.toJSON() : item);
      if (image) state.images.push(image);
      else skipped.images += 1;
    }

    return { state, skipped };
  }

  /** Stan z pliku → Y.Doc. Podmienia całą zawartość, nie dokleja. */
  function stateToYDoc(Y, doc, state, origin) {
    doc.transact(() => {
      const strokes = doc.getArray(STROKES_KEY);
      const images = doc.getArray(IMAGES_KEY);
      const meta = doc.getMap(META_KEY);

      strokes.delete(0, strokes.length);
      images.delete(0, images.length);
      meta.clear();

      meta.set('title', state.meta.title);
      meta.set('background', state.meta.background);
      strokes.push(state.strokes.map((stroke) => strokeToYMap(Y, stroke)));
      images.push(state.images.map((image) => imageToYMap(Y, image)));
    }, origin);
    return doc;
  }

  return {
    // meta
    APP_NAME,
    UNTITLED,
    FILE_FORMAT_VERSION,
    MENU_ACTIONS,
    formatTitle,
    StateFormatError,

    // strona
    PAGE_WIDTH,
    MAX_PAGE_HEIGHT,
    TILE_HEIGHT,
    GRID_SIZE,

    // enumy i limity
    TOOLS,
    BRUSHES,
    ERASE_MODES,
    BACKGROUNDS,
    MIN_STROKE_SIZE,
    MAX_STROKE_SIZE,
    MAX_STROKE_POINTS,
    MAX_STROKES,
    MAX_IMAGES,
    MAX_IMAGE_BYTES,
    MAX_DOC_BYTES,

    // kalibracja pióra
    PRESSURE_GAMMA,
    MIN_WIDTH_FACTOR,
    MAX_WIDTH_FACTOR,
    DEFAULT_PRESSURE,
    MIN_POINT_DISTANCE,

    // geometria i rysowanie
    clamp,
    roundCoord,
    roundPressure,
    widthFactor,
    widthAt,
    maxWidth,
    segmentWidth,
    pointCount,
    shouldKeepPoint,
    strokeBounds,
    imageBounds,
    boundsIntersect,
    tileRange,
    distanceToSegmentSquared,
    eraseStroke,

    // konwersja Y.Doc
    STROKES_KEY,
    IMAGES_KEY,
    META_KEY,
    strokeToYMap,
    imageToYMap,
    ydocToState,
    stateToYDoc,

    // format
    createId,
    createEmptyState,
    validateStroke,
    validateImage,
    validateMeta,
    normalizeState,
  };
});
