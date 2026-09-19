# MathNotes — pełny obraz projektu

Ten plik jest dla kolejnej sesji Claude Code (albo dla Ciebie za miesiąc), żeby
nie trzeba było odtwarzać kontekstu z historii commitów. Odpowiada na pytanie
„co tu się dzieje i dlaczego", a nie „jak to zbudować" (to jest w
[README.md](README.md)) ani „jakie są zasady projektowe" (to jest w
[CLAUDE.md](CLAUDE.md) — **przeczytaj go pierwszy, przed tym plikiem**).

Stan na: **2026-09-19, wersja 1.4.0** (ostatni commit `158c99d`).

## Co to jest, w jednym akapicie

Offline notatnik matematyczny na tablet graficzny (Electron, macOS/Windows).
Jedna osoba pisze odręcznie piórem; opcjonalnie do 10 osób może pisać razem
w czasie rzeczywistym przez peer-to-peer (Yjs + y-webrtc), bez żadnego własnego
serwera. Da się też wczytać PDF jako tło i pisać po nim, oraz eksportować
notatki z powrotem do PDF-a.

## Jak tu trafiliśmy

1. **Etapy 1–7** (commity `f080d9f`…`ea1281e`) — budowa od zera: szkielet
   Electrona, atomowy zapis, format pliku z walidacją, bundle Yjs/y-webrtc,
   model dokumentu z `Y.UndoManager`, renderer z kaflami, tryb online.
