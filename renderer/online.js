// Tryb online: y-webrtc, bez własnego serwera.
//
// Zasada nadrzędna: aplikacja nigdy nie otwiera nasłuchującego portu i nie ma
// backendu. Provider powstaje dopiero po świadomym uruchomieniu sesji, a sesja
// istnieje wyłącznie w pamięci uczestników i znika, gdy się kończy.
//
// Ten moduł nie dotyka DOM — kursory i panele rysuje renderer.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.MathNotesOnline = factory(root.MathNotesCore);
})(typeof self !== 'undefined' ? self : globalThis, function (core) {
  'use strict';

  // --- Kod zaproszenia -----------------------------------------------------

  const INVITE_PREFIX = 'mn1';
  const TOKEN_BYTES = 16; // 128 bitów
  const TOKEN_CHARS = 22; // tyle daje base64url z 16 bajtów, bez dopełnienia
  const INVITE_RE = new RegExp(
    '^' + INVITE_PREFIX + '-([A-Za-z0-9_-]{' + TOKEN_CHARS + '})-([A-Za-z0-9_-]{' + TOKEN_CHARS + '})$',
  );

  // --- Połączenie ----------------------------------------------------------

  // Więcej niż jeden, bo to jedyny element trybu online, którego nie mamy.
  // Gdy jedyny domyślny serwer padł, objaw był mylący: sesja startowała, kod
  // się generował, a druga osoba po prostu nigdy się nie pojawiała. y-webrtc
  // łączy się ze wszystkimi naraz, więc wystarczy, że działa którykolwiek.
  const DEFAULT_SIGNALING = Object.freeze([
    'wss://demos.yjs.dev/ws',
    'wss://yjs-signaling.fly.dev',
    'wss://y-webrtc-eu.fly.dev',
  ]);
  const DEFAULT_ICE_SERVERS = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }]);
  const MAX_PEERS = 9; // razem z tobą maksymalnie 10 osób
  const MAX_SIGNALING_SERVERS = 5;
  const SIGNALING_TIMEOUT_MS = 8000;
  const CURSOR_HZ = 20;
  const CURSOR_INTERVAL_MS = 1000 / CURSOR_HZ;
  const SETTINGS_KEY = 'mathnotes.online.settings';
  const IDENTITY_KEY = 'mathnotes.online.identity';
  const MAX_NAME_LENGTH = 32;
  const MAX_URL_LENGTH = 200;
  const MAX_CREDENTIAL_LENGTH = 128;

  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const PEER_COLORS = Object.freeze(['#ff8a5c', '#5cc8ff', '#a78bfa', '#5cd6a0', '#ffd166', '#ff7ab8']);
  const PEER_NAMES = Object.freeze(['Sowa', 'Lis', 'Jeż', 'Ryś', 'Żuraw', 'Borsuk', 'Wydra', 'Kruk', 'Łoś']);

  function randomToken() {
    const bytes = new Uint8Array(TOKEN_BYTES);
    crypto.getRandomValues(bytes); // nigdy Math.random
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * `mn1-<roomId>-<secret>`. roomId widzi serwer sygnalizacyjny; secret nie
   * opuszcza tego procesu inaczej niż jako opcja `password` providera.
   */
  function createInviteCode() {
    return INVITE_PREFIX + '-' + randomToken() + '-' + randomToken();
  }

  function parseInviteCode(code) {
    if (typeof code !== 'string') return null;
    const match = INVITE_RE.exec(code.trim());
    if (!match) return null;
    return { roomId: match[1], secret: match[2] };
  }

  // --- Ustawienia połączenia -----------------------------------------------

  function isSignalingUrl(url) {
    // Wyłącznie wss. Po ws:// sygnalizacja szłaby otwartym tekstem — szyfrowanie
    // treści hasłem pokoju nadal by działało, ale metadane wyciekałyby po drodze.
    return typeof url === 'string' && url.length <= MAX_URL_LENGTH && /^wss:\/\/[^\s]+$/.test(url);
  }

  function normalizeTurn(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const urls = typeof raw.urls === 'string' ? raw.urls.trim() : '';
    if (urls.length > MAX_URL_LENGTH || !/^turns?:[^\s]+$/.test(urls)) return null;
    return {
      urls,
      username: typeof raw.username === 'string' ? raw.username.slice(0, MAX_CREDENTIAL_LENGTH) : '',
      credential: typeof raw.credential === 'string' ? raw.credential.slice(0, MAX_CREDENTIAL_LENGTH) : '',
    };
  }

  function normalizeSettings(raw) {
    const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const signaling = Array.isArray(value.signaling)
      ? value.signaling.map((url) => (typeof url === 'string' ? url.trim() : '')).filter(isSignalingUrl)
      : [];
    return {
      signaling: signaling.length > 0 ? signaling.slice(0, MAX_SIGNALING_SERVERS) : DEFAULT_SIGNALING.slice(),
      turn: normalizeTurn(value.turn),
    };
  }

  // Ustawienia żyją w localStorage renderera, nigdy w pliku notatnika —
  // notatnik ma się otwierać na cudzym komputerze bez ciągnięcia za sobą
  // czyichś danych dostępowych do TURN.
  function loadSettings() {
    try {
      return normalizeSettings(JSON.parse(globalThis.localStorage.getItem(SETTINGS_KEY)));
    } catch {
      return normalizeSettings(null);
    }
  }

  function saveSettings(raw) {
    const value = normalizeSettings(raw);
    try {
      globalThis.localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
    } catch {
      // Brak localStorage nie może wywalić sesji — ustawienia po prostu nie przetrwają.
    }
    return value;
  }

  // --- Awareness -----------------------------------------------------------

  // Nazwa trafia wyłącznie do textContent, ale znaki sterujące, zero-width
  // i przesterowanie kierunku pisma potrafią zmylić wzrokowo mimo to.
  const UNSAFE_NAME_CHARS = new RegExp(
    '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\ufeff]',
    'g',
  );

  function sanitizeName(raw) {
    return String(raw).replace(UNSAFE_NAME_CHARS, '').trim().slice(0, MAX_NAME_LENGTH);
  }

  function randomIdentity() {
    const bytes = new Uint8Array(2);
    crypto.getRandomValues(bytes);
    return {
      name: PEER_NAMES[bytes[0] % PEER_NAMES.length],
      color: PEER_COLORS[bytes[1] % PEER_COLORS.length],
    };
  }

  /** Nick i kolor, którymi przedstawiasz się innym. Puste pola dostają losowe. */
  function normalizeIdentity(raw, fallback) {
    const base = fallback || randomIdentity();
    const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const name = sanitizeName(typeof value.name === 'string' ? value.name : '');
    return {
      name: name || base.name,
      color: typeof value.color === 'string' && COLOR_RE.test(value.color) ? value.color : base.color,
    };
  }

  function loadIdentity() {
    try {
      const saved = JSON.parse(globalThis.localStorage.getItem(IDENTITY_KEY));
      // Bez zapisanej tożsamości losujemy raz i zapamiętujemy, żeby nick nie
      // zmieniał się między sesjami.
      if (saved === null) return saveIdentity(randomIdentity());
      return normalizeIdentity(saved);
    } catch {
      return randomIdentity();
    }
  }

  function saveIdentity(raw) {
    const value = normalizeIdentity(raw);
    try {
      globalThis.localStorage.setItem(IDENTITY_KEY, JSON.stringify(value));
    } catch {
      // Brak localStorage nie może wywalić sesji.
    }
    return value;
  }

  /** Stan awareness od innej osoby jest niezaufany jak każda inna treść. */
  function validatePeerState(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

    const name = sanitizeName(typeof value.name === 'string' ? value.name : '');
    const color = typeof value.color === 'string' && COLOR_RE.test(value.color) ? value.color : '#9aa0a6';

    let cursor = null;
    const raw = value.cursor;
    if (
      raw !== null &&
      typeof raw === 'object' &&
      Number.isFinite(raw.x) &&
      Number.isFinite(raw.y) &&
      raw.x >= core.MIN_WORLD_X &&
      raw.x <= core.MAX_WORLD_X &&
      raw.y >= core.MIN_WORLD_Y &&
      raw.y <= core.MAX_WORLD_Y
    ) {
      cursor = { x: raw.x, y: raw.y };
    }

    return { name: name || 'Ktoś', color, cursor };
  }

  // --- Sesja ---------------------------------------------------------------

  class OnlineSession {
    /**
     * @param {object} Collab window.Collab ze zvendorowanego bundle'a
     * @param {object} notebook instancja NotebookDoc
     */
    constructor(Collab, notebook) {
      this.Collab = Collab;
      this.notebook = notebook;
      this.provider = null;
      this.awareness = null;
      this.identity = loadIdentity();

      // Pełny kod zaproszenia trzymamy wyłącznie w pamięci, na potrzeby
      // przycisku „Kopiuj”. Nigdy do pliku, nigdy do logów.
      this._code = null;

      this._handlers = new Map();
      this._appliedBytes = 0;
      this._lastCursorAt = 0;
      this._pendingCursor = null;
      this._cursorTimer = 0;
      this._signalingTimer = 0;
      this._onDocUpdate = null;
    }

    get active() {
      return this.provider !== null;
    }

    get inviteCode() {
      return this._code;
    }

    get connected() {
      return this.provider !== null && this.provider.connected === true;
    }

    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, new Set());
      this._handlers.get(event).add(handler);
      return () => this._handlers.get(event).delete(handler);
    }

    _emit(event, payload) {
      const set = this._handlers.get(event);
      if (!set) return;
      for (const handler of set) handler(payload);
    }

    /**
     * @param {object} [options]
     * @param {string} [options.code] kod zaproszenia; brak = nowa sesja
     * @param {object} [options.settings] surowe ustawienia, przepuszczane przez normalizeSettings
     * @param {object} [options.identity] nick i kolor; brak = zapamiętane
     * @returns {string} kod zaproszenia tej sesji
     */
    start(options) {
      if (this.provider) throw new Error('Sesja online już trwa.');
      const opts = options || {};

      const parsed = opts.code ? parseInviteCode(opts.code) : null;
      if (opts.code && !parsed) throw new Error('Nieprawidłowy kod zaproszenia.');

      const code = parsed ? opts.code.trim() : createInviteCode();
      const invite = parsed || parseInviteCode(code);
      const settings = normalizeSettings(opts.settings);
      if (opts.identity) this.identity = normalizeIdentity(opts.identity, this.identity);

      const iceServers = DEFAULT_ICE_SERVERS.slice();
      if (settings.turn) iceServers.push({ ...settings.turn });

      this.provider = new this.Collab.WebrtcProvider(invite.roomId, this.notebook.doc, {
        signaling: settings.signaling,
        // Jedyne miejsce, w którym pojawia się secret. y-webrtc robi z niego
        // klucz AES-GCM (PBKDF2) i szyfruje nim CAŁĄ sygnalizację, łącznie
        // z SDP i odciskami certyfikatów DTLS — serwer sygnalizacyjny widzi
        // tylko losowy roomId i szum.
        password: invite.secret,
        maxConns: MAX_PEERS,
        filterBcConns: true,
        peerOpts: { config: { iceServers } },
      });

      this._code = code;
      this.awareness = this.provider.awareness;
      this.awareness.setLocalStateField('name', this.identity.name);
      this.awareness.setLocalStateField('color', this.identity.color);

      this.provider.on('status', () => this._emit('status', { connected: this.connected }));
      this.provider.on('peers', () => this._emit('peers', this.peers()));
      this.awareness.on('change', () => this._emit('peers', this.peers()));

      // Limit rozmiaru dokumentu. Zliczanie bajtów aktualizacji jest tanie
      // i zawsze zawyża, więc pełny pomiar robimy dopiero po przekroczeniu progu.
      this._onDocUpdate = (update, origin) => {
        if (origin !== this.provider) return;
        this._appliedBytes += update.byteLength;
        if (this._appliedBytes > core.MAX_DOC_BYTES) this._enforceSizeLimit();
      };
      this.notebook.doc.on('update', this._onDocUpdate);

      this._signalingTimer = setTimeout(() => {
        if (this.provider && !this.connected) {
          this._emit('error', 'Żaden serwer sygnalizacyjny nie odpowiada.');
        }
      }, SIGNALING_TIMEOUT_MS);

      this._emit('started', { code });
      return code;
    }

    _enforceSizeLimit() {
      this._appliedBytes = 0;
      const bytes = this.Collab.Y.encodeStateAsUpdate(this.notebook.doc).byteLength;
      if (bytes <= core.MAX_DOC_BYTES) return;
      this.stop();
      this._emit('error', 'Dokument przekroczył limit rozmiaru — sesja przerwana.');
    }

    /** Zmiana nicku albo koloru w trakcie trwającej sesji. */
    setIdentity(raw) {
      this.identity = normalizeIdentity(raw, this.identity);
      if (this.awareness) {
        this.awareness.setLocalStateField('name', this.identity.name);
        this.awareness.setLocalStateField('color', this.identity.color);
      }
      return this.identity;
    }

    /** Pozycja kursora w układzie strony, ograniczona do ~20 Hz. */
    setCursor(x, y) {
      if (!this.awareness) return;
      const point =
        Number.isFinite(x) && Number.isFinite(y)
          ? { x: core.clamp(x, core.MIN_WORLD_X, core.MAX_WORLD_X), y: core.clamp(y, core.MIN_WORLD_Y, core.MAX_WORLD_Y) }
          : null;

      const now = Date.now();
      const elapsed = now - this._lastCursorAt;
      if (elapsed >= CURSOR_INTERVAL_MS) {
        this._lastCursorAt = now;
        this.awareness.setLocalStateField('cursor', point);
        return;
      }

      // Ostatnia pozycja w oknie i tak musi dojść, inaczej cudzy kursor zamiera
      // w losowym miejscu po zatrzymaniu ręki.
      this._pendingCursor = point;
      if (this._cursorTimer) return;
      this._cursorTimer = setTimeout(() => {
        this._cursorTimer = 0;
        if (!this.awareness) return;
        this._lastCursorAt = Date.now();
        this.awareness.setLocalStateField('cursor', this._pendingCursor);
        this._pendingCursor = null;
      }, CURSOR_INTERVAL_MS - elapsed);
    }

    peers() {
      const out = [];
      if (!this.awareness) return out;
      for (const [clientId, state] of this.awareness.getStates()) {
        if (clientId === this.awareness.clientID) continue;
        const peer = validatePeerState(state);
        if (peer) out.push({ clientId, name: peer.name, color: peer.color, cursor: peer.cursor });
      }
      return out;
    }

    stop() {
      if (!this.provider) return;

      clearTimeout(this._signalingTimer);
      clearTimeout(this._cursorTimer);
      this._signalingTimer = 0;
      this._cursorTimer = 0;
      this._pendingCursor = null;

      if (this._onDocUpdate) this.notebook.doc.off('update', this._onDocUpdate);
      this._onDocUpdate = null;

      // destroy() providera nie rusza Y.Doc — notatnik zostaje, znika tylko sesja.
      this.provider.destroy();
      this.provider = null;
      this.awareness = null;
      this._code = null;
      this._appliedBytes = 0;

      this._emit('stopped', null);
    }
  }

  return {
    INVITE_PREFIX,
    DEFAULT_SIGNALING,
    DEFAULT_ICE_SERVERS,
    MAX_PEERS,
    CURSOR_HZ,
    SIGNALING_TIMEOUT_MS,
    SETTINGS_KEY,
    IDENTITY_KEY,
    PEER_COLORS,
    PEER_NAMES,
    MAX_NAME_LENGTH,
    normalizeIdentity,
    loadIdentity,
    saveIdentity,
    createInviteCode,
    parseInviteCode,
    isSignalingUrl,
    normalizeSettings,
    loadSettings,
    saveSettings,
    sanitizeName,
    validatePeerState,
    randomIdentity,
    OnlineSession,
  };
});
