# Instrukcje dla Claude Code: budowa MathNotes

Zbuduj od zera aplikację opisaną w CLAUDE.md: notatnik matematyczny na tablet graficzny (Electron, Windows/macOS). Działa offline-first, a opcjonalny tryb rysowania na żywo z innymi działa peer-to-peer, bez własnego serwera. Dokument danych opiera się na CRDT **Yjs**, a warstwa sieciowa na **y-webrtc** z szyfrowaną sygnalizacją. Trzymaj się poniższej architektury: to świadome decyzje, nie sugestie. Priorytety w kolejności: bezpieczeństwo danych, bezpieczeństwo sieciowe, responsywność pióra, prostota.

## 1. Stack i struktura projektu

- Electron, zwykłe pliki `.js` ładowane przez `<script>`. W runtime nie ma bundlera, TypeScriptu ani transpilacji, a `npm install && npm start` ma działać od razu.
- Zależności produkcyjne są vendorowane do `renderer/vendor/`. Yjs, y-webrtc, y-protocols i lib0 to moduły ESM z zależnościami (y-webrtc potrzebuje też polyfilli), więc jedynym wyjątkiem od zasady „bez build stepu” jest jednorazowy skrypt `npm run vendor`. Skrypt używa esbuild (devDependency) i skleja je w jeden plik `renderer/vendor/collab.bundle.js`, który eksponuje `window.Collab = { Y, WebrtcProvider, awarenessProtocol }`. Wynik commitujesz do repo. Skrypt uruchamiasz tylko przy aktualizacji tych bibliotek, nigdy w `npm start`. Opisz to w README.
- Przypnij dokładne wersje (bez `^`) yjs, y-webrtc, y-protocols i lib0.
- Podział kodu:
  - `main.js`: okno, natywne menu po polsku (Plik/Edycja/Widok/Online/Okno/Pomoc), handlery IPC, zapis i odczyt plików.
  - `preload.js`: jedyny most renderer↔Node.
  - `notebook-file.js`: atomowy zapis.
  - `renderer/core.js`: logika bez DOM, czyli format pliku, `FILE_FORMAT_VERSION`, `normalizeState` z migracjami, walidacja danych, geometria gumki, bboxy, wygładzanie, `widthFactor` oraz konwersja JSON↔Y.Doc. Testy w `test/`.
  - `renderer/doc.js`: model dokumentu na Yjs (schemat opisany niżej), `Y.UndoManager` i API typu `addStroke`, `appendPoints`, `eraseAt`, `addImage`.
  - `renderer/online.js`: provider y-webrtc, awareness (kursory innych osób), obsługa pokoju.
  - `renderer.js`: tylko okablowanie DOM/canvas.

## 2. Bezpieczeństwo procesu Electron (obowiązkowe)