2. **Port MathNotes 1.0** (`1f3f925`, `ce3fe2f`) — dostał referencyjną paczkę
   starszej wersji tego samego programu (zbudowaną na PeerJS) i poproszono
   o skopiowanie wyglądu/funkcji przy zachowaniu nowej architektury (Yjs
   zamiast PeerJS, bo Yjs szyfruje sygnalizację end-to-end — zobacz sekcję
   „Backend" w CLAUDE.md). Stąd: nick+kolor, zaznaczanie kursorem, lista
   adnotacji, limit oddalenia, tryb biały, kratka w tle.
3. **Ikony i paczki** (`bca104d`) — pierwsza dystrybucja na macOS/Windows.
4. **Dwie regresje pakowania z rzędu** (`8e7400c`, `5cb21b0`) — `files` w
   `package.json` enumerowało `renderer/**/*`, ale nie root `renderer.js`.
   Paczka startowała i wyglądała normalnie, ale nic nie robiła. Stąd
   `verifyPackage()` w `arrange-dist.js` i `smoke-package.js` (patrz niżej).
5. **Sync przez WebRTC był zepsuty powyżej ~256 kB** (`4294bee`) —
   `simple-peer.send()` nie dzieli wiadomości, a kanał danych WebRTC ma limit
   pojedynczej wiadomości. Wklejony obraz zabijał kanał **na stałe**, w obie
   strony. Naprawione przez `scripts/webrtc-frames.js` — własna warstwa
   fragmentacji wpięta w `simple-peer` wewnątrz zvendorowanego bundle'a.
6. **1.3.0** — poszerzenie pola roboczego, PDF jako tło (pierwsza wersja),
   lista osób, próba naprawy klatkowania kursora. **Ta runda wprowadziła
   regresję**, którą złapano dopiero w rundzie następnej (punkt 8).
7. **1.3.1** — poprawka płynności kursora drugiej osoby (interpolacja).
8. **1.4.0** — dwie poważne naprawy własnych regresji plus dużo funkcji:
   - Lista osób z 1.3.0 miała `id="people-overlay"`, kończące się na
     `-overlay`, a `anyModalOpen()` szukał właśnie po tym wzorcu. Efekt:
     **wszystkie skróty jednoklawiszowe przestały działać**, bo aplikacja
     myślała, że zawsze jest otwarty jakiś panel. Naprawione przez
     wykrywanie po klasie `.modal`, nie po id.
   - Paczka macOS miała **zepsuty podpis kodu** (`Identifier=Electron`,
     `Info.plist=not bound`) — po pobraniu macOS 26/27 pokazywał „aplikacja
     jest uszkodzona" i nawet prawy klik → Otwórz nie pomagał. Test paczki
     tego nie łapał, bo uruchamiał plik wykonywalny wewnątrz bundle'a
     bezpośrednio, omijając Gatekeepera i LaunchServices całkowicie.
     Naprawione: `scripts/after-pack.js` podpisuje ad-hoc, `arrange-dist.js`
     weryfikuje podpis i przerywa build, gdy jest zły, `smoke-package.js`
     uruchamia teraz przez `open -n`, czyli tę samą drogę co podwójny klik.
   - Plus: prostowanie kreski przytrzymaniem, płynny zoom (krok kółka był
     ~3× na klik, teraz ~1,27×), eksport PDF w oryginalnym rozmiarze strony
     bez marginesów, Windows jako pojedynczy plik `.exe` (`target: portable`
     zamiast `dir`), ramka wokół stron PDF-a, dopasowanie motywu do jasnego
     PDF-a, optymalizacja kafli (dopisanie kreski nie unieważnia już całego
     kafla).

**Wniosek z punktów 4 i 8, warty pamiętania przy każdej kolejnej zmianie
testów/skryptów budowania:** dwa razy z rzędu test „paczka działa" przechodził,
mimo że paczka realnie nie działała dla użytkownika — raz przez brakujący
plik, raz przez zepsuty podpis. Powód za każdym razem ten sam: test omijał
ścieżkę, którą naprawdę przechodzi użytkownik (odpowiednio: cichy błąd
ładowania skryptu; Gatekeeper). Przy dodawaniu nowego smoke-testu pytanie
brzmi „czy to jest dokładnie to, co zrobi użytkownik", nie „czy proces wstał".

## Architektura — mapa plików

```
main.js              Główny proces: okno, menu, IPC, dialogi, lista ostatnich plików
preload.js           Jedyny most renderer↔Node (window.api), jawnie nazwane metody
notebook-file.js      Atomowy zapis: .tmp + fsync → .bak → rename
index.html            Struktura DOM, bez logiki
renderer.js           ~3550 linii. WYŁĄCZNIE okablowanie DOM/canvas. Wszystko,
                       co dzieje się na ekranie: narzędzia, gesty, render loop,
                       kafle, online UI, import/eksport PDF.
renderer/
  core.js              ~1090 linii. Logika bez DOM: format pliku (wersja 6),
                       walidatory (fail-closed), geometria (gumka, bbox,
                       transformacje), FILE_FORMAT_VERSION + MIGRATIONS,
                       stałe świata (PAGE_WIDTH itd.), straightenStroke,
                       layoutPdfPages. Testowane w test/core.test.js.
  doc.js               ~466 linii. Model dokumentu na Yjs: NotebookDoc,
                       Y.UndoManager z trackedOrigins, jedyne miejsce, które
                       mutuje Y.Doc (addStroke/appendPoints/setPoints/
                       eraseAt/transformSelection/addImage/...).
  online.js            ~424 linii. Provider y-webrtc, kod zaproszenia
                       (mn1-<roomId>-<secret>), awareness (nick/kolor/kursor),
                       walidacja peer state. Bez DOM.
  vendor/               Zvendorowane biblioteki (patrz niżej), commitowane.
  style.css             Cały wygląd, zmienne CSS dla dark/light.
scripts/
  vendor.js             npm run vendor — sklejenie Yjs+y-webrtc+lib0+simple-peer
                       w collab.bundle.js, kopiowanie jsPDF, budowa pdf.bundle.js
                       z pdfjs-dist. Sprawdza CSP (brak eval/new Function).
  webrtc-frames.js       Fragmentacja wiadomości WebRTC (patrz punkt 5 wyżej).
                       CommonJS, używane i przez bundle, i przez test.
  collab-entry.js        Wejście bundle'a Yjs/y-webrtc/simple-peer.
  pdf-entry.js            Wejście bundle'a pdf.js (patrz sekcja PDF niżej).
  node-shims.js           Minimalne podpórki node'owych globali dla y-webrtc.
  after-pack.js           Hook electron-buildera: podpisuje bundle macOS ad-hoc.
  arrange-dist.js         npm run dist — porządkuje wynik electron-buildera,
                       weryfikuje kompletność paczki i podpis macOS, zipuje.
  smoke-package.js       Uruchamia SPAKOWANĄ aplikację (przez open -n na macOS),
                       łączy się po CDP, sprawdza wpięcie modułów i rysowanie.
  make-icon.js            Generuje ikonę z SVG.
test/                   node --test, 128 testów, zero zależności testowych
```

## Stos technologiczny i dlaczego

- **Electron 44**, `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. Zero build stepu w `npm start` — zwykłe pliki `.js` ładowane
  przez `<script>`. Jedyny wyjątek: `npm run vendor` (patrz niżej).
- **Yjs 13 + y-webrtc 10** zamiast PeerJS (z jakiego korzystała referencyjna
  wersja 1.0): y-webrtc szyfruje **całą sygnalizację** (SDP, odciski DTLS)
  kluczem z kodu zaproszenia, PeerJS przepuszczała to jawnie przez brokera.
- **`Y.UndoManager`**, nie migawki stanu — w sesji online migawka cofnęłaby
  też cudze zmiany.
- **pdf.js 5.7** (`pdfjs-dist`) do wczytywania PDF-ów, zvendorowany jak
  reszta. **Ładowany dynamicznie**, dopiero przy pierwszym imporcie (1,5 MB),
  nie na starcie. Renderuje na wątku głównym, bo **Chromium pod `file://` nie
  pozwala tworzyć workerów** (sprawdzone empirycznie: ani z pliku, ani
  z `blob:`, ani jako moduł) — stąd oddawanie sterowania między stronami przy
  imporcie i postęp w tytule okna zamiast paska postępu.
- **jsPDF 4.2** do eksportu.
- Wszystko powyższe **zvendorowane do `renderer/vendor/`** i commitowane —
  aplikacja ma być samowystarczalna po spakowaniu, bez `npm install` na
  maszynie użytkownika.

## Model danych i format pliku

`FILE_FORMAT_VERSION = 6` w `renderer/core.js`. Łańcuch migracji
`MIGRATIONS = {1→2, 2→3, 3→4, 4→5, 5→6}` w `normalizeState()` — każda zmiana
kształtu zapisywanego stanu wymaga nowego kroku tutaj, nigdy nadpisania
poprzedniego. Elementy, które nie przechodzą walidacji, są **pomijane**, nie
naprawiane (fail-closed — patrz sekcja bezpieczeństwa w CLAUDE.md).

```
strokes:     { id, tool, brush, color, size, pressureEnabled, pts: [x,y,p,...] }
images:      { id, x, y, w, h, dataUrl, locked, srcW?, srcH? }
             locked=true → strona wczytanego PDF-a (nie da się zaznaczyć,
             przesunąć, skasować gumką). srcW/srcH = oryginalny rozmiar
             w punktach, tylko dla stron PDF-a (wersja 6+), używane przy
             eksporcie do oddania dokumentu w oryginalnym formacie.
annotations: { id, y, label }
meta:        { title, grid: { enabled, color, opacity } }
```

Świat: `PAGE_WIDTH = 2400` (pole robocze), `PDF_PAGE_WIDTH = 1600` (strona PDF-a,
wyśrodkowana, z marginesami ~400 po bokach na notatki), `PAGE_PAN_MARGIN = 0`
(zasada: wszystko, co widać, da się zapisać — nie ma martwej strefy obok
kartki). Pion rośnie sam wraz z treścią (`PAGE_GROW_AHEAD`), nie jest
nieskończony od startu.

## Co NIE jest oczywiste z samego kodu

- **`anyModalOpen()` i klasa `.modal`.** Jeśli dodajesz nową nakładkę z id
  kończącym się na coś podobnego do istniejących wzorców, **nadaj jej klasę
  `.modal` tylko jeśli faktycznie ma blokować skróty klawiszowe**. Nakładki
  czysto informacyjne (jak `#people-overlay`, `#page-indicator`) nie powinny
  jej mieć — regresja z 1.3.0 była dokładnie odwrotnym pomyłką.
- **Kafle (`tiles`) pamiętają skalę, w której powstały** (`tile.scale`).
  Rysowanie kafla w innym powiększeniu niż jego `scale` jest poprawne
  (przeskalowanie), tylko mniej ostre. Odświeżanie ostrości jest odroczone
  (`scheduleResharpen`, `TILE_RESHARPEN_MS`) — nie wywołuj `tiles.clear()`
  przy każdej drobnej zmianie widoku, to jest dokładnie to, co powodowało
  szarpanie przy zoomie w 1.3.1.
- **`paintStrokeIntoTiles` vs `invalidateTiles`.** Dopisanie/dokończenie
  kreski dorysowuje ją do istniejącego kafla (tanio). Kasowanie, cofanie
  i przesuwanie nadal unieważniają kafel (trzeba zdjąć piksele, nie da się
  tego zrobić przez samo dorysowanie).
- **`handleDocChange` musi ustawiać `needsRender` warunkowo**, nie wołać
  `scheduleRender()` bezwarunkowo. Własna aktywna kreska jest już na ekranie
  przez `paintLive` — pełny render przy każdym punkcie to była przyczyna
  migotania kreski w 1.2.0.
- **Test paczki uruchamia macOS przez `open -n`**, nie przez plik wykonywalny
  w środku bundle'a — patrz punkt 8 w historii. Nie cofaj tego „dla
  uproszczenia", to jest jedyna rzecz, która łapie zepsuty podpis.
- **Dwa procesy, nie dwa okna, do testowania trybu online.** y-webrtc
  synchronizuje okna w jednym procesie Electrona przez `BroadcastChannel`
  i nigdy nie dotyka WebRTC — taki test niczego nie dowodzi o realnej sieci.
  Harness do tego: `--user-data-dir` osobno dla każdego procesu, CDP na dwóch
  portach. (Nie ma go w repo — był w scratchpadzie sesji; do odtworzenia razie
  potrzeby, wzorzec jest prosty: dwa `spawn(electron, [...])` z różnymi
  `--remote-debugging-port` i `--user-data-dir`.)
- **`window.__qa`** w `renderer.js` (koniec pliku) to hak testowy — wjeżdża
  też do paczek produkcyjnych. Nie otwiera niczego na zewnątrz i nie omija
  CSP, ale jest kodem debugowym w wydaniu. Świadomie zostawiony, bo ułatwia
  dalsze testowanie w dwóch procesach; usunąć, jeśli kiedyś przeszkodzi.
- **Domyślne serwery sygnalizacyjne są teraz trzy**, nie jeden — jedyny
  domyślny (`y-webrtc-eu.fly.dev`) padł po stronie dostawcy i tryb online nie
  działał **nikomu**, kto nie wpisał własnego adresu, a objaw wyglądał jak
  błąd aplikacji (kod się generował, druga osoba nigdy nie dołączała). Jeśli
  znowu ktoś zgłosi „nie mogę dołączyć do sesji mimo dobrego kodu" — to jest
  pierwsza rzecz do sprawdzenia, nie ostatnia.
- **Windows to `target: portable`**, nie `dir`. Zmiana z 1.3.0 → 1.4.0 (user
  chciał jednego pliku `.exe`, nie folderu). `arrange-dist.js` ma osobną
  ścieżkę dla Windowsa (plik, nie katalog do przemianowania).

## Dystrybucja

- Repo: **github.com/Skinie-pl/mathnotes** (publiczne).
- Wydania jako **GitHub Releases**, paczki jako assets (nie w historii gita —
  `dist/` jest w `.gitignore`).
- **Ważne dla użytkownika:** pobieranie repo przyciskiem „Code → Download ZIP"
  daje źródła, nie aplikację. Aplikacja jest w zakładce Releases.
- Aktualna wersja: **1.4.0**, tag `v1.4.0`. Trzy paczki: `mac-arm64.zip`,
  `mac-x64.zip`, `win-x64.exe` (pojedynczy plik).
- Proces wydania: `npm pkg set version=X.Y.Z` → `npm run dist` →
  `node scripts/smoke-package.js dist/.../MathNotes.app` → `git commit` →
  `git push` → `gh release create vX.Y.Z --notes-file ...` →
  `gh release upload vX.Y.Z dist/*.zip dist/*.exe` (pojedynczo z ponawianiem —
  duże pliki czasem dostają przejściowy `HTTP 500` z uploads.github.com).

## Znane otwarte wątki (nic pilnego, ale warto wiedzieć)

- Użytkownik rozważał postawienie własnego serwera TURN/sygnalizacyjnego za
  Tailscale zamiast publicznych — **odradzone**, bo peer-to-peer i tak łączy
  bezpośrednio, a serwer pośredniczący tylko dodałby opóźnienie. Sensowne
  tylko jako zapasowy TURN przy zawodnym łączeniu w restrykcyjnych sieciach.
- Eksport PDF-a przy notatniku zbudowanym na wczytanym PDF-ie **pomija
  notatki zrobione na marginesach obok strony** (świadoma decyzja — user
  chciał „sam PDF z rysunkami bezpośrednio na nim"). Jeśli to się kiedyś
  zmieni, trzeba przemyśleć, czy eksportować pełny obszar roboczy zamiast
  samej strony źródłowej.
- Brak testu automatycznego dla podpisu macOS poza samym buildem (weryfikacja
  jest w `arrange-dist.js`, ale nie ma jednostkowego testu tej logiki
  w `test/`). Skrypty w `scripts/` w ogóle nie mają testów — tylko efekt
  end-to-end przez `smoke-package.js`.
