'use strict';

// Okablowanie DOM/canvas. Logika bez DOM mieszka w renderer/core.js,
// mutacje dokumentu w renderer/doc.js.
(function () {
  const core = window.MathNotesCore;
  const { NotebookDoc } = window.MathNotesDoc;
  const { Y } = window.Collab;

  const TAU = Math.PI * 2;

  // --- Stałe UI ------------------------------------------------------------

  const HOLD_MS = 420; // przytrzymanie, po którym otwiera się flyout
  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 5;
  const ZOOM_STEP = 1.25;
  // Powyżej tej skali cache'u rysujemy kreski wprost zamiast z kafli: przy
  // powiększeniu widać ich mało, a obraz zostaje ostry zamiast rozciągnięty.
  const MAX_CACHE_SCALE = 2;
  const HIGHLIGHTER_ALPHA = 0.32;

  const PEN_COLORS = ['#ffffff', '#ffd34d', '#6fc3ff', '#ff7a7a', '#8ee87a'];
  const HIGHLIGHTER_COLORS = ['#ffee00', '#4cff9e', '#ff8ad4', '#7ab8ff'];
  const PEN_SIZES = [1, 2, 3.5, 6];
  const HIGHLIGHTER_SIZES = [12, 20, 30];
  const ERASER_RADII = [8, 16, 32];

  // --- Elementy ------------------------------------------------------------

  const surface = document.getElementById('surface');
  const spacer = document.getElementById('spacer');
  const canvas = document.getElementById('canvas');
  const flyout = document.getElementById('flyout');
  const eraserCursor = document.getElementById('eraser-cursor');
  const undoButton = document.getElementById('btn-undo');
  const redoButton = document.getElementById('btn-redo');

  // desynchronized zmniejsza opóźnienie między piórem a pikselem na ekranie.
  const ctx = canvas.getContext('2d', { desynchronized: true });

  // --- Stan narzędzi -------------------------------------------------------

  const settings = {
    pen: { tool: 'pen', brush: 'round', color: PEN_COLORS[0], size: PEN_SIZES[1] },
    highlighter: { tool: 'highlighter', brush: 'fine', color: HIGHLIGHTER_COLORS[0], size: HIGHLIGHTER_SIZES[1] },
    eraser: { mode: 'whole', radius: ERASER_RADII[1] },
  };
  let activeTool = 'pen';

  // --- Dokument ------------------------------------------------------------

  let notebook = new NotebookDoc(Y);
  let detachNotebook = null;
  let docName = null;
  let dirty = false;

  // --- Widok ---------------------------------------------------------------

  let zoom = 1; // 1 = kartka dokładnie na szerokość okna
  let panX = 0; // przesunięcie poziome widoku, tylko gdy kartka nie mieści się w oknie
  let viewW = 0;
  let viewH = 0;
  let dpr = window.devicePixelRatio || 1;
  let contentBottom = 0; // najniższy punkt zawartości, w pikselach strony

  function scale() {
    // Kartka ma stałą szerokość, więc „rozmiar rzeczywisty” to szerokość okna.
    return (zoom * viewW) / core.PAGE_WIDTH;
  }

  function pageWidthPx() {
    return core.PAGE_WIDTH * scale();
  }

  function maxPanX() {
    return Math.max(0, pageWidthPx() - viewW);
  }

  function originX() {
    const overflow = maxPanX();
    return overflow > 0 ? -panX : (viewW - pageWidthPx()) / 2;
  }

  function scrollTopPx() {
    return surface.scrollTop;
  }

  function toPageX(clientX) {
    return (clientX - canvas.getBoundingClientRect().left - originX()) / scale();
  }

  function toPageY(clientY) {
    return (clientY - canvas.getBoundingClientRect().top + scrollTopPx()) / scale();
  }

  // --- Cache kresek --------------------------------------------------------
  //
  // Renderer trzyma własne odczytane kreski, bo do rysowania i do bboxów
  // potrzebuje ich raz na przerysowanie, a nie raz na klatkę.

  const strokeCache = new Map(); // Y.Map -> { stroke, bounds }

  function entryFor(map) {
    let entry = strokeCache.get(map);
    if (entry === undefined) {
      const stroke = core.validateStroke(map.toJSON());
      entry = stroke ? { stroke, bounds: core.strokeBounds(stroke) } : null;
      strokeCache.set(map, entry);
    }
    return entry;
  }

  function forgetStroke(map) {
    strokeCache.delete(map);
  }

  // --- Cache kafli ---------------------------------------------------------

  const tiles = new Map(); // index -> { canvas, ctx, scale }
  let tilesValid = false;

  function cacheScale() {
    return Math.min(dpr * scale(), MAX_CACHE_SCALE);
  }

  function usesTiles() {
    return dpr * scale() <= MAX_CACHE_SCALE;
  }

  function invalidateAllTiles() {
    tiles.clear();
    tilesValid = true;
  }

  function invalidateTileRange(bounds) {
    const range = core.tileRange(bounds);
    if (!range) return;
    for (let i = range.first; i <= range.last; i++) tiles.delete(i);
  }

  function buildTile(index) {
    const s = cacheScale();
    const tile = {
      canvas: document.createElement('canvas'),
      scale: s,
    };
    tile.canvas.width = Math.ceil(core.PAGE_WIDTH * s);
    tile.canvas.height = Math.ceil(core.TILE_HEIGHT * s);
    tile.ctx = tile.canvas.getContext('2d');

    // Rysujemy w układzie strony; przesunięcie sprowadza kafel do jego wycinka.
    tile.ctx.setTransform(s, 0, 0, s, 0, -index * core.TILE_HEIGHT * s);

    const top = index * core.TILE_HEIGHT;
    const tileBounds = { minX: -Infinity, maxX: Infinity, minY: top, maxY: top + core.TILE_HEIGHT };

    drawImagesInto(tile.ctx, tileBounds);
    for (const map of notebook.strokes) {
      if (map === activeStrokeMap) continue; // rysowana właśnie kreska żyje na wierzchu
      const entry = entryFor(map);
      if (!entry || !core.boundsIntersect(entry.bounds, tileBounds)) continue;
      drawStroke(tile.ctx, entry.stroke);
    }

    tiles.set(index, tile);
    return tile;
  }

  function evictDistantTiles(first, last) {
    for (const index of tiles.keys()) {
      if (index < first - 1 || index > last + 1) tiles.delete(index);
    }
  }

  // --- Obrazy --------------------------------------------------------------

  const bitmaps = new Map(); // id -> ImageBitmap

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
      invalidateTileRange(core.imageBounds(image));
      scheduleRender();
    } catch {
      bitmaps.set(image.id, null); // uszkodzony obraz po prostu się nie pokaże
    }
  }

  function drawImagesInto(target, clip) {
    for (const map of notebook.images) {
      const image = core.validateImage(map.toJSON());
      if (!image) continue;
      const bounds = core.imageBounds(image);
      if (!core.boundsIntersect(bounds, clip)) continue;
      const bitmap = bitmaps.get(image.id);
      if (bitmap) target.drawImage(bitmap, image.x, image.y, image.w, image.h);
      else if (!bitmaps.has(image.id)) decodeImage(image);
    }
  }

  // --- Dwie ścieżki renderowania -------------------------------------------
  //
  // Obie liczą szerokość przez core.segmentWidth — to jest jedyny powód, dla
  // którego linia nie skacze w momencie puszczenia pióra.

  function constantWidth(stroke) {
    return stroke.tool === 'highlighter' || stroke.brush === 'fine';
  }

  function drawSegments(target, stroke, from, to) {
    const pts = stroke.pts;
    target.strokeStyle = stroke.color;
    target.lineCap = 'round';
    target.lineJoin = 'round';
    target.globalAlpha = stroke.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1;

    if (constantWidth(stroke)) {
      // Stała grubość: cała łamana jednym pociągnięciem, znacznie taniej.
      target.lineWidth = core.segmentWidth(stroke, from);
      target.beginPath();
      target.moveTo(pts[from * 3], pts[from * 3 + 1]);
      for (let i = from + 1; i <= to + 1; i++) target.lineTo(pts[i * 3], pts[i * 3 + 1]);
      target.stroke();
    } else {
      for (let i = from; i <= to; i++) {
        target.lineWidth = core.segmentWidth(stroke, i);
        target.beginPath();
        target.moveTo(pts[i * 3], pts[i * 3 + 1]);
        target.lineTo(pts[(i + 1) * 3], pts[(i + 1) * 3 + 1]);
        target.stroke();
      }
    }

    target.globalAlpha = 1;
  }

  function drawDot(target, stroke) {
    target.globalAlpha = stroke.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1;
    target.fillStyle = stroke.color;
    target.beginPath();
    target.arc(stroke.pts[0], stroke.pts[1], core.widthAt(stroke, 0) / 2, 0, TAU);
    target.fill();
    target.globalAlpha = 1;
  }

  /** Kanoniczne, pełne przerysowanie: finalizacja, zoom, undo, cudze zmiany. */
  function drawStroke(target, stroke) {
    const n = core.pointCount(stroke);
    if (n === 0) return;
    if (n === 1) drawDot(target, stroke);
    else drawSegments(target, stroke, 0, n - 2);
  }

  /** Inkrementalne dorysowanie tylko tego, co przybyło od `fromPoint`. */
  function drawLatestSegment(target, stroke, fromPoint) {
    const n = core.pointCount(stroke);
    if (n === 1) {
      drawDot(target, stroke);
      return;
    }
    if (n < 2 || fromPoint >= n) return;
    drawSegments(target, stroke, Math.max(0, fromPoint - 1), n - 2);
  }

  // --- Tło strony ----------------------------------------------------------

  function drawBackground() {
    const s = scale();
    const x0 = originX();
    const width = pageWidthPx();

    ctx.fillStyle = '#000000';
    ctx.fillRect(x0, 0, width, viewH);

    const background = notebook.meta.get('background') || 'plain';
    if (background === 'plain') return;

    const step = core.GRID_SIZE * s;
    if (step < 6) return; // przy mocnym pomniejszeniu siatka zlewa się w szarość

    const top = scrollTopPx();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, width, viewH);
    ctx.clip();
    ctx.strokeStyle = '#ffffff14';
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let y = Math.floor(top / step) * step - top; y < viewH; y += step) {
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x0 + width, Math.round(y) + 0.5);
    }
    if (background === 'grid') {
      for (let x = 0; x <= core.PAGE_WIDTH; x += core.GRID_SIZE) {
        const sx = Math.round(x0 + x * s) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, viewH);
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  // --- Pełne przerysowanie -------------------------------------------------

  let renderScheduled = false;

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function render() {
    if (viewW === 0 || viewH === 0) return;
    // O(n) po całym dokumencie — raz na przerysowanie, nie raz na zmianę.
    if (contentBottomStale) recomputeContentBottom();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    drawBackground();

    const s = scale();
    const top = scrollTopPx();
    const visible = {
      minX: -Infinity,
      maxX: Infinity,
      minY: top / s,
      maxY: (top + viewH) / s,
    };

    if (usesTiles()) {
      const range = core.tileRange(visible);
      evictDistantTiles(range.first, range.last);
      for (let i = range.first; i <= range.last; i++) {
        const tile = tiles.get(i) || buildTile(i);
        ctx.drawImage(
          tile.canvas,
          originX(),
          i * core.TILE_HEIGHT * s - top,
          pageWidthPx(),
          core.TILE_HEIGHT * s,
        );
      }
    } else {
      // ponytail: powyżej MAX_CACHE_SCALE rysujemy wprost — kafel w tej skali
      // byłby ogromny, a widocznych kresek jest wtedy mało. Gdyby to zaczęło
      // zwalniać, następnym krokiem są kafle także w poziomie.
      tiles.clear();
      ctx.save();
      ctx.translate(originX(), -top);
      ctx.scale(s, s);
      drawImagesInto(ctx, visible);
      for (const map of notebook.strokes) {
        if (map === activeStrokeMap) continue;
        const entry = entryFor(map);
        if (!entry || !core.boundsIntersect(entry.bounds, visible)) continue;
        drawStroke(ctx, entry.stroke);
      }
      ctx.restore();
    }

    renderPeers();

    if (activeStroke && core.pointCount(activeStroke) > 0) {
      ctx.save();
      ctx.translate(originX(), -top);
      ctx.scale(s, s);
      drawStroke(ctx, activeStroke);
      ctx.restore();
      drawnUpTo = core.pointCount(activeStroke);
    }
  }

  /** Dorysowanie na wierzchu, bez czyszczenia — ścieżka o najniższym opóźnieniu. */
  function paintLive(stroke, fromPoint) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(originX(), -scrollTopPx());
    ctx.scale(scale(), scale());
    drawLatestSegment(ctx, stroke, fromPoint);
    ctx.restore();
  }

  // --- Rozmiar okna i pasek przewijania ------------------------------------

  let contentBottomStale = false;

  function scheduleContentRecompute() {
    contentBottomStale = true;
    scheduleRender();
  }

  function recomputeContentBottom() {
    contentBottomStale = false;
    let bottom = 0;
    for (const map of notebook.strokes) {
      const entry = entryFor(map);
      if (entry && entry.bounds.maxY > bottom) bottom = entry.bounds.maxY;
    }
    for (const map of notebook.images) {
      const image = core.validateImage(map.toJSON());
      if (image && image.y + image.h > bottom) bottom = image.y + image.h;
    }
    contentBottom = bottom;
    updateSpacer();
  }

  function updateSpacer() {
    // Zawsze zostaje ekran zapasu pod spodem — kartka ciągnie się w dół
    // bez końca, ale pasek przewijania musi mieć skończoną długość.
    const height = Math.min(core.MAX_PAGE_HEIGHT * scale(), contentBottom * scale() + viewH);
    spacer.style.height = Math.max(0, Math.round(height)) + 'px';
  }

  function resize() {
    const rect = surface.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    viewW = Math.max(1, Math.round(rect.width));
    viewH = Math.max(1, Math.round(rect.height));

    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);

    panX = Math.min(panX, maxPanX());
    invalidateAllTiles();
    updateSpacer();
    render();
  }

  // --- Tytuł okna jako pasek stanu -----------------------------------------

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
    }, ms || 1800);
  }

  function setDirty(value) {
    if (dirty === value) return;
    dirty = value;
    window.api.setDirty(dirty);
    refreshTitle();
  }

  function updateHistoryButtons() {
    undoButton.disabled = !notebook.canUndo();
    redoButton.disabled = !notebook.canRedo();
  }

  // --- Reakcja na zmiany dokumentu -----------------------------------------

  let activeStrokeMap = null;
  let activeStroke = null;
  let drawnUpTo = 0;

  function handleDocChange(events, transaction, local) {
    let structural = false;

    for (const event of events) {
      const target = event.target;
      // Dosypanie punktów do kreski: unieważniamy tylko kafle tej kreski.
      if (target && target.parent && target.parent.get && target.parent.get('pts') === target) {
        const map = target.parent;
        forgetStroke(map);
        if (map !== activeStrokeMap) {
          const entry = entryFor(map);
          if (entry) invalidateTileRange(entry.bounds);
          // Cudza kreska rośnie w trakcie — dorysowujemy przyrostowo,
          // pełne przerysowanie i tak przyjdzie z kafla.
          if (!local && entry) paintLive(entry.stroke, remoteDrawn.get(map) || 0);
          if (!local && entry) remoteDrawn.set(map, core.pointCount(entry.stroke));
        }
        continue;
      }
      structural = true;
      if (target === notebook.strokes || target === notebook.images) {
        strokeCache.clear();
      } else if (target && target.toJSON) {
        forgetStroke(target);
      }
    }

    if (structural) {
      invalidateAllTiles();
      scheduleContentRecompute();
    }

    if (local) setDirty(true);
    updateHistoryButtons();
    scheduleRender();
  }

  const remoteDrawn = new Map(); // Y.Map cudzej kreski -> ile punktów już narysowano

  function resetCaches() {
    strokeCache.clear();
    bitmaps.clear();
    remoteDrawn.clear();
    invalidateAllTiles();
    surface.scrollTop = 0;
    panX = 0;
  }

  /**
   * Świeży dokument zamiast czyszczenia istniejącego. W CRDT skasowanie treści
   * to operacja, która rozeszłaby się po sesji i usunęła notatki pozostałym —
   * „nowy notatnik” musi być nowym Y.Doc, nie pustym starym.
   */
  function replaceNotebook() {
    if (detachNotebook) detachNotebook();
    activeStrokeMap = null;
    activeStroke = null;
    notebook.destroy();
    notebook = new NotebookDoc(Y);
    detachNotebook = notebook.observe(handleDocChange);
    resetCaches();
  }

  // --- Rysowanie piórem ----------------------------------------------------

  let pending = [];
  let flushScheduled = false;
  let panPointer = null;
  // Trwający gest rysowania, rozpoznawany po pointerId. Świadomie NIE po
  // event.buttons: pióro z odwróconą końcówką i część tabletów raportują tam
  // co innego, niż się spodziewasz, a zgubiony stan = kreska z jednego punktu.
  let gesture = null;

  function clampPage(x, y) {
    return {
      x: core.clamp(x, 0, core.PAGE_WIDTH),
      y: core.clamp(y, 0, core.MAX_PAGE_HEIGHT),
    };
  }

  function pressureOf(event) {
    // Mysz zgłasza 0.5 przy wciśniętym przycisku, część tabletów nie zgłasza nic.
    if (event.pointerType === 'pen' && event.pressure > 0) return event.pressure;
    return core.DEFAULT_PRESSURE;
  }

  function eraserActive(event) {
    // Odwrócone pióro (gumka na końcu rysika) działa jak gumka niezależnie
    // od wybranego narzędzia.
    return activeTool === 'eraser' || (event.pointerType === 'pen' && (event.buttons & 32) !== 0);
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
    const point = clampPage(toPageX(event.clientX), toPageY(event.clientY));
    const config = settings[activeTool === 'eraser' ? 'pen' : activeTool];

    activeStroke = {
      id: core.createId(),
      tool: config.tool,
      brush: config.brush,
      color: config.color,
      size: config.size,
      pts: [core.roundCoord(point.x), core.roundCoord(point.y), core.roundPressure(pressureOf(event))],
    };
    activeStrokeMap = notebook.addStroke(activeStroke);
    if (!activeStrokeMap) {
      activeStroke = null;
      flashTitle('Osiągnięto limit liczby kresek');
      return;
    }
    drawnUpTo = 0;
    paintLive(activeStroke, 0);
    drawnUpTo = 1;
  }

  function extendStroke(event) {
    if (!activeStroke) return;
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    const pts = activeStroke.pts;
    let added = false;

    for (const sample of samples.length > 0 ? samples : [event]) {
      const point = clampPage(toPageX(sample.clientX), toPageY(sample.clientY));
      const lastX = pts[pts.length - 3];
      const lastY = pts[pts.length - 2];
      if (!core.shouldKeepPoint(lastX, lastY, point.x, point.y)) continue;

      const x = core.roundCoord(point.x);
      const y = core.roundCoord(point.y);
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

  function endStroke() {
    if (!activeStroke) return;
    flushToDocument();
    const finished = activeStrokeMap;
    activeStrokeMap = null;
    activeStroke = null;
    drawnUpTo = 0;

    if (finished) {
      forgetStroke(finished);
      const entry = entryFor(finished);
      if (entry) invalidateTileRange(entry.bounds);
      recomputeContentBottom();
    }
    // Jedno pociągnięcie = jeden krok cofania, niezależnie od tempa rysowania.
    notebook.stopCapturing();
    updateHistoryButtons();
    scheduleRender();
  }

  // --- Gumka ---------------------------------------------------------------

  function eraserPageRadius() {
    return settings.eraser.radius / scale();
  }

  let lastErasePoint = null;

  function eraseCircle(point, radius) {
    const reach = {
      minX: point.x - radius,
      maxX: point.x + radius,
      minY: point.y - radius,
      maxY: point.y + radius,
    };

    // Odsiewamy po bboxach z lokalnego cache'u, żeby doc.js nie musiał czytać
    // punktów każdej kreski w dokumencie przy każdym kroku gumki.
    const touched = notebook.eraseAt(point.x, point.y, radius, settings.eraser.mode, (map) => {
      const entry = entryFor(map);
      return entry !== null && core.boundsIntersect(entry.bounds, reach);
    });

    if (touched > 0) {
      invalidateTileRange(reach);
      scheduleRender();
    }
  }

  /**
   * Gumka kasuje wzdłuż przebytej drogi, a nie w punktach próbkowania.
   * Bez tego szybki ruch przeskakuje nad kreską: przeglądarka scala kilkadziesiąt
   * ruchów w jedno zdarzenie, a odstęp między dwoma pozycjami bywa większy niż
   * średnica gumki.
   */
  function eraseAlongEvent(event) {
    const radius = eraserPageRadius();
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const list = samples.length > 0 ? samples : [event];

    for (const sample of list) {
      const point = clampPage(toPageX(sample.clientX), toPageY(sample.clientY));
      if (lastErasePoint === null) {
        eraseCircle(point, radius);
      } else {
        const dx = point.x - lastErasePoint.x;
        const dy = point.y - lastErasePoint.y;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / radius));
        for (let i = 1; i <= steps; i++) {
          eraseCircle({ x: lastErasePoint.x + (dx * i) / steps, y: lastErasePoint.y + (dy * i) / steps }, radius);
        }
      }
      lastErasePoint = point;
    }
  }

  function updateEraserCursor(event) {
    if (activeTool !== 'eraser' || event === null) {
      eraserCursor.style.display = 'none';
      return;
    }
    // Okrąg dokładnie w rozmiarze promienia kasowania.
    const diameter = settings.eraser.radius * 2;
    eraserCursor.style.display = 'block';
    eraserCursor.style.width = diameter + 'px';
    eraserCursor.style.height = diameter + 'px';
    eraserCursor.style.left = event.clientX - settings.eraser.radius + 'px';
    eraserCursor.style.top = event.clientY - settings.eraser.radius + 'px';
  }

  // --- Wejście -------------------------------------------------------------

  // Przycisk 0 to normalna końcówka, 5 to odwrócone pióro (gumka na rysiku).
  const DRAWING_BUTTONS = new Set([0, 5]);

  canvas.addEventListener('pointerdown', (event) => {
    closeFlyout();

    if (event.pointerType === 'touch') {
      panPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (!DRAWING_BUTTONS.has(event.button)) return;

    canvas.setPointerCapture(event.pointerId);
    gesture = { id: event.pointerId, erasing: eraserActive(event) };
    lastErasePoint = null;
    if (gesture.erasing) eraseAlongEvent(event);
    else beginStroke(event);
  });

  canvas.addEventListener('pointermove', (event) => {
    updateEraserCursor(event);
    if (sessionActive()) session.setCursor(toPageX(event.clientX), toPageY(event.clientY));

    if (panPointer && event.pointerId === panPointer.id) {
      surface.scrollTop -= event.clientY - panPointer.y;
      if (maxPanX() > 0) {
        panX = core.clamp(panX - (event.clientX - panPointer.x), 0, maxPanX());
      }
      panPointer.x = event.clientX;
      panPointer.y = event.clientY;
      scheduleRender();
      return;
    }

    if (!gesture || event.pointerId !== gesture.id) return;
    if (gesture.erasing) eraseAlongEvent(event);
    else extendStroke(event);
  });

  function releasePointer(event) {
    if (panPointer && event.pointerId === panPointer.id) {
      panPointer = null;
      return;
    }
    if (!gesture || event.pointerId !== gesture.id) return;
    gesture = null;
    lastErasePoint = null;
    endStroke();
  }

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('pointerleave', () => {
    updateEraserCursor(null);
    if (sessionActive()) session.setCursor(NaN, NaN);
  });

  surface.addEventListener('scroll', scheduleRender, { passive: true });

  canvas.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom(zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
        return;
      }
      if (event.shiftKey && maxPanX() > 0) {
        event.preventDefault();
        panX = core.clamp(panX + event.deltaY, 0, maxPanX());
        scheduleRender();
      }
    },
    { passive: false },
  );

  // --- Zoom ----------------------------------------------------------------

  function setZoom(next) {
    const clamped = core.clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (clamped === zoom) return;
    const anchorPage = scrollTopPx() / scale();

    zoom = clamped;
    panX = Math.min(panX, maxPanX());
    invalidateAllTiles();
    updateSpacer();
    surface.scrollTop = anchorPage * scale();
    render();
    flashTitle('Powiększenie ' + Math.round(zoom * 100) + '%', 900);
  }

  // --- Toolbar i flyouty ---------------------------------------------------

  const toolButtons = {
    pen: document.getElementById('tool-pen'),
    highlighter: document.getElementById('tool-highlighter'),
    eraser: document.getElementById('tool-eraser'),
  };

  function selectTool(name) {
    activeTool = name;
    for (const [key, button] of Object.entries(toolButtons)) {
      button.setAttribute('aria-pressed', String(key === name));
    }
    canvas.style.cursor = name === 'eraser' ? 'none' : 'crosshair';
    if (name !== 'eraser') updateEraserCursor(null);
    refreshSwatches();
  }

  function refreshSwatches() {
    document.getElementById('swatch-pen').style.background = settings.pen.color;
    document.getElementById('swatch-highlighter').style.background = settings.highlighter.color;
  }

  function closeFlyout() {
    flyout.dataset.open = 'false';
    flyout.replaceChildren();
  }

  function chip(label, pressed, onPick) {
    const button = document.createElement('button');
    button.className = 'chip';
    button.type = 'button';
    button.textContent = label; // nigdy innerHTML
    button.setAttribute('aria-pressed', String(pressed));
    button.addEventListener('click', () => {
      onPick();
      closeFlyout();
      refreshSwatches();
    });
    return button;
  }

  function section(title, children) {
    const label = document.createElement('div');
    label.className = 'flyout-label';
    label.textContent = title;
    const row = document.createElement('div');
    row.className = 'flyout-row';
    row.append(...children);
    return [label, row];
  }

  function colorButtons(config, palette) {
    return palette.map((value) => {
      const button = document.createElement('button');
      button.className = 'color';
      button.type = 'button';
      button.style.background = value;
      button.title = value;
      button.setAttribute('aria-pressed', String(config.color === value));
      button.addEventListener('click', () => {
        config.color = value;
        closeFlyout();
        refreshSwatches();
      });
      return button;
    });
  }

  function sizeButtons(config, sizes) {
    return sizes.map((value) => {
      const button = document.createElement('button');
      button.className = 'chip size';
      button.type = 'button';
      button.title = value + ' px';
      button.setAttribute('aria-pressed', String(config.size === value));
      const dot = document.createElement('i');
      dot.style.width = Math.min(18, Math.max(2, value)) + 'px';
      dot.style.height = Math.min(18, Math.max(2, value)) + 'px';
      button.append(dot);
      button.addEventListener('click', () => {
        config.size = value;
        closeFlyout();
      });
      return button;
    });
  }

  function openFlyout(name) {
    flyout.replaceChildren();
    const anchor = toolButtons[name].getBoundingClientRect();
    flyout.style.top = Math.round(anchor.top) + 'px';

    if (name === 'pen') {
      const config = settings.pen;
      flyout.append(
        ...section('Pędzel', [
          chip('Nacisk', config.brush === 'round', () => {
            config.brush = 'round';
          }),
          chip('Stała', config.brush === 'fine', () => {
            config.brush = 'fine';
          }),
        ]),
        ...section('Kolor', colorButtons(config, PEN_COLORS)),
        ...section('Grubość', sizeButtons(config, PEN_SIZES)),
      );
    } else if (name === 'highlighter') {
      const config = settings.highlighter;
      flyout.append(
        ...section('Kolor', colorButtons(config, HIGHLIGHTER_COLORS)),
        ...section('Grubość', sizeButtons(config, HIGHLIGHTER_SIZES)),
      );
    } else {
      const config = settings.eraser;
      flyout.append(
        ...section('Tryb', [
          chip('Cała kreska', config.mode === 'whole', () => {
            config.mode = 'whole';
          }),
          chip('Fragment', config.mode === 'split', () => {
            config.mode = 'split';
          }),
        ]),
        ...section(
          'Rozmiar',
          ERASER_RADII.map((value) =>
            chip(value * 2 + ' px', config.radius === value, () => {
              config.radius = value;
            }),
          ),
        ),
      );
    }

    flyout.dataset.open = 'true';
  }

  // Krótkie kliknięcie = akcja domyślna, przytrzymanie = flyout z wariantami.
  for (const [name, button] of Object.entries(toolButtons)) {
    let holdTimer = 0;
    let opened = false;

    button.addEventListener('pointerdown', () => {
      opened = false;
      holdTimer = setTimeout(() => {
        opened = true;
        selectTool(name);
        openFlyout(name);
      }, HOLD_MS);
    });

    const finish = () => {
      clearTimeout(holdTimer);
      if (!opened) {
        closeFlyout();
        selectTool(name);
      }
    };

    button.addEventListener('pointerup', finish);
    button.addEventListener('pointerleave', () => clearTimeout(holdTimer));
  }

  document.addEventListener('pointerdown', (event) => {
    if (flyout.dataset.open === 'true' && !flyout.contains(event.target) && !event.target.closest('.tool')) {
      closeFlyout();
    }
  });

  undoButton.addEventListener('click', () => {
    notebook.undo();
    updateHistoryButtons();
  });
  redoButton.addEventListener('click', () => {
    notebook.redo();
    updateHistoryButtons();
  });

  // --- Plik ----------------------------------------------------------------

  async function doSave(saveAs) {
    const { state, skipped } = notebook.toState();
    const result = await window.api.saveNotebook(state, saveAs);
    if (result.canceled) return false;

    docName = result.name;
    setDirty(false);
    const lost = skipped.strokes + skipped.images;
    flashTitle(lost > 0 ? 'Zapisano, pominięto uszkodzone elementy: ' + lost : 'Zapisano');
    return true;
  }

  function applyOpened(payload) {
    if (blockedByOnline()) return;

    let normalized;
    try {
      normalized = core.normalizeState(payload.raw);
    } catch (err) {
      flashTitle(err.message, 4000);
      return;
    }

    replaceNotebook();
    notebook.loadState(normalized.state);
    docName = payload.name;
    setDirty(false);
    recomputeContentBottom();
    updateHistoryButtons();
    render();

    const lost = normalized.skipped.strokes + normalized.skipped.images;
    if (lost > 0) flashTitle('Otwarto, pominięto uszkodzone elementy: ' + lost, 4000);
  }

  async function doOpen() {
    if (blockedByOnline() || !confirmDiscard()) return;
    const result = await window.api.openNotebook();
    if (result.canceled) return;
    applyOpened(result);
  }

  function confirmDiscard() {
    if (!dirty) return true;
    return window.confirm('Notatnik ma niezapisane zmiany. Odrzucić je?');
  }

  async function doNew() {
    if (blockedByOnline() || !confirmDiscard()) return;
    await window.api.newNotebook();
    replaceNotebook();
    docName = null;
    setDirty(false);
    recomputeContentBottom();
    updateHistoryButtons();
    render();
  }

  async function doInsertImage() {
    const result = await window.api.pickImage();
    if (result.canceled) {
      if (result.reason) flashTitle(result.reason, 3000);
      return;
    }

    let bitmap;
    try {
      const element = new Image();
      element.src = result.dataUrl;
      await element.decode();
      bitmap = await createImageBitmap(element);
    } catch {
      flashTitle('Nie udało się odczytać obrazu', 3000);
      return;
    }

    // Wstawiamy na środek widoku, zmniejszając do szerokości kartki.
    const fit = Math.min(1, (core.PAGE_WIDTH * 0.8) / bitmap.width);
    const w = Math.round(bitmap.width * fit);
    const h = Math.round(bitmap.height * fit);
    const x = core.clamp((core.PAGE_WIDTH - w) / 2, 0, core.PAGE_WIDTH - w);
    const y = core.clamp(scrollTopPx() / scale() + 40, 0, core.MAX_PAGE_HEIGHT - h);

    const image = { id: core.createId(), x, y, w, h, dataUrl: result.dataUrl };
    try {
      notebook.addImage(image);
    } catch {
      flashTitle('Obraz nie przeszedł walidacji', 3000);
      return;
    }
    bitmaps.set(image.id, bitmap);
    recomputeContentBottom();
    invalidateAllTiles();
    render();
  }

  // --- Panele modalne ------------------------------------------------------

  const backdrop = document.getElementById('modal-backdrop');
  const modal = document.getElementById('modal');

  function closeModal() {
    backdrop.dataset.open = 'false';
    modal.replaceChildren();
  }

  // Rośnie przy każdym otwarciu. Akcja może otworzyć kolejny panel (np. „Dołącz”
  // z panelu sesji) — wtedy nie wolno go zamknąć zaraz po powrocie z akcji.
  let modalToken = 0;

  /** @param {Array<{label: string, primary?: boolean, run: () => boolean|void}>} actions */
  function openModal(title, description, body, actions) {
    modalToken += 1;
    modal.replaceChildren();

    const heading = document.createElement('h2');
    heading.textContent = title; // nigdy innerHTML
    modal.append(heading);

    if (description) {
      const paragraph = document.createElement('p');
      paragraph.textContent = description;
      modal.append(paragraph);
    }
    if (body) modal.append(...body);

    const row = document.createElement('div');
    row.className = 'modal-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.primary ? 'btn btn-primary' : 'btn';
      button.textContent = action.label;
      // Akcja zwracająca false zostawia panel otwarty (np. „Kopiuj”).
      button.addEventListener('click', () => {
        const token = modalToken;
        if (action.run() === false) return;
        if (modalToken === token) closeModal();
      });
      row.append(button);
    }
    modal.append(row);

    backdrop.dataset.open = 'true';
  }

  function showNotice(title, message) {
    openModal(title, message, null, [{ label: 'OK', primary: true, run: () => {} }]);
  }

  function field(labelText, element) {
    const label = document.createElement('label');
    label.textContent = labelText;
    return [label, element];
  }

  function choice(group, value, checked, title, hint) {
    const wrap = document.createElement('label');
    wrap.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.value = value;
    input.checked = checked;
    const text = document.createElement('div');
    text.textContent = title;
    const note = document.createElement('span');
    note.textContent = hint;
    text.append(note);
    wrap.append(input, text);
    return { node: wrap, input };
  }

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && backdrop.dataset.open === 'true') closeModal();
  });

  // --- Sesja online --------------------------------------------------------

  const onlineApi = window.MathNotesOnline;
  const peersLayer = document.getElementById('peers');
  const onlineButton = document.getElementById('btn-online');
  const onlineBadge = document.getElementById('online-badge');

  let onlineSettings = onlineApi.loadSettings();
  let session = null;
  let peers = [];

  function sessionActive() {
    return session !== null && session.active;
  }

  function blockedByOnline() {
    if (!sessionActive()) return false;
    flashTitle('Zakończ sesję online, żeby zmienić notatnik', 3500);
    return true;
  }

  function updateOnlineBadge() {
    const on = sessionActive();
    onlineButton.setAttribute('aria-pressed', String(on));
    onlineBadge.dataset.on = String(on);
    onlineBadge.textContent = on ? String(peers.length + 1) : '';
    onlineButton.title = on ? 'Sesja online — ' + (peers.length + 1) + ' os.' : 'Sesja online';
  }

  /** Kursory innych osób. Nazwy trafiają wyłącznie do textContent. */
  function renderPeers() {
    peersLayer.replaceChildren();
    if (!sessionActive()) return;

    const s = scale();
    const top = scrollTopPx();
    for (const peer of peers) {
      if (!peer.cursor) continue;
      const x = originX() + peer.cursor.x * s;
      const y = peer.cursor.y * s - top;
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
      showSessionPanel(session.inviteCode);
      return;
    }
    // „Nowy notatnik” musi być nowym Y.Doc — patrz replaceNotebook.
    if (options && options.fresh) {
      replaceNotebook();
      docName = null;
      setDirty(false);
      recomputeContentBottom();
      updateHistoryButtons();
      render();
    }

    session = new onlineApi.OnlineSession(window.Collab, notebook);
    session.on('peers', (list) => {
      peers = list;
      updateOnlineBadge();
      renderPeers();
    });
    session.on('status', ({ connected }) => {
      flashTitle(connected ? 'Sesja online: połączono' : 'Sesja online: brak połączenia', 2500);
    });
    session.on('error', (message) => showNotice('Sesja online', message));
    session.on('stopped', () => {
      peers = [];
      updateOnlineBadge();
      renderPeers();
    });

    let created;
    try {
      created = session.start({ code: code || undefined, settings: onlineSettings });
    } catch (err) {
      session = null;
      flashTitle(err.message, 4000);
      return;
    }

    updateOnlineBadge();
    showSessionPanel(created);
  }

  function stopSession() {
    if (!sessionActive()) {
      flashTitle('Nie ma aktywnej sesji online');
      return;
    }
    session.stop();
    session = null;
    peers = [];
    updateOnlineBadge();
    renderPeers();
    flashTitle('Sesja online zakończona');
  }

  function copyInvite() {
    if (!sessionActive()) {
      flashTitle('Nie ma aktywnej sesji online');
      return;
    }
    window.api.copyText(session.inviteCode);
    flashTitle('Kod zaproszenia skopiowany');
  }

  function showSessionPanel(code) {
    const input = document.createElement('input');
    input.className = 'code';
    input.readOnly = true;
    input.value = code;

    openModal(
      'Sesja online trwa',
      'Przekaż ten kod osobom, które mają dołączyć — maksymalnie 10 osób razem z tobą. ' +
        'Kto zna kod, może w tej sesji rysować i kasować wszystko. Kod nie jest nigdzie zapisywany ' +
        'i znika razem z sesją.',
      field('Kod zaproszenia', input),
      [
        {
          label: 'Kopiuj',
          primary: true,
          run: () => {
            window.api.copyText(code);
            flashTitle('Kod zaproszenia skopiowany');
            return false;
          },
        },
        { label: 'Zakończ sesję', run: stopSession },
        { label: 'Zamknij', run: () => {} },
      ],
    );
    input.select();
  }

  function showJoinPanel() {
    if (sessionActive()) {
      showSessionPanel(session.inviteCode);
      return;
    }

    const input = document.createElement('input');
    input.className = 'code';
    input.placeholder = 'mn1-...-...';
    input.spellcheck = false;

    // Domyślnie nowy notatnik, żeby nikt przypadkiem nie wysłał cudzym osobom
    // swoich notatek.
    const fresh = choice(
      'join-mode',
      'fresh',
      true,
      'Otwórz sesję jako nowy notatnik',
      'Twoje obecne notatki zostają na dysku i nie trafiają do nikogo.',
    );
    const merge = choice(
      'join-mode',
      'merge',
      false,
      'Scal bieżący notatnik z sesją',
      'Wszystko, co masz teraz na kartce, zobaczą pozostali uczestnicy.',
    );

    openModal(
      'Dołącz do sesji',
      null,
      [...field('Kod zaproszenia', input), ...field('Bieżący notatnik', fresh.node), merge.node],
      [
        {
          label: 'Dołącz',
          primary: true,
          run: () => {
            const code = input.value.trim();
            if (!onlineApi.parseInviteCode(code)) {
              flashTitle('Nieprawidłowy kod zaproszenia', 3000);
              return false;
            }
            startSession(code, { fresh: fresh.input.checked });
          },
        },
        { label: 'Anuluj', run: () => {} },
      ],
    );
    input.focus();
  }

  function showSettingsPanel() {
    const signaling = document.createElement('textarea');
    signaling.value = onlineSettings.signaling.join('\n');
    signaling.spellcheck = false;

    const turnUrl = document.createElement('input');
    turnUrl.placeholder = 'turns:przyklad.pl:5349';
    turnUrl.value = onlineSettings.turn ? onlineSettings.turn.urls : '';
    turnUrl.spellcheck = false;

    const turnUser = document.createElement('input');
    turnUser.placeholder = 'użytkownik';
    turnUser.value = onlineSettings.turn ? onlineSettings.turn.username : '';

    const turnPass = document.createElement('input');
    turnPass.type = 'password';
    turnPass.placeholder = 'hasło';
    turnPass.value = onlineSettings.turn ? onlineSettings.turn.credential : '';

    openModal(
      'Ustawienia połączenia',
      'Serwer sygnalizacyjny służy tylko do odnalezienia się nawzajem — treść notatnika nigdy przez ' +
        'niego nie przechodzi. TURN przydaje się w sieciach, które blokują połączenia bezpośrednie. ' +
        'Te ustawienia zostają na tym komputerze i nie trafiają do pliku notatnika.',
      [
        ...field('Serwery sygnalizacyjne (po jednym w linii, tylko wss://)', signaling),
        ...field('TURN — adres (opcjonalny)', turnUrl),
        ...field('TURN — użytkownik', turnUser),
        ...field('TURN — hasło', turnPass),
      ],
      [
        {
          label: 'Zapisz',
          primary: true,
          run: () => {
            onlineSettings = onlineApi.saveSettings({
              signaling: signaling.value.split('\n'),
              turn: { urls: turnUrl.value, username: turnUser.value, credential: turnPass.value },
            });
            flashTitle(
              sessionActive()
                ? 'Ustawienia zapisane — zadziałają przy następnej sesji'
                : 'Ustawienia zapisane',
              3000,
            );
          },
        },
        { label: 'Anuluj', run: () => {} },
      ],
    );
  }

  onlineButton.addEventListener('click', () => {
    if (sessionActive()) {
      showSessionPanel(session.inviteCode);
      return;
    }
    openModal(
      'Sesja online',
      'Rysowanie na żywo z innymi, bezpośrednio między komputerami. Nie ma serwera, który ' +
        'przechowywałby notatnik — sesja znika, gdy się kończy.',
      null,
      [
        { label: 'Rozpocznij sesję', primary: true, run: () => startSession(null, { fresh: false }) },
        { label: 'Dołącz do sesji', run: showJoinPanel },
        { label: 'Anuluj', run: () => {} },
      ],
    );
  });

  // --- Akcje menu ----------------------------------------------------------

  const handlers = {
    'file:new': doNew,
    'file:open': doOpen,
    'file:save': () => doSave(false),
    'file:save-as': () => doSave(true),
    'file:insert-image': doInsertImage,
    'edit:undo': () => {
      notebook.undo();
      updateHistoryButtons();
    },
    'edit:redo': () => {
      notebook.redo();
      updateHistoryButtons();
    },
    'edit:clear': () => {
      if (notebook.strokes.length === 0 && notebook.images.length === 0) return;
      if (!window.confirm('Wyczyścić cały notatnik? Można to cofnąć.')) return;
      notebook.clear();
    },
    'view:zoom-in': () => setZoom(zoom * ZOOM_STEP),
    'view:zoom-out': () => setZoom(zoom / ZOOM_STEP),
    'view:zoom-reset': () => setZoom(1),
    'online:start': () => {
      if (sessionActive()) showSessionPanel(session.inviteCode);
      else startSession(null, { fresh: false });
    },
    'online:join': showJoinPanel,
    'online:copy-invite': copyInvite,
    'online:leave': stopSession,
    'online:settings': showSettingsPanel,
    'view:background': () => {
      const order = core.BACKGROUNDS;
      const current = notebook.meta.get('background') || 'plain';
      const next = order[(order.indexOf(current) + 1) % order.length];
      notebook.setMeta('background', next);
      render();
      flashTitle('Tło: ' + next, 900);
    },
  };

  function dispatch(action) {
    const handler = handlers[action];
    if (handler) handler();
    else if (core.MENU_ACTIONS.includes(action)) flashTitle('Jeszcze niedostępne: ' + action);
    else flashTitle('Nieznana akcja menu: ' + action);
  }

  window.api.onMenu(dispatch);
  window.api.onOpened(applyOpened);
  window.api.onSaveAndClose(async () => {
    if (await doSave(false)) window.api.readyToClose();
  });

  // --- Start ---------------------------------------------------------------

  new ResizeObserver(resize).observe(surface);

  detachNotebook = notebook.observe(handleDocChange);
  updateOnlineBadge();
  selectTool('pen');
  refreshTitle();
  updateHistoryButtons();
  resize();
  window.api.ready();
})();