- W `BrowserWindow` ustaw `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` i `webSecurity: true`.
- Renderer ładuje wyłącznie lokalne pliki (`file://`). Blokuj nawigację i nowe okna: `will-navigate` → `preventDefault`, a `setWindowOpenHandler` zwraca `{ action: 'deny' }`. Linki zewnętrzne otwieraj tylko przez `shell.openExternal` z allowlistą `https:`.
- Dodaj nagłówek CSP w `index.html`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss: stun: turn:`. Bez `unsafe-eval`.
- `window.api` wystawiaj przez `contextBridge` wyłącznie jako jawnie nazwane metody. Nigdy nie eksponuj surowego `ipcRenderer` ani `require`. Każdy handler `ipcMain.handle` waliduje argumenty. Ścieżki plików pochodzą tylko z natywnych dialogów albo z listy ostatnich plików, nigdy z tekstu od renderera czy z sieci.
- Nie ładuj żadnych skryptów z CDN.

## 3. Zapis danych

- Zapis jest atomowy: najpierw `<plik>.tmp` z `fsync`, potem `rename` na plik docelowy, a poprzednia wersja trafia do `<plik>.bak`. Nigdy nie zastępuj tego zwykłym `writeFileSync` na plik docelowy.
- Zamknięcie okna z niezapisanym, nienazwanym notatnikiem wymaga potwierdzenia w dialogu.
- Plik to czytelny JSON z polem `version: FILE_FORMAT_VERSION`. Ustaw `FILE_FORMAT_VERSION = 2`, bo model danych przechodzi na Yjs. Przy zapisie eksportujesz Y.Doc do JSON, przy odczycie `normalizeState` migruje starsze wersje i budujesz z nich nowy Y.Doc. Binarnego stanu Yjs nie zapisuj do pliku, żeby format był niezależny od biblioteki. Każda zmiana kształtu danych oznacza bump wersji i nowy krok migracji.

## 4. Model dokumentu (Yjs)

- `doc.getArray('strokes')`: każda kreska to `Y.Map` z polami `id`, `tool`, `color`, `size`, `brush` i `pts`. Pole `pts` to `Y.Array` liczb w płaskim układzie `[x, y, pressure, x, y, pressure, ...]`, z wartościami zaokrąglonymi do 0,1 px i 0,01 nacisku, żeby aktualizacje były małe.
- `doc.getArray('images')`: `Y.Map` z polami `id`, `x`, `y`, `w`, `h` i `dataUrl`.
- `doc.getMap('meta')`: tytuł i ustawienia strony.
- Gumka usuwa całe kreski z tablicy albo je dzieli, zależnie od trybu. Logikę geometrii trzymaj w `core.js`.
- **Undo/redo robi `Y.UndoManager`** z `trackedOrigins` ustawionym na lokalny origin i `captureTimeout` około 300 ms. Zastępuje to dotychczasowe migawki `pushHistory`/`cloneState`. Powód: w sesji online migawka cofnęłaby też zmiany innych osób, a UndoManager cofa tylko twoje. Przy okazji znika problem pamięci przy obrazach.

## 5. Rysowanie i responsywność (krytyczne dla tabletu)

- Pióro musi reagować natychmiast. Wszystko jest local-first: najpierw rysujesz na ekranie, a synchronizacja dzieje się w tle i nigdy nie blokuje rysowania.
- Używaj Pointer Events z `getCoalescedEvents()`, żeby nie gubić próbek z tabletu. Na canvasie ustaw `touch-action: none`.
- Kontekst canvasa twórz jako `getContext('2d', { desynchronized: true })`, co zmniejsza opóźnienie na ekranie.
- Stosuj dwie ścieżki renderowania ze wspólnym `widthFactor`:
  - `drawLatestSegment` rysuje inkrementalnie w trakcie pociągnięcia.
  - `drawStroke` robi pełne, kanoniczne przerysowanie przy finalizacji, zoomie, undo i zmianach od innych osób.
  - Jeśli obie ścieżki policzą szerokość inaczej, linia „skoczy” po puszczeniu pióra. To błąd, który ma wyłapywać test.
- Gotowe kreski trzymaj w canvasie-cache podzielonym na kafle w pionie (np. po 2000 px). Przerysowujesz tylko kafle, które są widoczne i zostały zmienione, a kreski odrzucasz po bboxie.
- Zapisy do Yjs podczas rysowania grupuj w jeden `doc.transact(..., LOCAL_ORIGIN)` na klatkę (`requestAnimationFrame`), a nie jeden na każdy punkt.
- Zmiany od innych osób obsługujesz przez `observeDeep`: nowe punkty cudzej kreski rysujesz inkrementalnie, a pozostałe zmiany unieważniają tylko dotknięte kafle.
- Kursory innych osób wysyłaj przez awareness z ograniczeniem do około 20 Hz.
- UI: ciemny motyw, czarny canvas, wąski toolbar po lewej i żadnych pasków u góry. Kartka ma stałą szerokość `PAGE_WIDTH` i przewija się tylko w pionie. Narzędzia działają tak: klik uruchamia akcję domyślną, przytrzymanie otwiera flyout. Kursor gumki to okrąg o promieniu `eraserScreenRadius`. Status pokazujesz w tytule okna (`flashTitle`).

## 6. Tryb online: y-webrtc, bez własnego serwera

**Zasada nadrzędna:** aplikacja nigdy nie otwiera nasłuchującego portu i nie ma backendu. Sesja istnieje tylko w pamięci uczestników i znika po zakończeniu.

1. Sesja startuje dopiero po kliknięciu „Rozpocznij sesję online”. Wcześniej nie powstaje żaden provider ani połączenie.
2. **Kod zaproszenia** ma postać `mn1-<roomId>-<secret>`. Obie części to po 128 bitów z `crypto.getRandomValues`, zakodowane w base32 lub base64url. Nigdy nie używaj `Math.random()`.
   - `roomId` to nazwa pokoju, którą widzi serwer sygnalizacyjny.
   - `secret` idzie wyłącznie do opcji `password` w `WebrtcProvider`. Serwer sygnalizacyjny nigdy go nie widzi.
3. **Dlaczego to jest bezpieczne:** y-webrtc szyfruje hasłem pokoju (AES-GCM, klucz z PBKDF2) wszystkie wiadomości przechodzące przez sygnalizację, łącznie z SDP i odciskami certyfikatów DTLS. Serwer sygnalizacyjny widzi więc tylko losowe `roomId` i zaszyfrowane dane. Nie może podsłuchać sesji ani podstawić własnych kluczy (brak MITM). Sama transmisja peer-to-peer jest dodatkowo szyfrowana przez DTLS. Do pokoju wejdzie tylko ktoś, kto zna pełny kod.
4. Konfiguracja providera:
   - `signaling`: lista adresów `wss://` z ustawień. Domyślnie publiczne serwery y-webrtc, a użytkownik może w menu Online podać własne. Obsłuż czytelny komunikat w tytule okna, gdy żaden serwer nie odpowiada.
   - `maxConns: 9`, czyli razem z tobą maksymalnie 10 osób. Połączenia ponad limit odrzucaj.
   - `peerOpts.config.iceServers`: STUN domyślnie oraz opcjonalny TURN z ustawień (dla trudnych sieci). Loginu i hasła do TURN nie zapisuj w pliku notatnika.
   - `filterBcConns: true`. Wyłącz synchronizację przez BroadcastChannel między oknami, jeśli nie jest potrzebna.
