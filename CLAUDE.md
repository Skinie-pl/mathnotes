# MathNotes — założenia projektowe

Ten plik opisuje **filozofię** projektu — dlaczego rzeczy wyglądają i działają tak, a nie inaczej — żeby kolejne zmiany były z nią spójne, a nie tylko "działały". Fakty operacyjne (jak zbudować, jak wydać wersję, skróty klawiszowe) są w [README.md](README.md); tu jest kontekst decyzji.

## Czym to jest

Offline notatnik matematyczny na tablet graficzny (Electron, Windows/macOS). Jedna osoba notuje odręcznie; opcjonalnie do 10 osób może rysować razem w czasie rzeczywistym, bez żadnego własnego serwera (Yjs + y-webrtc).

## Założenia wyglądowe

- **Ciemny motyw, zero chrome'u.** Canvas jest czarny, toolbar wąski i po lewej stronie, bez pasków narzędzi u góry — nic nie ma odciągać uwagi od pisania. Jeśli dodajesz UI, pytanie brzmi "czy to musi być zawsze widoczne", a nie "gdzie to zmieścić".
- **Kartka, nie płótno.** Notatnik ma stałą szerokość (`PAGE_WIDTH`) i przewija się tylko w pionie, w nieskończoność w dół — jak prawdziwy zeszyt, nie jak nieograniczona tablica. To świadome ograniczenie: nie dodawaj przewijania w poziomie ani "trybu tablicy".
- **Narzędzia z przytrzymaniem, nie z submenu.** Krótkie kliknięcie = akcja domyślna (pióro, gumka); przytrzymanie = flyout z wariantami (typ pędzla, tryb kasowania). To wzorzec do powielania przy nowych narzędziach, nie dodawania kolejnych przycisków obok.
- **Kursor pokazuje realny obszar działania.** Kursor gumki to okrąg dokładnie w rozmiarze promienia kasowania (`eraserScreenRadius`) — nigdy generyczny crosshair dla akcji, która ma promień. Jeśli dodajesz narzędzie z zasięgiem, pokaż ten zasięg.
- **Status w tytule okna, nie w osobnym pasku.** Nazwa pliku, kropka przy niezapisanych zmianach, flash wiadomości (`flashTitle`) — świadomie zamiast dedykowanego status bara zjadającego pion ekranu na tablecie.
- **Natywne menu systemowe** (Plik/Edycja/Widok/Online/Okno/Pomoc) po polsku, nie custom UI — mniej kodu, znajome skróty, integracja z systemem (ostatnie pliki, Cmd+Q).

## Założenia działania

- **Offline-first, zawsze.** Zero wymaganego backendu do zwykłej pracy. Jedyny moment kontaktu z siecią to opcjonalny tryb online (i tylko do nawiązania połączenia, patrz niżej).
- **Bezpieczeństwo danych użytkownika jest ważniejsze niż uproszczenie kodu.** Zapis jest atomowy (`.tmp` + `rename`) z kopią `.bak`; zamknięcie okna z niezapisanym nienazwanym notatnikiem pyta, zanim coś usunie. Nie upraszczaj tego z powrotem do `writeFileSync` wprost na docelowy plik.
- **Dokument to CRDT (Yjs), undo to `Y.UndoManager`** z `trackedOrigins` = lokalny origin. Wcześniej undo robiło pełne migawki stanu, ale w sesji online migawka cofałaby też zmiany innych osób. UndoManager cofa tylko twoje. Nie wracaj do migawek ani nie pisz własnego logu operacji.
- **Responsywność pióra jest najważniejsza.** Wszystko jest local-first: najpierw rysujesz na ekranie, a synchronizacja nigdy nie blokuje rysowania. Pointer Events z `getCoalescedEvents()`, canvas z `desynchronized: true`, cache gotowych kresek w kafelkach w pionie, zapisy do Yjs grupowane w jedną transakcję na klatkę.
- **Renderowanie ma dwie ścieżki i to jest celowe**: `drawLatestSegment` (inkrementalne, tylko podczas aktywnego rysowania) i `drawStroke` (kanoniczne, pełne przerysowanie przy finalizacji/zoomie/undo). Obie muszą liczyć dokładnie tę samą szerokość w danym punkcie (`widthFactor`), inaczej linia "skacze" w momencie puszczenia pióra.
- **Logika bez DOM żyje w `renderer/core.js`**, nie w `renderer.js`. Gumka, bbox, format pliku, wygładzanie punktów — jeśli to się da przetestować bez canvasa, tam to ma być, z testem w `test/`. `renderer.js` to tylko okablowanie DOM/canvas wokół tej logiki.
- **Format pliku ma numer wersji** (`FILE_FORMAT_VERSION` w `core.js`). Każda zmiana kształtu zapisywanego stanu = bump wersji + krok migracji w `normalizeState`. Nigdy nie zmieniaj kształtu danych bez tego.

## Backend: bezpieczny, ale bez serwera

To jest najbardziej nietypowa część projektu, więc jaśniej o zasadach.

