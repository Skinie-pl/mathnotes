'use strict';

// Okablowanie DOM/canvas. Logika bez DOM mieszka w renderer/core.js,
// mutacje dokumentu w renderer/doc.js, sesja online w renderer/online.js.
(function () {
  const core = window.MathNotesCore;
  const { NotebookDoc } = window.MathNotesDoc;
  const onlineApi = window.MathNotesOnline;
  const { Y } = window.Collab;

  const TAU = Math.PI * 2;
  const HOLD_MS = 420;
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 20;
  // Powyżej tej skali cache'u rysujemy kreski wprost zamiast z kafli: przy
  // powiększeniu widać ich mało, a obraz zostaje ostry zamiast rozciągniętego.
  const MAX_CACHE_SCALE = 2;
  // Cudza kreska rośnie punkt po punkcie. Póki rośnie, żyje na wierzchu i nie
  // trafia do kafli — inaczej każdy punkt przebudowywałby cały kafel.
  const LIVE_STROKE_QUIET_MS = 400;
  const AUTOSAVE_INTERVAL_MS = 10 * 60 * 1000;
  const MIN_IMAGE_SIZE = 12;
  const PDF_MAX_PAGES = 300;
  const PASTE_STORE_SCALE = 2;

  const DEFAULT_COLORS = ['#ffffff', '#ff5c5c', '#5cb8ff', '#5cff8f', '#ffd75c'];
  const PREFS_KEY = 'mathnotes-prefs';
  const KEYMAP_KEY = 'mathnotes-keymap';

  const $ = (id) => document.getElementById(id);

  const canvas = $('canvas');
  const mainArea = $('main-area');
  const peersLayer = $('peers');
  // desynchronized zmniejsza opóźnienie między piórem a pikselem na ekranie.
  const ctx = canvas.getContext('2d', { desynchronized: true });

  // ==========================================================================
  // Ustawienia użytkownika
  // ==========================================================================

  function loadPrefs() {
    try {
      return JSON.parse(window.localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ brushType, eraseMode, currentColor, currentWidth, pressureSensitive, customColors }),
      );
    } catch {
      // Brak localStorage nie może wywalić rysowania.
    }
  }

  const prefs = loadPrefs();

  const isColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

  let customColors =
    Array.isArray(prefs.customColors) && prefs.customColors.length === 5 && prefs.customColors.every(isColor)
      ? prefs.customColors.slice()
      : DEFAULT_COLORS.slice();

  let tool = 'pen'; // pen | eraser | cursor
  let brushType = core.BRUSHES.includes(prefs.brushType) ? prefs.brushType : 'pen';
  let eraseMode = core.ERASE_MODES.includes(prefs.eraseMode) ? prefs.eraseMode : 'object';
  let currentColor = isColor(prefs.currentColor) ? prefs.currentColor : customColors[0];
  let currentWidth = core.clamp(
    Number.isFinite(prefs.currentWidth) ? prefs.currentWidth : 4,
    core.MIN_STROKE_SIZE,
    core.MAX_STROKE_SIZE,
  );
  // Domyślnie wyłączony, tak jak w poprzedniej wersji programu.
  let pressureSensitive = prefs.pressureSensitive === true;

  // ==========================================================================
  // Widok
  // ==========================================================================

  // Współrzędne świata lewego górnego rogu ekranu plus powiększenie.
  let view = { x: 0, y: 0, scale: 1 };
  let dpr = window.devicePixelRatio || 1;
  let viewW = 0;
  let viewH = 0;
  let showAnnotationLines = true;

  // Kartka ma stałą szerokość, więc widok nie wędruje na boki — poza drobnym
  // luzem, żeby krawędź nie sprawiała wrażenia ściany.
  function clampViewX(x, scale) {
    const viewportWorldWidth = viewW / scale;
    const minX = -core.PAGE_PAN_MARGIN;
    const maxX = Math.max(minX, core.PAGE_WIDTH - viewportWorldWidth + core.PAGE_PAN_MARGIN);
    return core.clamp(x, minX, maxX);
  }

  // Notatnik ciągnie się w dół bez końca, ale nad górną krawędzią kartki
  // nie ma czego szukać.
  function clampViewY(y) {
    return core.clamp(y, -core.PAGE_PAN_MARGIN, core.MAX_WORLD_Y);
  }

  function screenToWorld(sx, sy) {
    return { x: view.x + sx / view.scale, y: view.y + sy / view.scale };
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  }

  function clampWorld(point) {
    return {
      x: core.clamp(point.x, core.MIN_WORLD_X, core.MAX_WORLD_X),
      y: core.clamp(point.y, core.MIN_WORLD_Y, core.MAX_WORLD_Y),
    };
  }

  // ==========================================================================
  // Dokument
  // ==========================================================================

  let notebook = new NotebookDoc(Y);
  let detachNotebook = null;
  let docName = null;
  let dirty = false;

  const strokeCache = new Map(); // Y.Map -> { stroke, bounds } | null
  const bitmaps = new Map(); // id obrazu -> ImageBitmap | null
  const liveStrokes = new Map(); // Y.Map -> { drawn: number, timer: number }

  let activeStrokeMap = null;
  let activeStroke = null;
  let drawnUpTo = 0;
  let selectedImageId = null;

  function entryFor(map) {
    let entry = strokeCache.get(map);
    if (entry === undefined) {
      const stroke = core.validateStroke(map.toJSON());
      entry = stroke ? { stroke, bounds: core.strokeBounds(stroke) } : null;
      strokeCache.set(map, entry);
    }
    return entry;
  }

  function resetCaches() {
    strokeCache.clear();
    bitmaps.clear();
    for (const live of liveStrokes.values()) clearTimeout(live.timer);
    liveStrokes.clear();
    tiles.clear();
    selectedImageId = null;
    activeStrokeMap = null;
    activeStroke = null;
  }

  /**
   * Świeży dokument zamiast czyszczenia istniejącego. W CRDT skasowanie treści
   * to operacja, która rozeszłaby się po sesji i usunęła notatki pozostałym —
   * „nowy notatnik” musi być nowym Y.Doc, nie pustym starym.
   */
  function replaceNotebook() {
    if (detachNotebook) detachNotebook();
    notebook.destroy();
    notebook = new NotebookDoc(Y);
    detachNotebook = notebook.observe(handleDocChange);
    resetCaches();
  }

  // ==========================================================================
  // Cache kafli
  // ==========================================================================

  const tiles = new Map(); // indeks -> { canvas, ctx }

  function cacheScale() {
    return Math.min(dpr * view.scale, MAX_CACHE_SCALE);
  }

  function usesTiles() {
    return dpr * view.scale <= MAX_CACHE_SCALE;
  }

  function invalidateTiles(bounds) {
    const range = core.tileRange(bounds);
    if (!range) return;
    for (let i = range.first; i <= range.last; i++) tiles.delete(i);
  }

  function buildTile(index) {
    const s = cacheScale();
    const tile = { canvas: document.createElement('canvas') };
    tile.canvas.width = Math.max(1, Math.ceil((core.MAX_WORLD_X - core.MIN_WORLD_X) * s));
    tile.canvas.height = Math.max(1, Math.ceil(core.TILE_HEIGHT * s));
    tile.ctx = tile.canvas.getContext('2d');

    // Rysujemy w układzie świata; przesunięcie sprowadza kafel do jego wycinka.
    tile.ctx.setTransform(s, 0, 0, s, -core.MIN_WORLD_X * s, -index * core.TILE_HEIGHT * s);

    const top = index * core.TILE_HEIGHT;
    const clip = { minX: -Infinity, maxX: Infinity, minY: top, maxY: top + core.TILE_HEIGHT };

    drawImagesInto(tile.ctx, clip);
    for (const map of notebook.strokes) {
      if (liveStrokes.has(map)) continue; // rosnące kreski żyją na wierzchu
      const entry = entryFor(map);
      if (!entry || !core.boundsIntersect(entry.bounds, clip)) continue;
      drawStroke(tile.ctx, entry.stroke, s);
    }

    tiles.set(index, tile);
    return tile;
  }

  function evictDistantTiles(first, last) {
    for (const index of tiles.keys()) {
      if (index < first - 1 || index > last + 1) tiles.delete(index);
    }
  }

  // ==========================================================================
  // Obrazy
  // ==========================================================================

  async function decodeImage(image) {
    if (bitmaps.has(image.id)) return;
    bitmaps.set(image.id, null); // znacznik „w trakcie”, żeby nie dekodować dwa razy
    try {
      // Przez <img> + createImageBitmap, nigdy przez innerHTML. fetch odpada,
      // bo connect-src w CSP nie dopuszcza data:.
      const element = new Image();
      element.src = image.dataUrl;
      await element.decode();
      bitmaps.set(image.id, await createImageBitmap(element));
      invalidateTiles(core.imageBounds(image));
      scheduleRender();
    } catch {
      bitmaps.set(image.id, null); // uszkodzony obraz po prostu się nie pokaże
    }
  }

  function eachImage(callback) {
    for (const map of notebook.images) {
      const image = core.validateImage(map.toJSON());
      if (image) callback(image, map);
    }
  }

  function drawImagesInto(target, clip) {
    eachImage((image) => {
      if (!core.boundsIntersect(core.imageBounds(image), clip)) return;
      const bitmap = bitmaps.get(image.id);
      if (bitmap) target.drawImage(bitmap, image.x, image.y, image.w, image.h);
      else if (!bitmaps.has(image.id)) decodeImage(image);
    });
  }

  function findImageAt(point) {
    let hit = null;
    eachImage((image, map) => {
      if (
        point.x >= image.x &&
        point.x <= image.x + image.w &&
        point.y >= image.y &&
        point.y <= image.y + image.h
      ) {
        hit = { image, map }; // ostatni wygrywa — obrazy rysowane są po kolei
      }
    });
    return hit;
  }

  function selectedImage() {
    if (!selectedImageId) return null;
    const map = notebook.findImage(selectedImageId);
    if (!map) {
      selectedImageId = null;
      return null;
    }
    const image = core.validateImage(map.toJSON());
    return image ? { image, map } : null;
  }

  // ==========================================================================
  // Dwie ścieżki renderowania
  // ==========================================================================
  //
  // Obie liczą szerokość przez core.widthAt — to jest jedyny powód, dla którego
  // linia nie skacze w momencie puszczenia pióra.

  function applyStrokeStyle(target, stroke, scale) {
    target.lineCap = 'round';
    target.lineJoin = 'round';
    target.strokeStyle = stroke.color;
    target.fillStyle = stroke.color;
    if (stroke.brush === 'soft') {
      target.globalAlpha = core.SOFT_ALPHA;
      target.shadowColor = stroke.color;
      // shadowBlur nie podlega transformacji canvasa, więc skalę dokładamy sami —
      // inaczej poświata miałaby inny rozmiar w kaflu niż na ekranie.
      target.shadowBlur = stroke.size * core.SOFT_GLOW * scale;
    } else {
      target.globalAlpha = 1;
      target.shadowBlur = 0;
    }
  }

  function clearStrokeStyle(target) {
    target.globalAlpha = 1;
    target.shadowBlur = 0;
  }

  /**
   * Odcinek i → i+1 jako krzywa kwadratowa przez punkty środkowe (klasyczne
   * wygładzanie odręcznej kreski). Wydzielone, bo wołają to obie ścieżki.
   */
  function strokeSegment(target, stroke, i) {
    const p0 = core.pointAt(stroke, i - 1);
    const p1 = core.pointAt(stroke, i);
    const p2 = core.pointAt(stroke, i + 1);
    target.lineWidth = core.widthAt(stroke, i);
    target.beginPath();
    target.moveTo((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
    target.quadraticCurveTo(p1.x, p1.y, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    target.stroke();
  }

  function strokeDot(target, stroke) {
    const p = core.pointAt(stroke, 0);
    target.beginPath();
    target.arc(p.x, p.y, core.widthAt(stroke, 0) / 2, 0, TAU);
    target.fill();
  }

  function strokeStraight(target, stroke) {
    const a = core.pointAt(stroke, 0);
    const b = core.pointAt(stroke, 1);
    target.lineWidth = (core.widthAt(stroke, 0) + core.widthAt(stroke, 1)) / 2;
    target.beginPath();
    target.moveTo(a.x, a.y);
    target.lineTo(b.x, b.y);
    target.stroke();
  }

  function strokeTail(target, stroke, n) {
    const prev = core.pointAt(stroke, n - 2);
    const last = core.pointAt(stroke, n - 1);
    target.lineWidth = core.widthAt(stroke, n - 1);
    target.beginPath();
    target.moveTo((prev.x + last.x) / 2, (prev.y + last.y) / 2);
    target.lineTo(last.x, last.y);
    target.stroke();
  }

  /** Kanoniczne, pełne przerysowanie: finalizacja, zoom, undo, cudze zmiany. */
  function drawStroke(target, stroke, scale) {
    const n = core.pointCount(stroke);
    if (n === 0) return;
    applyStrokeStyle(target, stroke, scale);

    if (n === 1) strokeDot(target, stroke);
    else if (n === 2) strokeStraight(target, stroke);
    else {
      for (let i = 1; i < n - 1; i++) strokeSegment(target, stroke, i);
      strokeTail(target, stroke, n);
    }

    clearStrokeStyle(target);
  }

  /**
   * Inkrementalne dorysowanie tylko tego, co przybyło od `fromPoint`, prosto
   * na wierzch bieżącego obrazu — bez czyszczenia i bez przerysowywania reszty.
   */
  function drawLatestSegment(target, stroke, fromPoint, scale) {
    const n = core.pointCount(stroke);
    if (n === 0) return;
    applyStrokeStyle(target, stroke, scale);

    if (n === 1) strokeDot(target, stroke);
    else if (n === 2) strokeStraight(target, stroke);
    else {
      // Ogon narysowany w poprzedniej klatce nadpisujemy właściwą krzywą.
      const from = Math.max(1, fromPoint - 1);
      for (let i = from; i < n - 1; i++) strokeSegment(target, stroke, i);
      strokeTail(target, stroke, n);
    }

    clearStrokeStyle(target);
  }

  // ==========================================================================
  // Adnotacje i zaznaczenie na canvasie
  // ==========================================================================

  function drawAnnotationLines(target, left, right, scale) {
    const list = notebook.annotationList();
    if (list.length === 0) return;

    target.save();
    target.globalAlpha = 0.65;
    target.strokeStyle = '#ff4444';
    target.lineWidth = 1.5 / scale;
    target.setLineDash([7 / scale, 5 / scale]);
    for (const annotation of list) {
      target.beginPath();
      target.moveTo(left, annotation.y);
      target.lineTo(right, annotation.y);
      target.stroke();
    }
    target.setLineDash([]);
    target.fillStyle = '#ff4444';
    target.font = 13 / scale + 'px sans-serif';
    target.textBaseline = 'bottom';
    for (const annotation of list) {
      target.fillText(annotation.label, left + 6 / scale, annotation.y - 3 / scale);
    }
    target.restore();
  }

  function handleCorners(image) {
    return [
      { id: 'nw', x: image.x, y: image.y },
      { id: 'ne', x: image.x + image.w, y: image.y },
      { id: 'sw', x: image.x, y: image.y + image.h },
      { id: 'se', x: image.x + image.w, y: image.y + image.h },
    ];
  }

  function findHandleAt(point) {
    const selected = selectedImage();
    if (!selected) return null;
    const hit = 14 / view.scale;
    for (const corner of handleCorners(selected.image)) {
      if (Math.abs(point.x - corner.x) <= hit && Math.abs(point.y - corner.y) <= hit) return corner.id;
    }
    return null;
  }

  function cursorForHandle(handle) {
    return handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
  }

  function drawSelection(target) {
    if (tool !== 'cursor') return;
    const selected = selectedImage();
    if (!selected) return;
    const { image } = selected;

    target.save();
    target.strokeStyle = '#3a5cff';
    target.lineWidth = 1.5 / view.scale;
    target.setLineDash([5 / view.scale, 4 / view.scale]);
    target.strokeRect(image.x, image.y, image.w, image.h);
    target.setLineDash([]);
    const size = 9 / view.scale;
    target.fillStyle = '#3a5cff';
    for (const corner of handleCorners(image)) {
      target.fillRect(corner.x - size / 2, corner.y - size / 2, size, size);
    }
    target.restore();
  }

  // ==========================================================================
  // Pełne przerysowanie
  // ==========================================================================

  let renderScheduled = false;

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function worldTransform(target) {
    target.setTransform(
      dpr * view.scale,
      0,
      0,
      dpr * view.scale,
      -view.x * view.scale * dpr,
      -view.y * view.scale * dpr,
    );
  }

  function render() {
    if (viewW === 0 || viewH === 0) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const visible = {
      minX: view.x,
      maxX: view.x + viewW / view.scale,
      minY: view.y,
      maxY: view.y + viewH / view.scale,
    };

    if (usesTiles()) {
      const range = core.tileRange(visible);
      evictDistantTiles(range.first, range.last);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const s = cacheScale();
      for (let i = range.first; i <= range.last; i++) {
        const tile = tiles.get(i) || buildTile(i);
        const left = (core.MIN_WORLD_X - view.x) * view.scale * dpr;
        const top = (i * core.TILE_HEIGHT - view.y) * view.scale * dpr;
        ctx.drawImage(
          tile.canvas,
          left,
          top,
          (tile.canvas.width / s) * view.scale * dpr,
          (tile.canvas.height / s) * view.scale * dpr,
        );
      }
      worldTransform(ctx);
    } else {
      // ponytail: powyżej MAX_CACHE_SCALE rysujemy wprost — kafel w tej skali
      // byłby ogromny, a widocznych kresek jest wtedy mało. Gdyby to zaczęło
      // zwalniać, następnym krokiem są kafle także w poziomie.
      tiles.clear();
      worldTransform(ctx);
      drawImagesInto(ctx, visible);
      for (const map of notebook.strokes) {
        if (liveStrokes.has(map)) continue;
        const entry = entryFor(map);
        if (!entry || !core.boundsIntersect(entry.bounds, visible)) continue;
        drawStroke(ctx, entry.stroke, view.scale);
      }
    }

    // Kreski, które właśnie rosną — moja i cudze.
    for (const [map, live] of liveStrokes) {
      const entry = entryFor(map);
      if (!entry) continue;
      drawStroke(ctx, entry.stroke, view.scale);
      live.drawn = core.pointCount(entry.stroke);
    }
    if (activeStroke && core.pointCount(activeStroke) > 0) {
      drawStroke(ctx, activeStroke, view.scale);
      drawnUpTo = core.pointCount(activeStroke);
    }

    if (showAnnotationLines) drawAnnotationLines(ctx, visible.minX, visible.maxX, view.scale);
    drawSelection(ctx);

    renderPeers();
  }

  /** Dorysowanie na wierzchu, bez czyszczenia — ścieżka o najniższym opóźnieniu. */
  function paintLive(stroke, fromPoint) {
    ctx.save();
    worldTransform(ctx);
    drawLatestSegment(ctx, stroke, fromPoint, view.scale);
    ctx.restore();
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    viewW = Math.max(1, Math.round(rect.width));
    viewH = Math.max(1, Math.round(rect.height));
    canvas.width = Math.max(1, Math.round(viewW * dpr));
    canvas.height = Math.max(1, Math.round(viewH * dpr));
    view.x = clampViewX(view.x, view.scale);
    tiles.clear();
    render();
  }

  // ==========================================================================
  // Reakcja na zmiany dokumentu
  // ==========================================================================

  function markLive(map) {
    let live = liveStrokes.get(map);
    if (live) clearTimeout(live.timer);
    else live = { drawn: 0 };
    live.timer = setTimeout(() => {
      liveStrokes.delete(map);
      const entry = entryFor(map);
      if (entry) invalidateTiles(entry.bounds);
      scheduleRender();
    }, LIVE_STROKE_QUIET_MS);
    liveStrokes.set(map, live);
    return live;
  }

  function handleDocChange(events, transaction, local) {
    let structural = false;

    for (const event of events) {
      const target = event.target;
      // Dosypanie punktów do kreski: unieważniamy tylko kafle tej kreski.
      if (target && target.parent && target.parent.get && target.parent.get('pts') === target) {
        const map = target.parent;
        strokeCache.delete(map);
        if (map === activeStrokeMap) continue;

        const live = markLive(map);
        const entry = entryFor(map);
        if (entry) {
          // Cudza kreska rośnie w trakcie — dorysowujemy przyrostowo.
          if (!local) paintLive(entry.stroke, live.drawn);
          live.drawn = core.pointCount(entry.stroke);
        }
        continue;
      }
      structural = true;
      if (target && target.toJSON) strokeCache.delete(target);
    }

    if (structural) {
      strokeCache.clear();
      tiles.clear();
      renderAnnotationList();
    }

    if (local) setDirty(true);
    updateHistoryButtons();
    scheduleRender();
  }

  // ==========================================================================
  // Rysowanie piórem
  // ==========================================================================

  let pending = [];
  let flushScheduled = false;
  // Trwający gest, rozpoznawany po pointerId. Świadomie NIE po event.buttons:
  // pióro z odwróconą końcówką i część tabletów raportują tam co innego.
  let gesture = null;
  let panStart = null;

  function pressureOf(event) {
    return event.pressure && event.pressure > 0 ? event.pressure : core.DEFAULT_PRESSURE;
  }

  function flushToDocument() {
    flushScheduled = false;
    if (pending.length === 0 || !activeStrokeMap) return;
    // Jedna transakcja na klatkę, nie jedna na punkt.
    notebook.appendPoints(activeStrokeMap, pending);
    pending = [];
  }

  function schedulePendingFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flushToDocument);
  }

  function beginStroke(event) {
    const point = clampWorld(canvasPoint(event));
    activeStroke = {
      id: core.createId(),
      tool: 'pen',
      brush: brushType,
      color: currentColor,
      size: currentWidth,
      pressureEnabled: pressureSensitive,
      pts: [core.roundCoord(point.x), core.roundCoord(point.y), core.roundPressure(pressureOf(event))],
    };
    activeStrokeMap = notebook.addStroke(activeStroke);
    if (!activeStrokeMap) {
      activeStroke = null;
      flashTitle('MathNotes — osiągnięto limit liczby kresek');
      return;
    }
    drawnUpTo = 0;
    paintLive(activeStroke, 0);
    drawnUpTo = 1;
  }

  function extendStroke(event) {
    if (!activeStroke) return;
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const list = samples.length > 0 ? samples : [event];
    const pts = activeStroke.pts;
    let added = false;

    for (const sample of list) {
      const raw = clampWorld(canvasPoint(sample));
      const smoothed = core.smoothPoint(pts[pts.length - 3], pts[pts.length - 2], raw.x, raw.y);
      if (!smoothed) continue;

      const x = core.roundCoord(smoothed.x);
      const y = core.roundCoord(smoothed.y);
      const p = core.roundPressure(pressureOf(sample));
      pts.push(x, y, p);
      pending.push(x, y, p);
      added = true;
    }

    if (!added) return;
    // Najpierw piksel na ekranie, dopiero potem synchronizacja.
    paintLive(activeStroke, drawnUpTo);
    drawnUpTo = core.pointCount(activeStroke);
    schedulePendingFlush();
  }

  function endStroke(event) {
    if (!activeStroke) return;

    // Wygładzanie przyciąga każdy punkt do poprzedniego, więc ostatnia próbka
    // zawsze trochę zostaje za miejscem, w którym pióro naprawdę się oderwało.
    // Dokładamy dokładną pozycję puszczenia, bez wygładzania.
    if (event) {
      const point = clampWorld(canvasPoint(event));
      const pts = activeStroke.pts;
      const x = core.roundCoord(point.x);
      const y = core.roundCoord(point.y);
      const p = pts.length >= 3 ? pts[pts.length - 1] : core.DEFAULT_PRESSURE;
      if (x !== pts[pts.length - 3] || y !== pts[pts.length - 2]) {
        pts.push(x, y, p);
        pending.push(x, y, p);
      }
    }

    flushToDocument();
    const finished = activeStrokeMap;
    activeStrokeMap = null;
    activeStroke = null;
    drawnUpTo = 0;

    if (finished) {
      strokeCache.delete(finished);
      const entry = entryFor(finished);
      if (entry) invalidateTiles(entry.bounds);
    }
    // Jedno pociągnięcie = jeden krok cofania, niezależnie od tempa rysowania.
    notebook.stopCapturing();
    updateHistoryButtons();
    render();
  }

  // ==========================================================================
  // Gumka
  // ==========================================================================

  let lastErasePoint = null;

  function eraseRadiusWorld() {
    return core.eraserScreenRadius(currentWidth) / view.scale;
  }

  function eraseCircle(point, radius) {
    const reach = {
      minX: point.x - radius,
      maxX: point.x + radius,
      minY: point.y - radius,
      maxY: point.y + radius,
    };

    // Odsiewamy po bboxach z lokalnego cache'u, żeby doc.js nie musiał czytać
    // punktów każdej kreski w dokumencie przy każdym kroku gumki.
    const touched = notebook.eraseAt(point.x, point.y, radius, eraseMode, (map) => {
      const entry = entryFor(map);
      return entry !== null && core.boundsIntersect(entry.bounds, reach);
    });

    if (touched > 0) invalidateTiles(reach);
    return touched;
  }

  /**
   * Gumka kasuje wzdłuż przebytej drogi, a nie w punktach próbkowania.
   * Bez tego szybki ruch przeskakuje nad kreską: przeglądarka scala kilkadziesiąt
   * ruchów w jedno zdarzenie, a odstęp między dwiema pozycjami bywa większy niż
   * średnica gumki.
   */
  function eraseAlongEvent(event) {
    const radius = eraseRadiusWorld();
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const list = samples.length > 0 ? samples : [event];
    let touched = 0;

    for (const sample of list) {
      const point = clampWorld(canvasPoint(sample));
      if (lastErasePoint === null) {
        touched += eraseCircle(point, radius);
      } else {
        const dx = point.x - lastErasePoint.x;
        const dy = point.y - lastErasePoint.y;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / radius));
        for (let i = 1; i <= steps; i++) {
          touched += eraseCircle(
            { x: lastErasePoint.x + (dx * i) / steps, y: lastErasePoint.y + (dy * i) / steps },
            radius,
          );
        }
      }
      lastErasePoint = point;
    }

    if (touched > 0) scheduleRender();
  }

  // ==========================================================================
  // Narzędzie kursora: przesuwanie i skalowanie obrazów
  // ==========================================================================

  let dragImage = null;
  let dragOffset = { x: 0, y: 0 };
  let resizeState = null;

  function startResize(handle, point) {
    const selected = selectedImage();
    if (!selected) return;
    resizeState = {
      handle,
      map: selected.map,
      startX: point.x,
      x: selected.image.x,
      y: selected.image.y,
      w: selected.image.w,
      h: selected.image.h,
    };
    canvas.style.cursor = cursorForHandle(handle);
  }

  function applyResize(point) {
    const s = resizeState;
    const dx = point.x - s.startX;
    const aspect = s.w / s.h || 1;

    let width = s.handle === 'se' || s.handle === 'ne' ? s.w + dx : s.w - dx;
    width = Math.max(MIN_IMAGE_SIZE, width);
    const height = width / aspect;

    const box = { w: width, h: height, x: s.x, y: s.y };
    if (s.handle === 'nw' || s.handle === 'sw') box.x = s.x + (s.w - width);
    if (s.handle === 'nw' || s.handle === 'ne') box.y = s.y + (s.h - height);

    notebook.updateImage(s.map, box);
  }

  function deleteSelectedImage() {
    const selected = selectedImage();
    if (!selected) return;
    const bounds = core.imageBounds(selected.image);
    notebook.removeImage(selected.map);
    selectedImageId = null;
    invalidateTiles(bounds);
    render();
  }

  // ==========================================================================
  // Wejście
  // ==========================================================================

  const DRAWING_BUTTONS = new Set([0, 5]);

  function defaultCursor() {
    if (tool === 'pen') return PEN_CURSOR;
    if (tool === 'eraser') return eraserCursorFor(currentWidth);
    return 'default';
  }

  canvas.addEventListener('pointerdown', (event) => {
    hideFlyout();

    // Środkowy przycisk i palec przesuwają widok niezależnie od narzędzia.
    if ((event.pointerType === 'mouse' && event.button === 1) || event.pointerType === 'touch') {
      event.preventDefault();
      gesture = { id: event.pointerId, kind: 'pan' };
      panStart = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (!DRAWING_BUTTONS.has(event.button)) return;

    canvas.setPointerCapture(event.pointerId);
    const point = clampWorld(canvasPoint(event));
    // Odwrócone pióro (gumka na końcu rysika) działa jak gumka niezależnie
    // od wybranego narzędzia.
    const erasing = tool === 'eraser' || (event.pointerType === 'pen' && event.button === 5);

    if (erasing) {
      gesture = { id: event.pointerId, kind: 'erase' };
      lastErasePoint = null;
      eraseAlongEvent(event);
      return;
    }
    if (tool === 'pen') {
      gesture = { id: event.pointerId, kind: 'draw' };
      beginStroke(event);
      return;
    }

    // Narzędzie kursora.
    const handle = findHandleAt(point);
    if (handle) {
      gesture = { id: event.pointerId, kind: 'resize' };
      startResize(handle, point);
      return;
    }
    const hit = findImageAt(point);
    if (hit) {
      gesture = { id: event.pointerId, kind: 'move' };
      selectedImageId = hit.image.id;
      dragImage = hit.map;
      dragOffset = { x: point.x - hit.image.x, y: point.y - hit.image.y };
      canvas.style.cursor = 'grabbing';
      render();
    } else if (selectedImageId) {
      selectedImageId = null;
      render();
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (sessionActive()) {
      const point = canvasPoint(event);
      session.setCursor(point.x, point.y);
    }

    if (!gesture || event.pointerId !== gesture.id) {
      if (tool === 'cursor' && findHandleAt(clampWorld(canvasPoint(event)))) {
        canvas.style.cursor = cursorForHandle(findHandleAt(clampWorld(canvasPoint(event))));
      } else if (canvas.style.cursor !== 'grabbing') {
        canvas.style.cursor = defaultCursor();
      }
      return;
    }

    if (gesture.kind === 'pan') {
      view.x = clampViewX(panStart.viewX - (event.clientX - panStart.x) / view.scale, view.scale);
      view.y = clampViewY(panStart.viewY - (event.clientY - panStart.y) / view.scale);
      scheduleRender();
      return;
    }
    if (gesture.kind === 'erase') {
      eraseAlongEvent(event);
      return;
    }
    if (gesture.kind === 'draw') {
      extendStroke(event);
      return;
    }
    if (gesture.kind === 'resize' && resizeState) {
      applyResize(clampWorld(canvasPoint(event)));
      scheduleRender();
      return;
    }
    if (gesture.kind === 'move' && dragImage) {
      const point = clampWorld(canvasPoint(event));
      notebook.updateImage(dragImage, { x: point.x - dragOffset.x, y: point.y - dragOffset.y });
      scheduleRender();
    }
  });

  function releasePointer(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const kind = gesture.kind;
    gesture = null;
    panStart = null;
    lastErasePoint = null;
    dragImage = null;
    resizeState = null;
    canvas.style.cursor = defaultCursor();

    if (kind === 'draw') endStroke(event);
    else if (kind === 'erase' || kind === 'move' || kind === 'resize') {
      notebook.stopCapturing();
      render();
    }
  }

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('pointerleave', (event) => {
    if (sessionActive()) session.setCursor(NaN, NaN);
    if (gesture) releasePointer(event);
  });

  // Chromium ma własny autoscroll na środkowym przycisku — inaczej odpalałby
  // się razem z naszym przesuwaniem widoku.
  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  canvas.addEventListener('auxclick', (event) => {
    if (event.button === 1) event.preventDefault();
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = canvas.getBoundingClientRect();
        const sx = event.clientX - rect.left;
        const sy = event.clientY - rect.top;
        const before = screenToWorld(sx, sy);
        view.scale = core.clamp(view.scale * Math.exp(-event.deltaY * 0.01), MIN_SCALE, MAX_SCALE);
        const after = screenToWorld(sx, sy);
        view.x += before.x - after.x;
        view.y += before.y - after.y;
        tiles.clear();
        updateZoomIndicator();
      } else {
        view.x += event.deltaX / view.scale;
        view.y += event.deltaY / view.scale;
      }
      view.x = clampViewX(view.x, view.scale);
      view.y = clampViewY(view.y);
      scheduleRender();
    },
    { passive: false },
  );

  // ==========================================================================
  // Wklejanie obrazów
  // ==========================================================================

  document.addEventListener('paste', (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.indexOf('image') === -1) continue;
      event.preventDefault();
      const file = item.getAsFile();
      if (file) insertImageFile(file);
    }
  });

  async function insertImageFile(file) {
    let dataUrl;
    try {
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const element = new Image();
      element.src = dataUrl;
      await element.decode();

      const center = screenToWorld(viewW / 2, viewH / 2);
      const maxDim = 500 / view.scale;
      const fit = Math.min(1, maxDim / Math.max(element.width, element.height));
      const w = element.width * fit;
      const h = element.height * fit;

      // Obraz zapisujemy w ok. 2× rozmiaru wyświetlania — duży zrzut ekranu
      // rozdmuchałby plik o megabajty bez widocznego zysku.
      const storeW = Math.max(1, Math.min(element.width, Math.round(w * PASTE_STORE_SCALE)));
      const storeH = Math.max(1, Math.min(element.height, Math.round(h * PASTE_STORE_SCALE)));
      let stored = dataUrl;
      if (storeW < element.width || storeH < element.height) {
        const off = document.createElement('canvas');
        off.width = storeW;
        off.height = storeH;
        off.getContext('2d').drawImage(element, 0, 0, storeW, storeH);
        stored = off.toDataURL('image/png');
      }

      const box = clampWorld({ x: center.x - w / 2, y: center.y - h / 2 });
      const image = { id: core.createId(), x: box.x, y: box.y, w, h, dataUrl: stored };
      notebook.addImage(image);
      bitmaps.set(image.id, await createImageBitmap(element));
      invalidateTiles(core.imageBounds(image));
      notebook.stopCapturing();
      render();
    } catch {
      flashTitle('MathNotes — nie udało się wstawić obrazu', 3000);
    }
  }

  // ==========================================================================
  // Adnotacje
  // ==========================================================================

  const annotationListEl = $('annotation-list');
  const annotationListOverlay = $('annotation-list-overlay');
  const modalOverlay = $('modal-overlay');
  const modalInput = $('modal-input');

  function renderAnnotationList() {
    annotationListEl.replaceChildren();
    const list = notebook.annotationList();

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.id = 'annotation-empty';
      empty.textContent = 'Brak adnotacji. Naciśnij B, aby dodać jedną w bieżącym miejscu.';
      annotationListEl.append(empty);
      return;
    }

    for (const annotation of list) {
      const li = document.createElement('li');

      const rowTop = document.createElement('div');
      rowTop.className = 'row-top';

      const jump = document.createElement('div');
      jump.className = 'jump-area';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = annotation.label; // nigdy innerHTML
      const coord = document.createElement('span');
      coord.className = 'coord';
      coord.textContent = 'Y: ' + Math.round(annotation.y);
      jump.append(label, coord);
      jump.addEventListener('click', () => jumpToAnnotation(annotation.y));

      rowTop.append(jump);
      li.append(rowTop);

      const remove = document.createElement('button');
      remove.className = 'remove-btn';
      remove.type = 'button';
      remove.textContent = 'Usuń';
      remove.addEventListener('click', (ev) => {
        ev.stopPropagation();
        notebook.removeAnnotation(annotation.id);
        notebook.stopCapturing();
      });
      li.append(remove);

      annotationListEl.append(li);
    }
  }

  function jumpToAnnotation(y) {
    view.y = clampViewY(y - viewH / 2 / view.scale);
    closeModal(annotationListOverlay);
    render();
  }

  function promptAnnotationName() {
    return new Promise((resolve) => {
      modalInput.value = '';
      openModal(modalOverlay);
      modalInput.focus();

      const cleanup = () => {
        closeModal(modalOverlay);
        $('modal-ok').removeEventListener('click', onOk);
        $('modal-cancel').removeEventListener('click', onCancel);
        modalInput.removeEventListener('keydown', onKeydown);
      };
      function onOk() {
        const value = modalInput.value;
        cleanup();
        resolve(value);
      }
      function onCancel() {
        cleanup();
        resolve(null);
      }
      function onKeydown(event) {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          onOk();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }

      $('modal-ok').addEventListener('click', onOk);
      $('modal-cancel').addEventListener('click', onCancel);
      modalInput.addEventListener('keydown', onKeydown);
    });
  }

  async function addAnnotationAtCurrentView() {
    const label = await promptAnnotationName();
    if (label === null) return;
    const y = core.clamp(screenToWorld(0, viewH / 2).y, core.MIN_WORLD_Y, core.MAX_WORLD_Y);
    notebook.addAnnotation({ y, label });
    notebook.stopCapturing();
    render();
  }

  // ==========================================================================
  // Modale i flyouty
  // ==========================================================================

  function openModal(overlay) {
    overlay.classList.remove('modal-hidden');
  }

  function closeModal(overlay) {
    overlay.classList.add('modal-hidden');
  }

  function isOpen(overlay) {
    return !overlay.classList.contains('modal-hidden');
  }

  for (const [overlayId, closeId] of [
    ['annotation-list-overlay', 'annotation-list-close'],
    ['online-join-overlay', 'online-join-cancel'],
    ['online-share-overlay', 'online-share-close'],
    ['online-settings-overlay', 'online-settings-cancel'],
    ['keymap-overlay', 'keymap-close'],
  ]) {
    const overlay = $(overlayId);
    $(closeId).addEventListener('click', () => closeModal(overlay));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModal(overlay);
    });
  }

  let openFlyoutEl = null;
  let openFlyoutAnchor = null;

  function showFlyout(el, anchor) {
    if (openFlyoutEl === el) {
      hideFlyout();
      return;
    }
    hideFlyout();
    el.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const maxTop = window.innerHeight - elRect.height - 8;
    el.style.left = rect.right + 8 + 'px';
    el.style.top = Math.max(8, Math.min(rect.top, maxTop)) + 'px';
    openFlyoutEl = el;
    openFlyoutAnchor = anchor;
  }

  function hideFlyout() {
    if (!openFlyoutEl) return;
    openFlyoutEl.classList.add('hidden');
    openFlyoutEl = null;
    openFlyoutAnchor = null;
  }

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!openFlyoutEl) return;
      if (openFlyoutEl.contains(event.target)) return;
      if (openFlyoutAnchor && openFlyoutAnchor.contains(event.target)) return;
      hideFlyout();
    },
    true,
  );

  // Krótkie kliknięcie = akcja domyślna, przytrzymanie = flyout z wariantami.
  function attachHoldFlyout(button, flyout, onClick) {
    let timer = 0;
    let held = false;

    button.addEventListener('pointerdown', (event) => {
      if (typeof event.button === 'number' && event.button !== 0) return;
      held = false;
      timer = setTimeout(() => {
        held = true;
        showFlyout(flyout, button);
      }, HOLD_MS);
    });
    const cancel = () => clearTimeout(timer);
    button.addEventListener('pointerup', cancel);
    button.addEventListener('pointerleave', cancel);
    button.addEventListener('click', () => {
      if (held) {
        held = false;
        return;
      }
      onClick();
    });
  }

  // ==========================================================================
  // Toolbar
  // ==========================================================================

  const toolButtons = { pen: $('tool-pen'), eraser: $('tool-eraser'), cursor: $('tool-cursor') };
  const brushFlyout = $('brush-flyout');
  const eraserFlyout = $('eraser-flyout');

  // Mała kropka czyta się jako czubek pióra znacznie lepiej niż domyślny
  // krzyżyk, który zasłania kartkę.
  const PEN_CURSOR_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14">' +
    '<circle cx="7" cy="7" r="3.2" fill="white" stroke="black" stroke-width="1.2"/></svg>';
  const PEN_CURSOR = "url('data:image/svg+xml;utf8," + encodeURIComponent(PEN_CURSOR_SVG) + "') 7 7, crosshair";

  // Okrąg dokładnie w rozmiarze promienia kasowania — nigdy generyczny krzyżyk
  // dla akcji, która ma zasięg.
  function eraserCursorFor(width) {
    const r = core.eraserScreenRadius(width);
    const size = Math.ceil(r * 2 + 4);
    const c = size / 2;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="rgba(255,255,255,0.15)" stroke="white" stroke-width="1.5"/>' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="black" stroke-width="0.75" stroke-dasharray="2,2"/>' +
      '</svg>';
    return "url('data:image/svg+xml;utf8," + encodeURIComponent(svg) + "') " + c + ' ' + c + ', crosshair';
  }

  function setTool(name) {
    tool = name;
    if (tool !== 'cursor') selectedImageId = null;
    for (const [key, button] of Object.entries(toolButtons)) {
      button.classList.toggle('active', key === name);
    }
    canvas.style.cursor = defaultCursor();
    scheduleRender();
  }

  attachHoldFlyout(toolButtons.pen, brushFlyout, () => setTool('pen'));
  attachHoldFlyout(toolButtons.eraser, eraserFlyout, () => setTool('eraser'));
  toolButtons.cursor.addEventListener('click', () => setTool('cursor'));

  function setBrushType(name) {
    brushType = name;
    for (const option of brushFlyout.querySelectorAll('.flyout-option')) {
      option.classList.toggle('active', option.dataset.brush === name);
    }
    savePrefs();
  }

  for (const option of brushFlyout.querySelectorAll('.flyout-option')) {
    option.addEventListener('click', () => {
      setBrushType(option.dataset.brush);
      setTool('pen');
      hideFlyout();
    });
  }

  function setEraseMode(name) {
    eraseMode = name;
    for (const option of eraserFlyout.querySelectorAll('.flyout-option')) {
      option.classList.toggle('active', option.dataset.erase === name);
    }
    savePrefs();
  }

  for (const option of eraserFlyout.querySelectorAll('.flyout-option')) {
    option.addEventListener('click', () => {
      setEraseMode(option.dataset.erase);
      setTool('eraser');
      hideFlyout();
    });
  }

  // --- kolory --------------------------------------------------------------

  const colorBtn = $('color-btn');
  const colorSwatch = $('color-swatch-preview');
  const colorFlyout = $('color-flyout');
  const colorGrid = $('color-palette-grid');
  const colorPicker = $('color-picker-hidden');
  let editingSlot = null;

  function setColor(color) {
    currentColor = color;
    colorSwatch.style.background = color;
    renderColorPalette();
    savePrefs();
  }

  function renderColorPalette() {
    colorGrid.replaceChildren();
    customColors.forEach((color, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-swatch';
      button.style.background = color;
      button.classList.toggle('active', color === currentColor);
      button.title = 'Klik: wybierz kolor. Prawy klik: przypisz nowy kolor do tego miejsca.';
      button.addEventListener('click', () => {
        setColor(color);
        hideFlyout();
      });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        editingSlot = index;
        colorPicker.value = color;
        colorPicker.click();
      });
      colorGrid.append(button);
    });
  }

  colorPicker.addEventListener('input', () => {
    if (editingSlot === null) return;
    const wasCurrent = customColors[editingSlot] === currentColor;
    customColors[editingSlot] = colorPicker.value;
    if (wasCurrent) currentColor = colorPicker.value;
    colorSwatch.style.background = currentColor;
    renderColorPalette();
    savePrefs();
  });
  colorPicker.addEventListener('change', () => {
    editingSlot = null;
  });

  colorBtn.addEventListener('click', () => {
    renderColorPalette();
    showFlyout(colorFlyout, colorBtn);
  });

  // --- grubość -------------------------------------------------------------

  const widthBtn = $('width-btn');
  const widthFlyout = $('width-flyout');
  const widthSlider = $('width-slider');
  const widthLabel = $('width-label');

  function applyWidth(value) {
    currentWidth = core.clamp(value, core.MIN_STROKE_SIZE, core.MAX_STROKE_SIZE);
    widthLabel.textContent = currentWidth + 'px';
    widthSlider.value = String(currentWidth);
    canvas.style.cursor = defaultCursor();
    savePrefs();
  }

  widthSlider.addEventListener('input', () => applyWidth(parseInt(widthSlider.value, 10) || 1));
  widthBtn.addEventListener('click', () => showFlyout(widthFlyout, widthBtn));

  // --- nacisk --------------------------------------------------------------

  const pressureBtn = $('pressure-toggle');

  function setPressureSensitive(value) {
    pressureSensitive = value;
    pressureBtn.classList.toggle('active', pressureSensitive);
    savePrefs();
  }

  pressureBtn.addEventListener('click', () => setPressureSensitive(!pressureSensitive));

  // --- pozostałe przyciski -------------------------------------------------

  const undoBtn = $('undo-btn');
  const redoBtn = $('redo-btn');

  function updateHistoryButtons() {
    undoBtn.disabled = !notebook.canUndo();
    redoBtn.disabled = !notebook.canRedo();
  }

  undoBtn.addEventListener('click', () => {
    notebook.undo();
    updateHistoryButtons();
  });
  redoBtn.addEventListener('click', () => {
    notebook.redo();
    updateHistoryButtons();
  });
  $('add-bookmark').addEventListener('click', addAnnotationAtCurrentView);

  function contentBBox() {
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const map of notebook.strokes) {
      const entry = entryFor(map);
      if (!entry) continue;
      minX = Math.min(minX, entry.bounds.minX);
      maxX = Math.max(maxX, entry.bounds.maxX);
      minY = Math.min(minY, entry.bounds.minY);
      maxY = Math.max(maxY, entry.bounds.maxY);
    }
    eachImage((image) => {
      minX = Math.min(minX, image.x);
      maxX = Math.max(maxX, image.x + image.w);
      minY = Math.min(minY, image.y);
      maxY = Math.max(maxY, image.y + image.h);
    });
    return Number.isFinite(minY) ? { minX, minY, maxX, maxY } : null;
  }

  $('scroll-top-btn').addEventListener('click', () => {
    const bbox = contentBBox();
    view.y = clampViewY(bbox ? bbox.minY - 40 : 0);
    render();
  });
  $('scroll-bottom-btn').addEventListener('click', () => {
    const bbox = contentBBox();
    view.y = clampViewY(bbox ? bbox.maxY - viewH / view.scale + 40 : 0);
    render();
  });

  const zoomIndicator = $('zoom-indicator');

  function updateZoomIndicator() {
    zoomIndicator.textContent = Math.round(view.scale * 100) + '%';
  }

  zoomIndicator.addEventListener('click', () => resetZoom());

  function resetZoom() {
    view.scale = 1;
    view.x = clampViewX(view.x, view.scale);
    tiles.clear();
    updateZoomIndicator();
    render();
  }

  // ==========================================================================
  // Skróty klawiszowe
  // ==========================================================================

  const KEYMAP_ACTIONS = [
    { id: 'pen', label: 'Pióro' },
    { id: 'eraser', label: 'Gumka' },
    { id: 'cursor', label: 'Kursor (przesuwanie obiektów)' },
    { id: 'annotation', label: 'Dodaj adnotację' },
    { id: 'annotationList', label: 'Lista adnotacji' },
    { id: 'widthDown', label: 'Mniejsza grubość' },
    { id: 'widthUp', label: 'Większa grubość' },
    { id: 'color1', label: 'Kolor 1' },
    { id: 'color2', label: 'Kolor 2' },
    { id: 'color3', label: 'Kolor 3' },
    { id: 'color4', label: 'Kolor 4' },
    { id: 'color5', label: 'Kolor 5' },
  ];
  const DEFAULT_KEYMAP = {
    pen: 'p',
    eraser: 'e',
    cursor: 'v',
    annotation: 'b',
    annotationList: 'l',
    widthDown: '[',
    widthUp: ']',
    color1: '1',
    color2: '2',
    color3: '3',
    color4: '4',
    color5: '5',
  };

  function loadKeymap() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(KEYMAP_KEY)) || {};
      const merged = { ...DEFAULT_KEYMAP };
      for (const id of Object.keys(DEFAULT_KEYMAP)) {
        const key = saved[id];
        if (key === null || (typeof key === 'string' && key.length > 0 && key.length <= 20)) merged[id] = key;
      }
      return merged;
    } catch {
      return { ...DEFAULT_KEYMAP };
    }
  }

  let keymap = loadKeymap();
  let keyToAction = {};

  function saveKeymap() {
    try {
      window.localStorage.setItem(KEYMAP_KEY, JSON.stringify(keymap));
    } catch {
      // Brak localStorage nie może wywalić skrótów.
    }
  }

  function rebuildKeyToAction() {
    keyToAction = {};
    for (const id of Object.keys(keymap)) {
      if (keymap[id]) keyToAction[keymap[id]] = id;
    }
  }

  function runKeymapAction(id) {
    switch (id) {
      case 'pen':
      case 'eraser':
      case 'cursor':
        setTool(id);
        break;
      case 'annotation':
        addAnnotationAtCurrentView();
        break;
      case 'annotationList':
        openAnnotationList();
        break;
      case 'widthDown':
        applyWidth(currentWidth - 1);
        break;
      case 'widthUp':
        applyWidth(currentWidth + 1);
        break;
      default:
        if (id.startsWith('color')) setColor(customColors[Number(id.slice(5)) - 1]);
    }
  }

  const keymapOverlay = $('keymap-overlay');
  const keymapList = $('keymap-list');
  let listeningAction = null;

  function keyDisplay(key) {
    if (!key) return '—';
    if (key === ' ') return 'Space';
    return key.length === 1 ? key.toUpperCase() : key;
  }

  function renderKeymapList() {
    keymapList.replaceChildren();
    for (const action of KEYMAP_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'keymap-row';

      const label = document.createElement('span');
      label.className = 'action-label';
      label.textContent = action.label;

      const badge = document.createElement('span');
      badge.className = 'key-badge';
      const listening = listeningAction === action.id;
      badge.classList.toggle('listening', listening);
      badge.textContent = listening ? 'Naciśnij klawisz…' : keyDisplay(keymap[action.id]);

      const rebind = document.createElement('button');
      rebind.type = 'button';
      rebind.className = 'rebind-btn';
      rebind.textContent = 'Zmień';
      rebind.addEventListener('click', () => {
        listeningAction = action.id;
        renderKeymapList();
      });

      row.append(label, badge, rebind);
      keymapList.append(row);
    }
  }

  function openKeymap() {
    listeningAction = null;
    openModal(keymapOverlay);
    renderKeymapList();
  }

  $('keymap-reset').addEventListener('click', () => {
    keymap = { ...DEFAULT_KEYMAP };
    listeningAction = null;
    saveKeymap();
    rebuildKeyToAction();
    renderKeymapList();
  });

  window.addEventListener('keydown', (event) => {
    if (listeningAction) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        listeningAction = null;
      } else {
        const next = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        // Jeden klawisz nie może obsługiwać dwóch akcji naraz.
        for (const id of Object.keys(keymap)) {
          if (keymap[id] === next) keymap[id] = null;
        }
        keymap[listeningAction] = next;
        saveKeymap();
        rebuildKeyToAction();
        listeningAction = null;
      }
      renderKeymapList();
      return;
    }

    if (event.key === 'Escape') {
      if (openFlyoutEl) {
        hideFlyout();
        event.preventDefault();
        return;
      }
      for (const overlay of document.querySelectorAll('[id$="-overlay"]')) {
        if (isOpen(overlay) && overlay !== modalOverlay) {
          closeModal(overlay);
          event.preventDefault();
          return;
        }
      }
    }

    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;

    if (mod && key.toLowerCase() === 'z' && event.shiftKey) {
      event.preventDefault();
      notebook.redo();
      updateHistoryButtons();
      return;
    }
    if (mod && key.toLowerCase() === 'z') {
      event.preventDefault();
      notebook.undo();
      updateHistoryButtons();
      return;
    }
    if (mod) return; // resztę skrótów z modyfikatorem obsługuje natywne menu

    if ((key === 'Delete' || key === 'Backspace') && tool === 'cursor' && selectedImageId) {
      deleteSelectedImage();
      event.preventDefault();
      return;
    }

    const step = 60 / view.scale;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      view.y = clampViewY(view.y + (key === 'ArrowUp' ? -step : step));
      scheduleRender();
      event.preventDefault();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      view.x = clampViewX(view.x + (key === 'ArrowLeft' ? -step : step), view.scale);
      scheduleRender();
      event.preventDefault();
      return;
    }

    const action = keyToAction[key.length === 1 ? key.toLowerCase() : key];
    if (action) {
      runKeymapAction(action);
      event.preventDefault();
    }
  });

  // ==========================================================================
  // Tytuł okna jako pasek stanu
  // ==========================================================================

  let flashTimer = 0;

  function refreshTitle() {
    if (flashTimer) return; // flash ma pierwszeństwo, tytuł wróci sam
    document.title = core.formatTitle(docName, dirty);
  }

  function flashTitle(message, ms) {
    clearTimeout(flashTimer);
    document.title = message;
    flashTimer = setTimeout(() => {
      flashTimer = 0;
      refreshTitle();
    }, ms || 2000);
  }

  function setDirty(value) {
    if (dirty === value) return;
    dirty = value;
    window.api.setDirty(dirty);
    refreshTitle();
  }

  // ==========================================================================
  // Pliki
  // ==========================================================================

  async function doSave(saveAs) {
    const { state, skipped } = notebook.toState();
    const result = await window.api.saveNotebook(state, saveAs);
    if (result.canceled) return false;

    docName = result.name;
    setDirty(false);
    const lost = skipped.strokes + skipped.images + skipped.annotations;
    flashTitle('MathNotes — zapisano: ' + result.name + (lost > 0 ? ' (pominięto ' + lost + ')' : ''));
    return true;
  }

  // Autozapis pisze tylko do pliku, który już istnieje — nigdy nie otwiera
  // dialogu za plecami rysującego.
  async function autosaveTick() {
    if (!dirty) return;
    const { state } = notebook.toState();
    const result = await window.api.autosave(state);
    if (result && result.ok) setDirty(false);
  }

  function applyOpened(payload) {
    if (blockedByOnline()) return;

    let normalized;
    try {
      normalized = core.normalizeState(payload.raw);
    } catch (err) {
      flashTitle('MathNotes — ' + err.message, 4000);
      return;
    }

    replaceNotebook();
    notebook.loadState(normalized.state);
    docName = payload.name;
    view = { x: 0, y: 0, scale: 1 };
    setDirty(false);
    updateZoomIndicator();
    updateHistoryButtons();
    renderAnnotationList();
    render();

    const lost = normalized.skipped.strokes + normalized.skipped.images + normalized.skipped.annotations;
    flashTitle('MathNotes — wczytano: ' + payload.name + (lost > 0 ? ' (pominięto ' + lost + ')' : ''), 3000);
  }

  function confirmDiscard() {
    if (!dirty) return true;
    return window.confirm('Masz niezapisane zmiany. Kontynuować mimo to? Niezapisane zmiany zostaną utracone.');
  }

  async function doOpen() {
    if (blockedByOnline() || !confirmDiscard()) return;
    const result = await window.api.openNotebook();
    if (result.canceled) return;
    applyOpened(result);
  }

  async function doNew() {
    if (blockedByOnline() || !confirmDiscard()) return;
    await window.api.newNotebook();
    replaceNotebook();
    docName = null;
    view = { x: 0, y: 0, scale: 1 };
    setDirty(false);
    updateZoomIndicator();
    updateHistoryButtons();
    renderAnnotationList();
    render();
    flashTitle('MathNotes — nowy notatnik');
  }

  // ==========================================================================
  // Eksport do PDF
  // ==========================================================================

  async function exportPdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      window.alert('Nie udało się załadować biblioteki PDF.');
      return;
    }
    const bbox = contentBBox();
    if (!bbox) {
      window.alert('Notatka jest pusta — nie ma czego eksportować.');
      return;
    }

    document.title = 'MathNotes — eksportowanie PDF…';
    try {
      const margin = 40;
      const minX = bbox.minX - margin;
      const minY = bbox.minY - margin;
      const contentW = bbox.maxX - bbox.minX + margin * 2;
      const contentH = bbox.maxY - bbox.minY + margin * 2;

      const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
      const pageMargin = 20;
      const printableW = pdf.internal.pageSize.getWidth() - pageMargin * 2;
      const printableH = pdf.internal.pageSize.getHeight() - pageMargin * 2;

      const scale = printableW / contentW; // jednostki świata -> punkty PDF
      const worldPageHeight = printableH / scale;
      const pages = Math.min(PDF_MAX_PAGES, Math.max(1, Math.ceil(contentH / worldPageHeight)));
      const RASTER = 2; // piksele offscreenu na punkt, dla ostrości

      for (let page = 0; page < pages; page++) {
        const worldTop = minY + page * worldPageHeight;
        const sliceH = Math.min(worldPageHeight, contentH - page * worldPageHeight);

        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(printableW * RASTER));
        off.height = Math.max(1, Math.round(sliceH * scale * RASTER));
        const offCtx = off.getContext('2d');

        offCtx.setTransform(1, 0, 0, 1, 0, 0);
        offCtx.fillStyle = '#000000';
        offCtx.fillRect(0, 0, off.width, off.height);

        const k = scale * RASTER;
        offCtx.setTransform(k, 0, 0, k, -minX * k, -worldTop * k);

        const clip = { minX, maxX: minX + contentW, minY: worldTop, maxY: worldTop + sliceH };
        drawImagesInto(offCtx, clip);
        for (const map of notebook.strokes) {
          const entry = entryFor(map);
          if (!entry || !core.boundsIntersect(entry.bounds, clip)) continue;
          drawStroke(offCtx, entry.stroke, k);
        }
        if (showAnnotationLines) drawAnnotationLines(offCtx, minX, minX + contentW, scale);

        if (page > 0) pdf.addPage();
        pdf.addImage(off.toDataURL('image/png'), 'PNG', pageMargin, pageMargin, printableW, sliceH * scale);
      }

      const suggested = (docName || 'notatnik').replace(/\.json$/i, '') + '.pdf';
      const result = await window.api.savePdf(pdf.output('arraybuffer'), suggested);
      if (result.canceled) refreshTitle();
      else flashTitle('MathNotes — PDF wyeksportowano: ' + result.name, 3000);
    } catch {
      window.alert('Błąd eksportu do PDF.');
      refreshTitle();
    }
  }

  // ==========================================================================
  // Sesja online
  // ==========================================================================

  const onlineStatusBtn = $('online-status-btn');
  const shareOverlay = $('online-share-overlay');
  const shareStatus = $('online-share-status');
  const shareCode = $('online-share-code');
  const joinOverlay = $('online-join-overlay');
  const joinInput = $('online-join-input');
  const settingsOverlay = $('online-settings-overlay');

  let onlineSettings = onlineApi.loadSettings();
  let session = null;
  let peers = [];

  function sessionActive() {
    return session !== null && session.active;
  }

  function blockedByOnline() {
    if (!sessionActive()) return false;
    flashTitle('MathNotes — zakończ sesję online, żeby zmienić notatnik', 3500);
    return true;
  }

  function updateOnlineStatusUI() {
    onlineStatusBtn.classList.remove('online-status-offline', 'online-status-online', 'online-status-connecting');
    if (!sessionActive()) {
      onlineStatusBtn.classList.add('online-status-offline');
      onlineStatusBtn.title = 'Sesja online: wyłączona';
      return;
    }
    const count = peers.length + 1;
    if (session.connected || peers.length > 0) {
      onlineStatusBtn.classList.add('online-status-online');
      onlineStatusBtn.title = 'Sesja online: połączono (' + count + (count === 1 ? ' osoba)' : ' os.)');
    } else {
      onlineStatusBtn.classList.add('online-status-connecting');
      onlineStatusBtn.title = 'Sesja online: łączenie…';
    }
  }

  /** Kursory innych osób. Nazwy trafiają wyłącznie do textContent. */
  function renderPeers() {
    peersLayer.replaceChildren();
    if (!sessionActive()) return;

    for (const peer of peers) {
      if (!peer.cursor) continue;
      const x = (peer.cursor.x - view.x) * view.scale;
      const y = (peer.cursor.y - view.y) * view.scale;
      if (x < -60 || x > viewW + 60 || y < -60 || y > viewH + 60) continue;

      const node = document.createElement('div');
      node.className = 'peer';
      node.style.left = Math.round(x) + 'px';
      node.style.top = Math.round(y) + 'px';

      const dot = document.createElement('span');
      dot.className = 'peer-dot';
      dot.style.background = peer.color;

      const label = document.createElement('span');
      label.className = 'peer-name';
      label.style.background = peer.color;
      label.textContent = peer.name;

      node.append(dot, label);
      peersLayer.append(node);
    }
  }

  function startSession(code, options) {
    if (sessionActive()) {
      openModal(shareOverlay);
      return;
    }
    // „Nowy notatnik” musi być nowym Y.Doc — patrz replaceNotebook.
    if (options && options.fresh) {
      replaceNotebook();
      docName = null;
      setDirty(false);
      updateHistoryButtons();
      renderAnnotationList();
      render();
    }

    session = new onlineApi.OnlineSession(window.Collab, notebook);
    session.on('peers', (list) => {
      peers = list;
      updateOnlineStatusUI();
      renderPeers();
    });
    session.on('status', ({ connected }) => {
      shareStatus.textContent = connected ? 'Sesja aktywna — udostępnij ten kod.' : 'Łączenie z serwerem sygnalizacyjnym…';
      updateOnlineStatusUI();
    });
    session.on('error', (message) => {
      shareStatus.textContent = message;
      window.alert(message);
    });
    session.on('stopped', () => {
      peers = [];
      updateOnlineStatusUI();
      renderPeers();
    });

    shareStatus.textContent = 'Łączenie z serwerem sygnalizacyjnym…';
    let created;
    try {
      created = session.start({ code: code || undefined, settings: onlineSettings });
    } catch (err) {
      session = null;
      window.alert(err.message);
      return;
    }

    shareCode.value = created;
    closeModal(joinOverlay);
    openModal(shareOverlay);
    updateOnlineStatusUI();
  }

  function stopSession() {
    if (!sessionActive()) {
      flashTitle('MathNotes — nie ma aktywnej sesji online');
      return;
    }
    session.stop();
    session = null;
    peers = [];
    shareCode.value = '';
    closeModal(shareOverlay);
    updateOnlineStatusUI();
    renderPeers();
    flashTitle('MathNotes — sesja online zakończona');
  }

  function copyInvite() {
    if (!sessionActive()) {
      flashTitle('MathNotes — nie ma aktywnej sesji online');
      return;
    }
    window.api.copyText(session.inviteCode);
    flashTitle('MathNotes — kod zaproszenia skopiowany');
  }

  function openJoin() {
    if (sessionActive()) {
      openModal(shareOverlay);
      return;
    }
    joinInput.value = '';
    $('join-mode-fresh').checked = true;
    openModal(joinOverlay);
    joinInput.focus();
  }

  function submitJoin() {
    const code = joinInput.value.trim();
    if (!onlineApi.parseInviteCode(code)) {
      window.alert('Nieprawidłowy kod zaproszenia.');
      return;
    }
    startSession(code, { fresh: $('join-mode-fresh').checked });
  }

  function openOnlineSettings() {
    $('settings-signaling').value = onlineSettings.signaling.join('\n');
    $('settings-turn-url').value = onlineSettings.turn ? onlineSettings.turn.urls : '';
    $('settings-turn-user').value = onlineSettings.turn ? onlineSettings.turn.username : '';
    $('settings-turn-pass').value = onlineSettings.turn ? onlineSettings.turn.credential : '';
    openModal(settingsOverlay);
  }

  $('online-settings-save').addEventListener('click', () => {
    onlineSettings = onlineApi.saveSettings({
      signaling: $('settings-signaling').value.split('\n'),
      turn: {
        urls: $('settings-turn-url').value,
        username: $('settings-turn-user').value,
        credential: $('settings-turn-pass').value,
      },
    });
    closeModal(settingsOverlay);
    flashTitle(
      sessionActive()
        ? 'MathNotes — ustawienia zapisane, zadziałają przy następnej sesji'
        : 'MathNotes — ustawienia połączenia zapisane',
      3000,
    );
  });

  $('online-share-copy').addEventListener('click', copyInvite);
  $('online-share-end').addEventListener('click', stopSession);
  $('online-share-settings').addEventListener('click', openOnlineSettings);
  $('online-join-ok').addEventListener('click', submitJoin);
  joinInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      submitJoin();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeModal(joinOverlay);
    }
  });

  onlineStatusBtn.addEventListener('click', () => {
    if (sessionActive()) openModal(shareOverlay);
    else openJoin();
  });

  // ==========================================================================
  // Akcje menu
  // ==========================================================================

  function openAnnotationList() {
    renderAnnotationList();
    openModal(annotationListOverlay);
  }

  const handlers = {
    'file:new': doNew,
    'file:open': doOpen,
    'file:save': () => doSave(false),
    'file:save-as': () => doSave(true),
    'file:export-pdf': exportPdf,
    'edit:undo': () => {
      notebook.undo();
      updateHistoryButtons();
    },
    'edit:redo': () => {
      notebook.redo();
      updateHistoryButtons();
    },
    'edit:keymap': openKeymap,
    'view:annotation-list': openAnnotationList,
    'view:annotation-lines': (visible) => {
      showAnnotationLines = visible !== false;
      render();
    },
    'view:reset': () => {
      view = { x: 0, y: 0, scale: 1 };
      tiles.clear();
      updateZoomIndicator();
      render();
    },
    'online:start': () => {
      if (sessionActive()) openModal(shareOverlay);
      else startSession(null, { fresh: false });
    },
    'online:join': openJoin,
    'online:copy-invite': copyInvite,
    'online:leave': stopSession,
    'online:settings': openOnlineSettings,
  };

  function dispatch(action, payload) {
    const handler = handlers[action];
    if (handler) handler(payload);
    else flashTitle('MathNotes — nieznana akcja menu: ' + action);
  }

  window.api.onMenu(dispatch);
  window.api.onOpened(applyOpened);
  window.api.onSaveAndClose(async () => {
    if (await doSave(false)) window.api.readyToClose();
  });

  // ==========================================================================
  // Start
  // ==========================================================================

  detachNotebook = notebook.observe(handleDocChange);
  rebuildKeyToAction();
  setBrushType(brushType);
  setEraseMode(eraseMode);
  setPressureSensitive(pressureSensitive);
  setColor(currentColor);
  applyWidth(currentWidth);
  setTool('pen');
  updateZoomIndicator();
  updateOnlineStatusUI();
  updateHistoryButtons();
  refreshTitle();
  renderAnnotationList();

  new ResizeObserver(resizeCanvas).observe(mainArea);
  resizeCanvas();
  setInterval(autosaveTick, AUTOSAVE_INTERVAL_MS);
  window.api.ready();
})();
