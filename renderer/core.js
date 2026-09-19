// Logika bez DOM. Ładowana przez <script> w rendererze oraz przez require() w testach.
// Wszystko, co da się przetestować bez canvasa, mieszka tutaj, nie w renderer.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MathNotesCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const APP_NAME = 'MathNotes';
  const UNTITLED = 'Nowy notatnik';

  // Każda zmiana kształtu zapisywanego stanu = bump wersji + krok w normalizeState.
  const FILE_FORMAT_VERSION = 6;

  // Kartka, nie płótno: stała szerokość, przewijanie w dół.
  // Szerokość pola roboczego. Maksymalne oddalenie pokazuje dokładnie tyle —
  // ani piksela pustki obok — więc wszystko, co widać, da się zapisać.
  const PAGE_WIDTH = 2400;
  // Strona wczytanego PDF-a jest węższa niż pole robocze i wyśrodkowana.
  // Paski po bokach to margines na notatki i pisze się po nich normalnie.
  const PDF_PAGE_WIDTH = 1600;
  // Zero luzu: każdy pas, który widać, ma być do pisania. Inaczej pióro
  // przyciśnięte poza kartką dociskało punkt do krawędzi i kreska „teleportowała się".
  const PAGE_PAN_MARGIN = 0;
  // O ile kartka wyprzedza notatki. Nie jest nieskończona od początku —
  // wydłuża się sama, gdy schodzisz coraz niżej.
  const PAGE_GROW_AHEAD = 1600;
  // Pion jest „nieskończony”, ale nie nieograniczony — walidacja musi mieć
  // czego się trzymać, a kafle muszą się kiedyś kończyć.
  const MAX_PAGE_HEIGHT = 2000000;
  // Cache gotowych kresek trzymamy w kafelkach w pionie.
  const TILE_HEIGHT = 2000;

  // Granice, w których w ogóle może istnieć atrament.
  const MIN_WORLD_X = -PAGE_PAN_MARGIN;
  const MAX_WORLD_X = PAGE_WIDTH + PAGE_PAN_MARGIN;
  const MIN_WORLD_Y = -PAGE_PAN_MARGIN;
  const MAX_WORLD_Y = MAX_PAGE_HEIGHT;

  // --- Kratka w tle --------------------------------------------------------
  // Bazowy rozstaw w jednostkach świata. Przy przybliżaniu w oczka wchodzą
  // kolejne podziałki, przy oddalaniu największe linie się zlewają — dlatego
  // krok dobiera się do skali, a nie jest stały.
  const GRID_BASE = 50;
  const GRID_DIVISIONS = 5;
  // Poniżej tylu pikseli na ekranie linie zlewają się w szarość.
  const GRID_MIN_SCREEN = 7;
  const DEFAULT_GRID = Object.freeze({ enabled: false, color: '#4c8dff', opacity: 0.18 });

  const THEMES = Object.freeze(['dark', 'light']);

  const TOOLS = Object.freeze(['pen']);
  const BRUSHES = Object.freeze(['pen', 'soft']);
  const ERASE_MODES = Object.freeze(['object', 'area']);

  const MIN_STROKE_SIZE = 1;
  const MAX_STROKE_SIZE = 30;

  // Limity z sekcji 7 instrukcji — dane od innych osób są niezaufane.
  const MAX_STROKE_POINTS = 20000;
  const MAX_STROKES = 50000;
  const MAX_IMAGES = 1000;
  const MAX_ANNOTATIONS = 2000;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  // --- Wczytany PDF --------------------------------------------------------
  // Strony PDF-a wjeżdżają do notatnika jako zablokowane obrazy tła: nie da się
  // ich chwycić ani przesunąć, a atrament leży na nich tak samo jak na kratce.
  const PDF_PAGE_GAP = 48;
  // Powyżej tego i tak nikt nie pisze po wszystkim, a plik rósłby bez sensu.
  const MAX_PDF_PAGES = 100;
  // Szerokość rastra jednej strony w pikselach. Kartka ma 1600 jednostek, więc
  // 2400 px zostaje ostre mniej więcej do 150 % powiększenia. Wyżej rośnie już
  // tylko waga pliku: każda strona to osobny obraz w notatniku.
  const PDF_RENDER_WIDTH = 2400;
  const MAX_TITLE_LENGTH = 200;
  const MAX_LABEL_LENGTH = 120;
  // Sesja online przerywa się po przekroczeniu tego rozmiaru dokumentu.
  const MAX_DOC_BYTES = 200 * 1024 * 1024;

  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const DATA_URL_PREFIX_RE = /^data:image\/(png|jpeg|webp);base64,/;
  const BASE64_BODY_RE = /^[A-Za-z0-9+/]*={0,2}$/;

  // --- Kalibracja pióra -----------------------------------------------------
  // Sprzęt nigdy nie jest idealny: różne tablety mapują nacisk inaczej, a część
  // urządzeń nie zgłasza go wcale. To są pokrętła do strojenia, nie stałe fizyczne.
  const PRESSURE_BASE = 0.3; // szerokość przy zerowym nacisku
  const PRESSURE_RANGE = 1.5; // ile dokłada pełny nacisk
  const MAX_PRESSURE_FACTOR = PRESSURE_BASE + PRESSURE_RANGE;
  const DEFAULT_PRESSURE = 0.5; // gdy urządzenie nie zgłasza nacisku
  // Miękki pędzel narasta przez tyle pierwszych punktów, jak przy dotknięciu pędzlem.
  const TAPER_RAMP = 6;
  // Poświata miękkiego pędzla, w wielokrotnościach grubości.
  const SOFT_GLOW = 0.6;
  const SOFT_ALPHA = 0.6;
  // Próbki bliżej niż to od ostatniego zachowanego punktu odrzucamy.
  const MIN_POINT_SPACING = 1.2;
  // Wygładzanie drgań tabletu: ile wagi ma poprzedni punkt.
  const SMOOTHING = 0.3;

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
    'file:export-pdf',
    'file:import-pdf',
    'edit:undo',
    'edit:redo',
    'edit:keymap',
    'view:annotation-lines',
    'view:grid',
    'view:theme',
    'view:reset',
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

  // Znaki sterujące, zero-width i przesterowanie kierunku pisma potrafią zmylić
  // wzrokowo nawet w textContent.
  const UNSAFE_TEXT_CHARS = new RegExp(
    '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\ufeff]',
    'g',
  );

  function sanitizeText(raw, maxLength) {
    return String(raw).replace(UNSAFE_TEXT_CHARS, '').trim().slice(0, maxLength);
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

  // Status notatnika żyje w tytule okna — świadomie zamiast paska stanu,
  // który zjadałby pion ekranu na tablecie.
  function formatTitle(name, dirty) {
    const label = name && String(name).trim() ? String(name).trim() : UNTITLED;
    return APP_NAME + ' — ' + label + (dirty ? ' •' : '');
  }

  // ==========================================================================
  // Szerokość kreski — wspólna dla obu ścieżek renderowania
  // ==========================================================================

  function pressureFactor(pressureEnabled, p) {
    if (pressureEnabled === false) return 1;
    const pr = isFiniteNumber(p) && p > 0 ? clamp(p, 0, 1) : DEFAULT_PRESSURE;
    return PRESSURE_BASE + pr * PRESSURE_RANGE;
  }

  /**
   * Narastanie miękkiego pędzla na starcie kreski. KRYTYCZNE: zależy wyłącznie
   * od indeksu liczonego OD POCZĄTKU, nigdy od długości kreski ani odległości
   * od jej końca. Inaczej ścieżka inkrementalna (drawLatestSegment) policzyłaby
   * inną szerokość niż kanoniczna (drawStroke) i linia „skoczyłaby” w momencie
   * puszczenia pióra.
   */
  function taperFactor(index) {
    return index < TAPER_RAMP ? (index + 1) / (TAPER_RAMP + 1) : 1;
  }

  function widthFactor(stroke, p, index) {
    let factor = pressureFactor(stroke.pressureEnabled, p);
    if (stroke.brush === 'soft' && typeof index === 'number') factor *= taperFactor(index);
    return factor;
  }

  function pointCount(stroke) {
    return stroke && stroke.pts ? Math.floor(stroke.pts.length / 3) : 0;
  }

  function pointAt(stroke, i) {
    return { x: stroke.pts[i * 3], y: stroke.pts[i * 3 + 1], p: stroke.pts[i * 3 + 2] };
  }

  /** Szerokość kreski w punkcie o indeksie i. Obie ścieżki renderowania wołają to samo. */
  function widthAt(stroke, i) {
    return stroke.size * widthFactor(stroke, stroke.pts[i * 3 + 2], i);
  }

  function maxWidth(stroke) {
    const base = stroke.size * MAX_PRESSURE_FACTOR;
    // Miękki pędzel rozlewa się poświatą poza własną grubość.
    return stroke.brush === 'soft' ? base + stroke.size * SOFT_GLOW : base;
  }

  // ==========================================================================
  // Wygładzanie
  // ==========================================================================

  /**
   * Lekkie wygładzenie wykładnicze przychodzącej pozycji plus odrzucenie próbek
   * gęstszych niż MIN_POINT_SPACING. Filtr jest przyczynowy: dotyka tylko nowego
   * punktu i nigdy nie poprawia wcześniejszych — każde wygładzanie wstecz
   * rozjechałoby ścieżkę inkrementalną z kanoniczną.
   * @returns {{x: number, y: number} | null} null, gdy punkt należy pominąć
   */
  function smoothPoint(lastX, lastY, x, y) {
    if (!isFiniteNumber(lastX) || !isFiniteNumber(lastY)) return { x, y };
    const sx = lastX * SMOOTHING + x * (1 - SMOOTHING);
    const sy = lastY * SMOOTHING + y * (1 - SMOOTHING);
    if (Math.hypot(sx - lastX, sy - lastY) < MIN_POINT_SPACING) return null;
    return { x: sx, y: sy };
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

  // Promień gumki na ekranie, wspólny dla kursora i trafień — okrąg, który
  // widzisz, jest dokładnie obszarem, który zostanie skasowany.
  function eraserScreenRadius(size) {
    return clamp(size * 1.4, 6, 28);
  }

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
   * @param {string} mode 'object' kasuje całą kreskę, 'area' wycina fragment
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
    if (mode !== 'area') return [];

    // ponytail: cięcie przebiega po granicy punktu, nie po dokładnym przecięciu
    // z okręgiem. Przy typowym rozstawie próbek różnica jest podpikselowa;
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

  /** Czy gumka sięga obrazu (obrazów nie da się kasować częściowo). */
  function eraseHitsImage(image, cx, cy, radius) {
    return (
      cx >= image.x - radius &&
      cx <= image.x + image.w + radius &&
      cy >= image.y - radius &&
      cy <= image.y + image.h + radius
    );
  }

  // ==========================================================================
  // Przekształcanie zaznaczenia
  // ==========================================================================

  /**
   * Punkt po przeskalowaniu względem `origin` i przesunięciu.
   * @param {{ox: number, oy: number, k: number, dx: number, dy: number}} t
   */
  function applyTransform(x, y, t) {
    return { x: (x - t.ox) * t.k + t.ox + t.dx, y: (y - t.oy) * t.k + t.oy + t.dy };
  }

  function transformBounds(bounds, t) {
    const a = applyTransform(bounds.minX, bounds.minY, t);
    const b = applyTransform(bounds.maxX, bounds.maxY, t);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }

  /** Nowe `pts` i grubość kreski po przekształceniu. Nie mutuje oryginału. */
  function transformStroke(stroke, t) {
    const pts = stroke.pts.slice();
    for (let i = 0; i < pts.length; i += 3) {
      const p = applyTransform(pts[i], pts[i + 1], t);
      pts[i] = roundCoord(p.x);
      pts[i + 1] = roundCoord(p.y);
    }
    return { pts, size: clamp(stroke.size * t.k, MIN_STROKE_SIZE, MAX_STROKE_SIZE) };
  }

  function transformImage(image, t) {
    const topLeft = applyTransform(image.x, image.y, t);
    return {
      x: roundCoord(topLeft.x),
      y: roundCoord(topLeft.y),
      w: roundCoord(image.w * t.k),
      h: roundCoord(image.h * t.k),
    };
  }

  function unionBounds(list) {
    let out = null;
    for (const bounds of list) {
      if (!bounds) continue;
      if (!out) out = { ...bounds };
      else {
        out.minX = Math.min(out.minX, bounds.minX);
        out.minY = Math.min(out.minY, bounds.minY);
        out.maxX = Math.max(out.maxX, bounds.maxX);
        out.maxY = Math.max(out.maxY, bounds.maxY);
      }
    }
    return out;
  }

  function boundsInside(inner, outer) {
    return (
      inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY
    );
  }

  /**
   * Prostokąt obrazu zmieszczony w granicach kartki: najpierw skala, potem
   * dosunięcie. Bez tego wklejony przy oddaleniu obraz wychodzi poza kartkę
   * i odpada na walidacji.
   */
  function fitImageIntoPage(width, height, centerX, centerY, maxFraction) {
    const limitW = (MAX_WORLD_X - MIN_WORLD_X) * (maxFraction || 0.8);
    const limitH = Math.min(limitW * 2, MAX_WORLD_Y - MIN_WORLD_Y);
    const k = Math.min(1, limitW / width, limitH / height);
    const w = roundCoord(Math.max(1, width * k));
    const h = roundCoord(Math.max(1, height * k));
    return {
      w,
      h,
      x: roundCoord(clamp(centerX - w / 2, MIN_WORLD_X, MAX_WORLD_X - w)),
      y: roundCoord(clamp(centerY - h / 2, MIN_WORLD_Y, MAX_WORLD_Y - h)),
    };
  }

  // ==========================================================================
  // Walidacja — fail closed
  // ==========================================================================

  /**
   * Czy w tym miejscu w ogóle może powstać atrament. Renderer pyta o to PRZED
   * rozpoczęciem kreski: dociskanie punktu do krawędzi dawało kreskę, która
   * pojawiała się gdzie indziej niż pióro — wyglądało to jak teleportacja.
   */
  function pointInPage(x, y) {
    return validPoint(x, y);
  }

  function validPoint(x, y) {
    return (
      isFiniteNumber(x) &&
      isFiniteNumber(y) &&
      x >= MIN_WORLD_X &&
      x <= MAX_WORLD_X &&
      y >= MIN_WORLD_Y &&
      y <= MAX_WORLD_Y
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
    if (typeof value.pressureEnabled !== 'boolean') return null;

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
      pressureEnabled: value.pressureEnabled,
      pts,
    };
  }

  /**
   * Układa strony PDF-a w pionie, każdą na pełną szerokość kartki.
   * Czysta geometria: renderer podaje rozmiary stron z pdf.js, dostaje
   * prostokąty świata. Dzięki temu układ da się przetestować bez canvasa.
   * @param {{width: number, height: number}[]} sizes rozmiary stron
   * @param {number} [startY] od jakiej wysokości układać — nowy PDF ląduje pod
   *   tym, co już jest w notatniku, więc nic się nie przykrywa
   * @returns {{x: number, y: number, w: number, h: number}[] | null}
   */
  function layoutPdfPages(sizes, startY) {
    if (!Array.isArray(sizes) || sizes.length === 0) return null;
    if (startY !== undefined && (!isFiniteNumber(startY) || startY < 0)) return null;
    const out = [];
    let y = startY || 0;
    for (const size of sizes) {
      if (!isPlainObject(size)) return null;
      if (!isFiniteNumber(size.width) || !isFiniteNumber(size.height)) return null;
      if (size.width <= 0 || size.height <= 0) return null;

      const h = roundCoord(PDF_PAGE_WIDTH * (size.height / size.width));
      if (h <= 0) return null;
      // Świat kończy się w pionie; dalszych stron po prostu nie ma gdzie położyć.
      if (y + h > MAX_WORLD_Y) break;

      out.push({ x: roundCoord((PAGE_WIDTH - PDF_PAGE_WIDTH) / 2), y: roundCoord(y), w: PDF_PAGE_WIDTH, h });
      y += h + PDF_PAGE_GAP;
    }
    return out.length > 0 ? out : null;
  }

  // --- Prostowanie kreski przytrzymaniem ------------------------------------
  // Krótsza kreska nie ma sensownego kierunku, więc jej nie prostujemy.
  const MIN_STRAIGHTEN_LENGTH = 40;
  // Największe dopuszczalne odchylenie od cięciwy, jako ułamek jej długości.
  // Ręcznie ciągnięta „prosta" gubi się o kilka procent; łuk rysowany celowo
  // wychodzi grubo powyżej i ma zostać łukiem.
  const STRAIGHTEN_TOLERANCE = 0.12;

  /**
   * Zamienia kreskę w odcinek od pierwszego do ostatniego punktu — ale tylko
   * wtedy, gdy ona i tak już jest prawie prosta.
   * @returns {number[] | null} nowe `pts` albo null, gdy to nie jest prosta
   */
  function straightenStroke(stroke) {
    const n = pointCount(stroke);
    if (n < 3) return null;
    const pts = stroke.pts;

    const x0 = pts[0];
    const y0 = pts[1];
    const x1 = pts[(n - 1) * 3];
    const y1 = pts[(n - 1) * 3 + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (!isFiniteNumber(len) || len < MIN_STRAIGHTEN_LENGTH) return null;

    let maxDev = 0;
    for (let i = 1; i < n - 1; i++) {
      const px = pts[i * 3];
      const py = pts[i * 3 + 1];
      // Odległość punktu od prostej przez (x0,y0) i (x1,y1).
      const dev = Math.abs(dx * (y0 - py) - (x0 - px) * dy) / len;
      if (dev > maxDev) maxDev = dev;
    }
    if (maxDev > len * STRAIGHTEN_TOLERANCE) return null;

    return [
      roundCoord(x0),
      roundCoord(y0),
      roundPressure(pts[2]),
      roundCoord(x1),
      roundCoord(y1),
      roundPressure(pts[(n - 1) * 3 + 2]),
    ];
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
    // Rozmiar sprawdzamy przed regexem, żeby nie puszczać wyrażenia po 5 MB tekstu.
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
      // Strona wczytanego PDF-a. Zablokowanego obrazu nie da się zaznaczyć ani
      // przesunąć — inaczej jedno pociągnięcie kursorem rozjechałoby tło pod
      // całą notatką. Wszystko inne (w tym pliki sprzed wersji 5) jest wolne.
      locked: value.locked === true,
      // Oryginalny rozmiar strony PDF-a w punktach. Trzymamy go, żeby eksport
      // mógł oddać dokument w tym formacie, w którym przyszedł, a nie w A4.
      ...sourceSize(value),
    };
  }

  /** @returns {{srcW: number, srcH: number} | {}} */
  function sourceSize(value) {
    if (!isFiniteNumber(value.srcW) || !isFiniteNumber(value.srcH)) return {};
    if (value.srcW <= 0 || value.srcH <= 0) return {};
    // Rozmiary arkuszy nie bywają większe niż kilka metrów; reszta to bzdura.
    if (value.srcW > 20000 || value.srcH > 20000) return {};
    return { srcW: roundCoord(value.srcW), srcH: roundCoord(value.srcH) };
  }

  function validateAnnotation(value) {
    if (!isPlainObject(value)) return null;
    if (typeof value.id !== 'string' || !ID_RE.test(value.id)) return null;
    if (!isFiniteNumber(value.y) || value.y < MIN_WORLD_Y || value.y > MAX_WORLD_Y) return null;
    const label = sanitizeText(typeof value.label === 'string' ? value.label : '', MAX_LABEL_LENGTH);
    return { id: value.id, y: roundCoord(value.y), label: label || 'Bez nazwy' };
  }

  function validateGrid(value) {
    const grid = isPlainObject(value) ? value : {};
    return {
      enabled: grid.enabled === true,
      color: typeof grid.color === 'string' && COLOR_RE.test(grid.color) ? grid.color : DEFAULT_GRID.color,
      opacity: isFiniteNumber(grid.opacity) ? clamp(grid.opacity, 0.02, 1) : DEFAULT_GRID.opacity,
    };
  }

  function validateMeta(value) {
    const meta = isPlainObject(value) ? value : {};
    return {
      title: sanitizeText(typeof meta.title === 'string' ? meta.title : '', MAX_TITLE_LENGTH),
      grid: validateGrid(meta.grid),
    };
  }

  /**
   * Rozstaw kratki dobrany do powiększenia. Zwraca krok drobny i gruby
   * w jednostkach świata; gruby to zawsze GRID_DIVISIONS razy drobny.
   */
  function gridStep(scale) {
    let minor = GRID_BASE;
    // Za gęsto na ekranie — bierzemy większy krok.
    while (minor * scale < GRID_MIN_SCREEN) minor *= GRID_DIVISIONS;
    // Za rzadko — schodzimy w podziałki, ale tylko póki zostają czytelne.
    while ((minor / GRID_DIVISIONS) * scale >= GRID_MIN_SCREEN) minor /= GRID_DIVISIONS;
    return { minor, major: minor * GRID_DIVISIONS };
  }

  /**
   * Atrament dopasowany do motywu. Biała kreska na białej kartce byłaby
   * niewidoczna, więc skrajne szarości są odwracane; nasycone kolory zostają,
   * bo czytają się na obu tłach.
   */
  function themeInk(color, theme) {
    if (theme !== 'light') return color;
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread > 40) return color; // kolorowe zostaje kolorowe
    const inverted = 255 - Math.round((r + g + b) / 3);
    const hex = Math.max(0, Math.min(255, inverted)).toString(16).padStart(2, '0');
    return '#' + hex + hex + hex;
  }

  // ==========================================================================
  // Format pliku
  // ==========================================================================

  function createEmptyState() {
    return {
      version: FILE_FORMAT_VERSION,
      meta: { title: '', grid: { ...DEFAULT_GRID } },
      strokes: [],
      images: [],
      annotations: [],
    };
  }

  /**
   * v1 → v2: kształt sprzed przejścia na Yjs, zapisywany przez MathNotes 1.0.
   * Punkty były obiektami {x, y, p}, grubość nazywała się `width`, a pliki
   * w ogóle nie miały pola `version`.
   */
  function migrateV1ToV2(raw) {
    const strokes = Array.isArray(raw.strokes) ? raw.strokes : [];
    return {
      version: 2,
      meta: raw.meta,
      images: Array.isArray(raw.images)
        ? raw.images.map((image) => {
            if (!isPlainObject(image)) return image;
            const { width, height, ...rest } = image;
            return { ...rest, w: width, h: height };
          })
        : [],
      annotations: raw.annotations,
      strokes: strokes.map((stroke) => {
        if (!isPlainObject(stroke)) return stroke;
        const pts = [];
        for (const point of Array.isArray(stroke.points) ? stroke.points : []) {
          if (!isPlainObject(point)) continue;
          pts.push(point.x, point.y, isFiniteNumber(point.p) ? point.p : DEFAULT_PRESSURE);
        }
        const { points, width, ...rest } = stroke;
        return {
          ...rest,
          tool: 'pen',
          brush: stroke.brush === 'soft' ? 'soft' : 'pen',
          size: isFiniteNumber(width) ? width : 4,
          // v1 zapisywał to pole, ale starsze pliki mogą go nie mieć.
          pressureEnabled: stroke.pressureEnabled === true,
          pts,
        };
      }),
    };
  }

  /** v2 → v3: dochodzą adnotacje, a tło strony znika razem z polem meta.background. */
  function migrateV2ToV3(raw) {
    return {
      version: 3,
      meta: { title: isPlainObject(raw.meta) ? raw.meta.title : '' },
      strokes: Array.isArray(raw.strokes) ? raw.strokes : [],
      images: Array.isArray(raw.images) ? raw.images : [],
      annotations: Array.isArray(raw.annotations) ? raw.annotations : [],
    };
  }

  /** v3 → v4: ustawienia kratki wjeżdżają do meta. */
  function migrateV3ToV4(raw) {
    return { ...raw, version: 4, meta: { ...(isPlainObject(raw.meta) ? raw.meta : {}), grid: DEFAULT_GRID } };
  }

  // Obrazy sprzed wersji 5 to wyłącznie rzeczy wklejone ręcznie, a te mają
  // zostać ruchome. Nowe pole dostaje więc jawne `false`, a nie brak wartości.
  function migrateV4ToV5(raw) {
    const images = Array.isArray(raw.images) ? raw.images : [];
    return {
      ...raw,
      version: 5,
      images: images.map((image) => (isPlainObject(image) ? { ...image, locked: false } : image)),
    };
  }

  // Wersja 6 dokłada oryginalny rozmiar strony PDF-a (srcW/srcH). Starsze pliki
  // go nie mają i nie da się go odtworzyć — eksport użyje wtedy proporcji obrazu.
  function migrateV5ToV6(raw) {
    return { ...raw, version: 6 };
  }

  const MIGRATIONS = {
    1: migrateV1ToV2,
    2: migrateV2ToV3,
    3: migrateV3ToV4,
    4: migrateV4ToV5,
    5: migrateV5ToV6,
  };

  /**
   * Doprowadza surowy JSON z pliku (albo z sesji) do bieżącego formatu.
   * Elementy, które nie przejdą walidacji, są pomijane — a nie po cichu naprawiane.
   * @returns {{state: object, skipped: {strokes: number, images: number, annotations: number}}}
   */
  function normalizeState(raw) {
    if (!isPlainObject(raw)) {
      throw new StateFormatError('INVALID_STATE', 'Stan notatnika musi być obiektem.');
    }

    let version = Number.isInteger(raw.version) ? raw.version : 1; // brak wersji = format 1.0
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

    const skipped = { strokes: 0, images: 0, annotations: 0 };

    const take = (list, target, limit, validate, counter) => {
      for (const item of Array.isArray(list) ? list : []) {
        if (target.length >= limit) {
          skipped[counter] += 1;
          continue;
        }
        const ok = validate(item);
        if (ok) target.push(ok);
        else skipped[counter] += 1;
      }
    };

    take(value.strokes, state.strokes, MAX_STROKES, validateStroke, 'strokes');
    take(value.images, state.images, MAX_IMAGES, validateImage, 'images');
    take(value.annotations, state.annotations, MAX_ANNOTATIONS, validateAnnotation, 'annotations');

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
  const ANNOTATIONS_KEY = 'annotations';
  const META_KEY = 'meta';

  function strokeToYMap(Y, stroke) {
    const map = new Y.Map();
    map.set('id', stroke.id);
    map.set('tool', stroke.tool);
    map.set('brush', stroke.brush);
    map.set('color', stroke.color);
    map.set('size', stroke.size);
    map.set('pressureEnabled', stroke.pressureEnabled);
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
    map.set('locked', image.locked === true);
    if (isFiniteNumber(image.srcW) && isFiniteNumber(image.srcH)) {
      map.set('srcW', image.srcW);
      map.set('srcH', image.srcH);
    }
    return map;
  }

  function annotationToYMap(Y, annotation) {
    const map = new Y.Map();
    map.set('id', annotation.id);
    map.set('y', annotation.y);
    map.set('label', annotation.label);
    return map;
  }

  function toJSON(item) {
    return item && typeof item.toJSON === 'function' ? item.toJSON() : item;
  }

  /**
   * Y.Doc → stan do zapisania w pliku. Zawartość dokumentu mogła przyjść od
   * innych osób, więc każdy element przechodzi walidację; niepoprawne odpadają.
   * @returns {{state: object, skipped: {strokes: number, images: number, annotations: number}}}
   */
  function ydocToState(doc) {
    const state = createEmptyState();
    const skipped = { strokes: 0, images: 0, annotations: 0 };

    state.meta = validateMeta(doc.getMap(META_KEY).toJSON());

    const take = (array, target, limit, validate, counter) => {
      for (const item of array) {
        if (target.length >= limit) {
          skipped[counter] += 1;
          continue;
        }
        const ok = validate(toJSON(item));
        if (ok) target.push(ok);
        else skipped[counter] += 1;
      }
    };

    take(doc.getArray(STROKES_KEY), state.strokes, MAX_STROKES, validateStroke, 'strokes');
    take(doc.getArray(IMAGES_KEY), state.images, MAX_IMAGES, validateImage, 'images');
    take(doc.getArray(ANNOTATIONS_KEY), state.annotations, MAX_ANNOTATIONS, validateAnnotation, 'annotations');

    return { state, skipped };
  }

  /** Stan z pliku → Y.Doc. Podmienia całą zawartość, nie dokleja. */
  function stateToYDoc(Y, doc, state, origin) {
    doc.transact(() => {
      const strokes = doc.getArray(STROKES_KEY);
      const images = doc.getArray(IMAGES_KEY);
      const annotations = doc.getArray(ANNOTATIONS_KEY);
      const meta = doc.getMap(META_KEY);

      strokes.delete(0, strokes.length);
      images.delete(0, images.length);
      annotations.delete(0, annotations.length);
      meta.clear();

      meta.set('title', state.meta.title);
      meta.set('grid', { ...state.meta.grid });
      strokes.push(state.strokes.map((stroke) => strokeToYMap(Y, stroke)));
      images.push(state.images.map((image) => imageToYMap(Y, image)));
      annotations.push(state.annotations.map((annotation) => annotationToYMap(Y, annotation)));
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

    // strona i świat
    PAGE_WIDTH,
    PDF_PAGE_WIDTH,
    PAGE_GROW_AHEAD,
    PAGE_PAN_MARGIN,
    MAX_PAGE_HEIGHT,
    TILE_HEIGHT,
    MIN_WORLD_X,
    MAX_WORLD_X,
    MIN_WORLD_Y,
    MAX_WORLD_Y,

    // kratka i motyw
    GRID_BASE,
    GRID_DIVISIONS,
    GRID_MIN_SCREEN,
    DEFAULT_GRID,
    THEMES,
    gridStep,
    themeInk,
    validateGrid,

    // zaznaczenie
    applyTransform,
    transformBounds,
    transformStroke,
    transformImage,
    unionBounds,
    boundsInside,
    fitImageIntoPage,
    layoutPdfPages,
    pointInPage,
    straightenStroke,
    MIN_STRAIGHTEN_LENGTH,
    STRAIGHTEN_TOLERANCE,

    // enumy i limity
    TOOLS,
    BRUSHES,
    ERASE_MODES,
    MIN_STROKE_SIZE,
    MAX_STROKE_SIZE,
    MAX_STROKE_POINTS,
    MAX_STROKES,
    MAX_IMAGES,
    MAX_ANNOTATIONS,
    MAX_IMAGE_BYTES,
    PDF_PAGE_GAP,
    MAX_PDF_PAGES,
    PDF_RENDER_WIDTH,
    MAX_LABEL_LENGTH,
    MAX_DOC_BYTES,

    // kalibracja pióra
    PRESSURE_BASE,
    PRESSURE_RANGE,
    MAX_PRESSURE_FACTOR,
    DEFAULT_PRESSURE,
    TAPER_RAMP,
    SOFT_GLOW,
    SOFT_ALPHA,
    MIN_POINT_SPACING,
    SMOOTHING,

    // geometria i rysowanie
    clamp,
    sanitizeText,
    roundCoord,
    roundPressure,
    pressureFactor,
    taperFactor,
    widthFactor,
    widthAt,
    maxWidth,
    pointCount,
    pointAt,
    smoothPoint,
    strokeBounds,
    imageBounds,
    boundsIntersect,
    tileRange,
    eraserScreenRadius,
    distanceToSegmentSquared,
    eraseStroke,
    eraseHitsImage,

    // konwersja Y.Doc
    STROKES_KEY,
    IMAGES_KEY,
    ANNOTATIONS_KEY,
    META_KEY,
    strokeToYMap,
    imageToYMap,
    annotationToYMap,
    ydocToState,
    stateToYDoc,

    // format
    createId,
    createEmptyState,
    validateStroke,
    validateImage,
    validateAnnotation,
    validateMeta,
    normalizeState,
  };
});