5. Kod zaproszenia wyświetlaj z przyciskiem „Kopiuj”. Nie zapisuj go w pliku notatnika ani w logach.
6. Przy dołączaniu do sesji zapytaj, czy scalić bieżący notatnik z sesją, czy otworzyć sesję jako nowy notatnik. Domyślnie wybierz nowy notatnik, żeby nikt przypadkiem nie wysłał cudzym osobom swoich notatek.
7. **Dane od innych osób są niezaufane.** Yjs sam łączy aktualizacje, ale treść, którą ktoś wstawił, może być złośliwa. Każdą kreskę i obraz waliduj w `core.js` przed renderowaniem, a niepoprawne pomijaj (fail closed):
   - `pts` musi mieć długość podzielną przez 3, a wartości skończone i mieszczące się w granicach strony.
   - Kreska może mieć maksymalnie 20 000 punktów, a dokument maksymalnie 50 000 kresek.
   - `color` musi pasować do `/^#[0-9a-f]{6}$/i`, a `tool` i `brush` muszą należeć do enuma.
   - `dataUrl` musi zaczynać się od `data:image/png;base64,`, `data:image/jpeg;base64,` albo `data:image/webp;base64,` i mieć maksymalnie 5 MB. Obraz dekoduj przez `createImageBitmap`, nigdy przez `innerHTML`.
   - Nazwy i kolory z awareness wstawiaj wyłącznie przez `textContent`.
   - Wartości od innych osób nigdy nie trafiają do ścieżek plików, IPC, `eval` ani `new Function`.
   - Przy nadejściu zmiany sprawdzaj łączny rozmiar dokumentu. Po przekroczeniu limitu (np. 200 MB) przerwij sesję z komunikatem.
8. **Model zaufania, świadomie:** każdy, kto zna kod, może edytować i usuwać wszystko w dokumencie, bo to narzędzie do rysowania z zaufanymi osobami. CRDT gwarantuje, że równoczesne zmiany się nie gubią, a UndoManager cofa tylko twoje zmiany. Po zakończeniu sesji lokalny plik zapisuje się wyłącznie przez „Zapisz”, więc złośliwe zmiany nie trafiają na dysk automatycznie. Jeśli kiedyś sesje mają obsługiwać nieznajomych, potrzebna jest osobna decyzja architektoniczna (role, podpisy). Nie łataj tego punktowo.
9. Nie dodawaj kont, trwałej historii po stronie serwera, publicznej listy pokoi ani własnego serwera aplikacji.

## 7. Czego nie robić

- Nie dodawaj build stepu do `npm start`. Jedyny wyjątek to `npm run vendor` z sekcji 1.
- Nie dodawaj niezvendorowanych zależności runtime ani skryptów z CDN.
- Nie zmieniaj kształtu JSON-a bez bumpa `FILE_FORMAT_VERSION` i migracji.
- Nie zastępuj atomowego zapisu.
- Nie otwieraj nasłuchujących portów i nie twórz backendu.
- Nie eksponuj `ipcRenderer` ani `require` w rendererze.
- Nie wysyłaj `secret` z kodu zaproszenia nigdzie poza opcję `password` providera.

## 8. Kolejność pracy

1. Szkielet Electron: okno, `preload.js`, CSP, blokada nawigacji, menu.
2. `notebook-file.js` z testami atomowego zapisu i `.bak`.
3. `core.js`: format v2, migracja z v1, walidatory, geometria, `widthFactor`. Testy.
4. `npm run vendor` i bundle Collab.
5. `doc.js`: schemat Yjs, UndoManager, eksport i import JSON. Testy scalania dwóch Y.Doc.
6. `renderer.js`: pointer events, dwie ścieżki renderowania, kafle, narzędzia, UI.
7. `online.js`: kod zaproszenia, provider z `password`, awareness, limity, walidacja danych od innych osób.
8. QA:
   - Dwie instancje na różnych maszynach: rysowanie jednocześnie, rozłączenie i ponowne połączenie, undo w sesji.
   - Próba dołączenia z błędnym `secret`, która musi się nie udać.
   - Wstrzyknięcie niepoprawnych kresek i obrazów, które muszą zostać odrzucone.
   - Pomiar opóźnienia pióra: rysowanie ma być płynne przy dokumencie z co najmniej 10 000 kresek.

Po każdym etapie uruchom `npm test`.