**Model zagrożeń.** Appka nigdy nie uruchamia własnego serwera, nie otwiera nasłuchującego portu i nie ma backendu, który mógłby zostać zaatakowany, z którego mogłyby wyciec dane albo który trzeba by utrzymywać. Jedyna ekspozycja na sieć to:
1. Renderer Electrona ładuje wyłącznie lokalne pliki (`file://`) z CSP bez `unsafe-eval`. Nawigacja i nowe okna są zablokowane, nie ma zdalnego contentu.
2. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Renderer ma dostęp do Node tylko przez wąski mostek `window.api` w `preload.js`. **Każda nowa funkcja IPC musi przejść przez jawnie nazwaną metodę z walidacją argumentów.** Nigdy nie eksponuj `ipcRenderer` ani `require` wprost.
3. Tryb online to **Yjs + y-webrtc**. Treść płynie wyłącznie peer-to-peer (WebRTC, szyfrowanie DTLS). Serwer sygnalizacyjny służy tylko do znalezienia się nawzajem, jak DNS.

**Kod zaproszenia `mn1-<roomId>-<secret>`** składa się z dwóch 128-bitowych wartości z `crypto.getRandomValues`.
- `roomId` jest widoczny dla serwera sygnalizacyjnego.
- `secret` trafia wyłącznie do opcji `password` providera y-webrtc, który szyfruje nim (AES-GCM) całą sygnalizację, łącznie z odciskami certyfikatów DTLS.
- Dzięki temu serwer sygnalizacyjny ani nie odczyta sesji, ani nie przeprowadzi ataku man-in-the-middle. To jest powód wyboru y-webrtc zamiast PeerJS, gdzie odciski przechodziły przez broker jawnie.
- Do pokoju wejdzie tylko ktoś, kto zna pełny kod. Nie ma listy pokoi do przeskanowania.

**Dlaczego to jest bezpieczne mimo braku serwera:**
- Proces nie akceptuje połączeń, dopóki użytkownik świadomie nie kliknie „Rozpocznij sesję online”.
- `maxConns: 9`, czyli maksymalnie 10 osób w sesji.
- Brak trwałego serwera oznacza brak trwałych danych do wykradzenia. Sesja znika bez śladu, gdy się kończy.
- Adresy serwerów sygnalizacyjnych i opcjonalnego TURN są konfigurowalne w ustawieniach, a publiczne serwery to tylko ustawienie domyślne.

**Świadomy kompromis, nie luka:** w obrębie sesji każdy, kto zna kod, może edytować i usuwać wszystko. CRDT gwarantuje, że równoczesne zmiany się nie gubią, a undo cofa tylko własne zmiany. Zmiany z sesji trafiają na dysk wyłącznie przez „Zapisz”. Jeśli kiedyś sesje mają obsługiwać nieznajomych, potrzebny jest inny model (role, podpisy). Nie łataj tego punktowo.

**Zasady przy zmianach w module online (`renderer/online.js`, `renderer/doc.js`):**
- Nie dodawaj niczego, co wymagałoby własnego serwera (kont, trwałej historii, listy pokoi). To zaprzeczyłoby premisie projektu i wymaga osobnej dyskusji o architekturze.
- Treść w Y.Doc pochodząca od innych osób to niezaufany input. Każda kreska i każdy obraz przechodzą przez walidatory w `core.js` przed renderowaniem: typy, zakresy, limity liczby punktów i kresek, `dataUrl` tylko jako `data:image/(png|jpeg|webp)` do 5 MB, kolor według regexa. Niepoprawne dane są pomijane (fail closed).
- Wartości od innych osób nigdy nie trafiają do ścieżek plików, IPC, `innerHTML`, `eval` ani `new Function`. Tekst z awareness wstawiaj tylko przez `textContent`.
- `secret` z kodu zaproszenia nie może trafić nigdzie poza opcję `password`: ani do pliku, ani do logów, ani do awareness.

## Czego nie robić

- Nie dodawaj build stepu (bundler, TypeScript, transpiler) do `npm start`. Projekt celowo działa jako zwykłe pliki `.js` ładowane przez `<script>`, żeby `npm start` działało od razu po `npm install`. Jedynym wyjątkiem jest `npm run vendor`: jednorazowe sklejenie Yjs i y-webrtc esbuildem do commitowanego `renderer/vendor/collab.bundle.js`.
- Nie dodawaj nowych zależności produkcyjnych bez zvendorowania ich do `renderer/vendor/` (patrz README, sekcja Architektura) — appka ma zostać samowystarczalna po spakowaniu.
- Nie zmieniaj kształtu zapisywanego JSON-a bez bumpa `FILE_FORMAT_VERSION`.
- Nie zastępuj atomowego zapisu (`notebook-file.js`) bezpośrednim `writeFileSync` na docelowy plik.
- Nie zapisuj binarnego stanu Yjs do pliku. Plik to wersjonowany JSON (`FILE_FORMAT_VERSION = 2`), a Y.Doc budujesz z niego przy otwarciu.
