# MathNotes

Offline notatnik matematyczny na tablet graficzny (Electron, Windows/macOS).
Jedna osoba notuje odręcznie; opcjonalnie do 10 osób może rysować razem w czasie
rzeczywistym, peer-to-peer, bez żadnego własnego serwera.

Filozofia projektu i uzasadnienie decyzji: [CLAUDE.md](CLAUDE.md).
Specyfikacja implementacyjna: [INSTRUKCJE_DLA_CLAUDE_CODE.md](INSTRUKCJE_DLA_CLAUDE_CODE.md).

## Uruchomienie

```bash
npm install
npm start
```

Testy:

```bash
npm test
```

> Jeśli `npm install` zgłosi zablokowane skrypty instalacyjne (npm ≥ 11), Electron
> nie pobierze swojej binarki. Dopuść je przez `npm approve-scripts` albo uruchom
> `node node_modules/electron/install.js`.

## Co potrafi

- **Pióro** z dwoma pędzlami: zwykłym i miękkim (poświata, narastanie na starcie
  kreski). Grubość 1–30 px, pięć kolorów w edytowalnej palecie, opcjonalna
  zmienna grubość wg nacisku pióra.
- **Prostowanie przytrzymaniem** — narysuj mniej więcej prostą kreskę i zatrzymaj
  pióro na końcu na 2 sekundy: kreska zamienia się w odcinek, a dalszy ruch
  dociąga jego koniec. Łuk narysowany celowo zostaje łukiem.
- **Gumka** w dwóch trybach: „Obiekty” kasuje całe kreski i obrazy, „Obszar”
  wycina fragment i dzieli kreskę na pozostałe kawałki.
- **Kursor** — zaznaczanie ramką dowolnego fragmentu rysunku (kresek i obrazów),
  przesuwanie i skalowanie całego zaznaczenia za uchwyty narożne, z zachowaniem
  proporcji. Kliknięcie zaznacza pojedynczy obiekt, `Delete` usuwa zaznaczenie,
  `Esc` je zdejmuje.
- **Obrazy ze schowka** (`Ctrl/Cmd+V`), zapisywane w ok. 2× rozmiaru
  wyświetlania, żeby duży zrzut ekranu nie rozdmuchał pliku.
- **Adnotacje** — poziome linie z etykietą. Klik na zakładce dodaje adnotację,
  **przytrzymanie otwiera ich listę** z przeskokiem i usuwaniem; widoczność linii
  przełącza się w menu Widok.
- **Kratka w tle** z własnym kolorem i przezroczystością, z rozstawem dobieranym
  do powiększenia.
- **Tryb biały** — biała kartka zamiast czarnej (menu Widok).
- **Wczytanie PDF-a jako tła** — upuść plik na okno albo Plik → „Wczytaj PDF
  jako tło…". Strony stają się kartkami notatnika, po których się pisze.
- **Eksport do PDF** ze stronicowaniem A4 (do 300 stron).
- **Konfigurowalne skróty klawiszowe** z panelem i przywracaniem domyślnych.
- **Autozapis** co 10 minut do już otwartego pliku oraz dopytanie o zapis przy
  zamykaniu okna z niezapisanymi zmianami.
- **Sesja online** do 10 osób, peer-to-peer, bez własnego serwera.

## Architektura

Bez bundlera i bez transpilacji w runtime — zwykłe pliki `.js` ładowane przez
`<script>`, więc `npm start` działa od razu po `npm install`.

| Plik | Rola |
| --- | --- |
| `main.js` | Okno, natywne menu po polsku, blokada nawigacji, handlery IPC, pliki. |
| `preload.js` | Jedyny most renderer↔Node (`window.api`, jawnie nazwane metody). |
| `notebook-file.js` | Atomowy zapis: `.tmp` + fsync → kopia do `.bak` → `rename`. |
| `renderer/core.js` | Logika bez DOM: format pliku, walidacja, geometria, szerokość kreski. Testowana w `test/`. |
| `renderer/doc.js` | Model dokumentu na Yjs, `Y.UndoManager`, jedyne miejsce mutujące Y.Doc. |
| `renderer/online.js` | Provider y-webrtc, kod zaproszenia, awareness, limity. Bez DOM. |
| `renderer.js` | Wyłącznie okablowanie DOM/canvas. |
| `renderer/style.css` | Wygląd. |
| `renderer/vendor/` | Zvendorowane biblioteki, budowane przez `npm run vendor`. |
| `scripts/webrtc-frames.js` | Dzielenie wiadomości na ramki dla kanału WebRTC; wchodzi do bundle'a. |
| `scripts/pdf-entry.js` | Zakres bundle'a pdf.js (biblioteka + jej worker na wątku głównym). |

### Zależności i `npm run vendor`

Yjs, y-webrtc, y-protocols i lib0 to moduły ESM z zależnościami, więc nie da się
ich wprost wpiąć przez `<script>`. Jedyny wyjątek od zasady „bez build stepu”:

```bash
npm run vendor
```

Skrypt robi trzy rzeczy: skleja esbuildem Yjs i y-webrtc w jeden
`renderer/vendor/collab.bundle.js` wystawiający
`window.Collab = { Y, WebrtcProvider, awarenessProtocol }`, oraz kopiuje gotowy
UMD jsPDF do `renderer/vendor/jspdf.umd.min.js`, oraz skleja pdf.js w
`renderer/vendor/pdf.bundle.js` (`window.PdfJs`). Wszystkie wyniki są commitowane, więc
aplikacja jest samowystarczalna po spakowaniu. Uruchamiaj go **tylko** przy
aktualizacji tych bibliotek, nigdy w `npm start`. Wersje są przypięte dokładnie
(bez `^`) i trzymane w `devDependencies`, bo do runtime'u trafia wyłącznie
zvendorowany wynik.

Zakres bundle'a decyduje `scripts/collab-entry.js`. `scripts/node-shims.js`
dokłada minimalne podpórki pod node'owe globale, których szukają zależności
y-webrtc (`simple-peer` → `readable-stream`, `debug`). Świadomie nie ma tam
pełnego polyfilla node'a: gdy któraś biblioteka zacznie potrzebować czegoś
więcej, lepiej zobaczyć błąd builda niż dostać po cichu atrapę zwracającą bzdury.

Sam skrypt pilnuje trzech rzeczy i przerywa build, gdy któraś nie gra:

1. Zainstalowane wersje odpowiadają przypiętym w `package.json`.
2. Wynik nie zawiera `eval(` ani `new Function(` — CSP renderera to
   `script-src 'self'` bez `unsafe-eval`, więc inaczej wywaliłoby się dopiero
   w runtime. Ten sam warunek sprawdza test, żeby ręcznie dłubany bundle też nie
   przeszedł.
3. Wynik faktycznie wystawia `globalThis.Collab`.

Bundle Collab nie jest minifikowany: to commitowany kod obcego pochodzenia,
który ma dać się przejrzeć i zdiffować przy aktualizacji. jsPDF kopiujemy
w postaci opublikowanej przez autora.

## Budowanie paczek

```bash
npm run dist        # macOS (arm64 + x64) i Windows (x64)
npm run dist:mac
npm run dist:win
npm run icon        # przerysowanie ikony po zmianie scripts/icon.html
```

Wynik trafia do `dist/` — dla każdej platformy folder gotowy do skopiowania
oraz jego `.zip`:

| Folder | Dla kogo |
| --- | --- |
| `MathNotes-<wersja>-mac-arm64` | macOS na Apple Silicon (M1 i nowsze) |
| `MathNotes-<wersja>-mac-x64` | macOS na Intelu |
| `MathNotes-<wersja>-win-x64.exe` | Windows 64-bit, jeden przenośny plik — nic nie instaluje. Przy pierwszym uruchomieniu rozpakowuje się do katalogu tymczasowego (stała nazwa `unpackDirName`, więc kolejne starty są już szybkie). |

W każdym folderze leży `CZYTAJ TO.txt` z instrukcją uruchomienia. Paczki
Windows buduje się z macOS bez wine — cel `dir` nie potrzebuje NSIS-a.

Lista `files` w sekcji `build` działa **przez odejmowanie**: bierze wszystko
i wyrzuca testy, skrypty buildów, dokumentację i katalog `dist`. Wcześniej
wyliczała pliki do wzięcia — i `renderer.js` z korzenia wypadł z paczki, bo
wpis obejmował tylko katalog `renderer/`. Aplikacja uruchamiała się wtedy
normalnie, wyglądała normalnie i **nie reagowała na nic**, bo cała warstwa
okablowania nie istniała. Przy odejmowaniu najgorsze, co się stanie, to
odrobinę większa paczka.

Dodatkowo `scripts/arrange-dist.js` przerywa build, jeśli w `app.asar` brakuje
choćby jednego pliku, do którego odwołuje się `index.html`.

### Podpis paczki macOS

`scripts/after-pack.js` podpisuje bundle podpisem ad-hoc (`codesign --force
--deep --sign -`), a `arrange-dist.js` sprawdza wynik i przerywa build, gdy
podpis jest niepoprawny albo gdy zostało tylko `Identifier=Electron`.

Bez tego electron-builder zostawia bundle z samym podpisem linkera:
`Info.plist=not bound`, a Gatekeeper mówi „code has no resources but signature
indicates they must be present”. Na macOS 26/27 taka aplikacja **po pobraniu
z internetu nie uruchamia się w ogóle** — system twierdzi, że jest uszkodzona,
i prawy klik → Otwórz tego nie obchodzi, bo to nie jest pytanie o nieznanego
dewelopera, tylko odrzucenie zepsutego podpisu.

Pułapka metodologiczna, przez którą to przeszło niezauważone: testy paczki
uruchamiały `Contents/MacOS/MathNotes` bezpośrednio, co omija LaunchServices
i Gatekeepera. Uruchomienie pliku wykonywalnego **nie dowodzi**, że aplikacja
da się otworzyć podwójnym kliknięciem.

### Sprawdzanie paczki

```bash
npm run smoke -- dist/MathNotes-1.1.0-mac-arm64/MathNotes.app
npm run smoke -- .        # wersja ze źródeł, ta sama co `npm start`
```

Uruchomienie procesu nie dowodzi niczego: paczka bez jednego skryptu wstaje bez
błędu i wygląda poprawnie. `scripts/smoke-package.js` podłącza się do aplikacji
protokołem DevTools, sprawdza, że renderer się wykonał i wpiął wszystkie moduły,
po czym **rysuje kreskę** i sprawdza, że dokument faktycznie się zmienił.

**Paczki nie są podpisane.** Bez certyfikatu Apple Developer ID macOS pokaże
ostrzeżenie przy pierwszym uruchomieniu (prawy klik → Otwórz), a Windows
SmartScreen poprosi o potwierdzenie. To jest kwestia kupienia certyfikatów,
nie kodu.

### Ikona

`build/icon.png` (1024×1024) jest **rysowany kodem** — `scripts/icon.html`
rysuje go na canvasie, a `scripts/make-icon.js` renderuje offscreen w Electronie
i zapisuje PNG. Dzięki temu nie ma w repo zależności graficznej ani binarnego
pliku, którego nie da się zdiffować. `.icns` i `.ico` generuje z tego
electron-builder.

## Format pliku

Plik notatnika to JSON z polem `version`, **spakowany gzipem**. Nazwa nadal
kończy się na `.json`, a odczyt jest przezroczysty: nieskompresowane pliki
ze starszych wersji otwierają się bez żadnej konwersji. Notatnik to w większości
tablice liczb i base64 obrazów, więc kompresja zbija rozmiar kilkukrotnie.
Binarnego stanu Yjs nie zapisujemy — format ma być niezależny od biblioteki.

```jsonc
{
  "version": 6,
  "meta": { "title": "", "grid": { "enabled": false, "color": "#4c8dff", "opacity": 0.18 } },
  "strokes": [{
    "id": "a1",
    "tool": "pen",
    "brush": "pen",            // pen | soft
    "color": "#ffffff",
    "size": 4,                 // 1..30
    "pressureEnabled": false,
    "pts": [10, 20, 0.5]       // płasko [x, y, nacisk, ...], 0,1 px i 0,01 nacisku
  }],
  // locked = strona wczytanego PDF-a: nie da się jej zaznaczyć, przesunąć ani skasować
  // srcW/srcH = oryginalny rozmiar strony w punktach, tylko dla stron PDF-a
  "images": [{ "id": "i1", "x": 0, "y": 0, "w": 100, "h": 50, "locked": false, "dataUrl": "data:image/…" }],
  "annotations": [{ "id": "n1", "y": 420, "label": "Rozdział 1" }]
}
```

Migracje trzymane są w `MIGRATIONS` w `core.js` i wykonują się po kolei, więc
bump wersji to dopisanie jednego kroku:

- **1 → 2**: kształt zapisywany przez MathNotes 1.0. Punkty były obiektami
  `{x, y, p}`, grubość nazywała się `width`, obrazy miały `width`/`height`,
  a pliki w ogóle nie miały pola `version`.
- **2 → 3**: dochodzą adnotacje, znika tło strony z `meta`.
- **3 → 4**: do `meta` wchodzą ustawienia kratki.

Plik z wersją nowszą niż `FILE_FORMAT_VERSION` jest odrzucany z czytelnym
błędem, a nie otwierany z utratą danych. `normalizeState` zwraca
`{ state, skipped }`; elementy, które nie przejdą walidacji, są pomijane
(fail closed), a `skipped` mówi ile, żeby dało się o tym powiedzieć
użytkownikowi.

Obok pliku żyją dwie ścieżki pomocnicze:

- `<plik>.tmp` — istnieje tylko w trakcie zapisu; po nieudanym zapisie jest
  sprzątany, więc jego obecność oznacza ubity proces.
- `<plik>.bak` — dokładnie jedna wersja wstecz, nie historia.

Nowe notatniki lądują domyślnie w `Dokumenty/MathNotes`.

## Dokument i cofanie

Dokument to CRDT (Yjs). `renderer/doc.js` jest jedynym miejscem, które mutuje
Y.Doc; konwersja JSON↔Y.Doc siedzi w `core.js` i dostaje `Y` argumentem, żeby
core pozostał modułem bez zależności.

```
doc.getArray('strokes')      → Y.Map { id, tool, brush, color, size, pressureEnabled, pts: Y.Array }
doc.getArray('images')       → Y.Map { id, x, y, w, h, dataUrl }
doc.getArray('annotations')  → Y.Map { id, y, label }
doc.getMap('meta')           → { title }
```

**Cofanie robi `Y.UndoManager`, nie migawki stanu.** `trackedOrigins` to
wyłącznie lokalny origin instancji, więc undo zdejmuje tylko twoje zmiany —
migawka cofnęłaby w sesji online także to, co narysował ktoś inny. Granice
kroków domykamy jawnie przez `stopCapturing()` przy puszczeniu pióra, więc jedno
pociągnięcie to dokładnie jedno undo, także gdy ktoś rysuje bardzo wolno.

Wczytanie pliku leci osobnym originem i czyści historię: otwarcie notatnika nie
jest zmianą, którą da się cofnąć w pustkę.

Kropka niezapisanych zmian zapala się **także od zmian cudzych**. W sesji online
plik na twoim dysku rozjeżdża się z dokumentem również wtedy, gdy rysuje ktoś
inny, a to twój egzemplarz zostanie zapisany.

## Rysowanie

Pole robocze ma stałą szerokość `PAGE_WIDTH` (2400) i przewija się w dół.

**100 % to szerokość pola roboczego dopasowana do okna i zarazem maksymalne
oddalenie.** Przybliżyć można do 800 %. Krok kółka to `ZOOM_WHEEL_RATE`: przy
0,01 jedno kliknięcie dawało mnożnik około 3×, czyli skok ze 100 % na 800 %
w trzy ruchy i brak możliwości ustawienia czegokolwiek pomiędzy. Przy 0,002
kliknięcie to ~1,27 %, a drobne zdarzenia z gładzika dają płynne ~1,02×.
Krótkie kliknięcie we wskaźnik procentów otwiera suwak, przytrzymanie wraca
do 100 %. Zasada jest taka: *wszystko, co widać, da
się zapisać*. Dlatego `PAGE_PAN_MARGIN` wynosi zero i nie ma żadnego pasa obok
kartki — wcześniej taki pas był, a pióro przyciśnięte na nim dostawało punkt
dociśnięty do krawędzi, więc kreska powstawała gdzie indziej niż pióro. Wyglądało
to jak teleportacja i było zgłaszane właśnie tak.

Z tej samej zasady `beginStroke` **odmawia** rozpoczęcia kreski poza polem
roboczym (`core.pointInPage`), zamiast dociskać punkt. W trakcie już rozpoczętej
kreski punkty nadal są dociskane do krawędzi — tam to jest poprawne, bo linia ma
się zatrzymać na brzegu, a nie przeskoczyć.

### Jak daleko w dół

Kartka **nie jest nieskończona od pierwszej chwili**. Zasięg przewijania to dół
treści plus `PAGE_GROW_AHEAD`, czyli kartka wyprzedza notatki o kawałek i wydłuża
się sama, w miarę jak schodzisz niżej. Pusty notatnik pozwala zejść o jeden
„ekran w zapasie”, a nie o dwa miliony jednostek świata.

Dół treści (`documentBottom`) jest cache'owany i unieważniany przy zmianie
dokumentu: `clampViewY` wołane jest przy każdym obrocie kółka, a przeglądanie
wszystkich kresek za każdym razem byłoby widać przy dużej notatce.

### Kratka w tle

Rozstaw dobiera się do powiększenia (`gridStep` w `core.js`): krok jest tak
dobrany, żeby oczko miało na ekranie co najmniej `GRID_MIN_SCREEN` pikseli, ale
mniej niż pięciokrotność tej wartości. Przy przybliżaniu w istniejące oczka
wchodzą kolejne podziałki, przy oddalaniu najdrobniejsze znikają — tak jak
w programach do rysowania. Linie grube rysowane są na drobnych, więc nakładając
się wychodzą wyraźniejsze.

Kolor i przezroczystość kratki są ustawieniem **strony**, nie aplikacji: siedzą
w `meta.grid` i wędrują razem z plikiem oraz z sesją online.

### Tryb biały

Motyw zmienia tło kartki i skórę interfejsu. Atrament przechodzi przez
`themeInk`: skrajne szarości są odwracane (biała kreska na białej kartce byłaby
niewidoczna), a nasycone kolory zostają bez zmian, bo czytają się na obu tłach.
Zmieniamy tylko sposób rysowania — kolory zapisane w pliku zostają nietknięte.

Kursor pióra to okrąg dokładnie tak gruby, jak kreska, która powstanie —
a że grubość jest w jednostkach świata, zależy też od powiększenia i przerysowuje
się razem z nim. Stała kropka kłamała: przy grubości 30 i przybliżeniu 400 % ślad
był kilkanaście razy szerszy od kursora. Kursor gumki działa tak samo, tyle że
promień kasowania jest stały w pikselach ekranu, więc nie zależy od powiększenia.

### Kafle a powiększenie

Każdy kafel pamięta skalę, w której powstał (`tile.scale`), i rysuje się według
niej. Dzięki temu kafel zbudowany przy innym powiększeniu nadal trafia we
właściwe miejsce, tylko jest mniej ostry — a to jest warunek płynnego zoomu.
Wcześniej `zoomAt` robił `tiles.clear()`, czyli przy **każdym** kliknięciu kółka
przerysowywał wszystkie kreski i wszystkie strony PDF-a od zera. Teraz kafle są
odświeżane dopiero po `TILE_RESHARPEN_MS` od ostatniego ruchu kółkiem i tylko
wtedy, gdy skala naprawdę się rozjechała.

Dopisanie gotowej kreski **nie unieważnia kafla**, tylko dorysowuje ją do niego
(`paintStrokeIntoTiles`). Wcześniej koszt zakończenia jednej kreski rósł razem
z zawartością kartki, bo kafel odtwarzał się w całości: wszystkie obrazy (strona
PDF-a to kilkanaście megapikseli) i wszystkie kreski, które go dotykają. Przy
gęstej stronie z PDF-em w tle było to czuć. Kasowanie, cofanie i przesuwanie
nadal unieważniają kafel — tam trzeba zdjąć piksele, a nie dołożyć.

Gotowe kreski trzymane są w kafelkach po `TILE_HEIGHT` pikseli świata;
przerysowywane są tylko kafle widoczne i zmienione, a kreski odrzucane po
bboxie. Powyżej `MAX_CACHE_SCALE` kafle są pomijane i kreski lecą wprost na
ekran: w takim powiększeniu kafel byłby ogromny, a widocznych kresek jest mało.
Kreska, która właśnie rośnie — moja albo cudza — żyje na wierzchu i trafia do
kafla dopiero, gdy przestanie się zmieniać.

**W trakcie pociągnięcia nie ma pełnego przemalowania i to jest warunek
płynności.** Punkty lecą do Y.Doc raz na klatkę, a `handleDocChange` rozpoznaje,
że zmieniła się wyłącznie kreska rysowana właśnie tutaj, i nie planuje renderu —
piksele są już na ekranie z `paintLive`. Wcześniej każdy ruch pióra czyścił cały
canvas i odtwarzał widok od zera: jedno pociągnięcie o 120 punktach kosztowało
122 pełne przemalowania i 7619 wywołań `stroke()` zamiast 2 i 360, bo rosnąca
kreska była rysowana od początku przy każdej klatce. Przy canvasie
`desynchronized` (który jest tu po to, żeby skrócić drogę od pióra do piksela)
wyczyszczone tło potrafiło trafić na ekran przed rysunkiem — i to jest dokładnie
ten objaw, w którym kreska miga w trakcie pisania, a po oderwaniu pióra wygląda
normalnie.

Wniosek na przyszłość: cokolwiek dokładasz do `handleDocChange`, nie wołaj stamtąd
`scheduleRender()` bezwarunkowo. Ustaw flagę i zaplanuj render tylko wtedy, gdy
zmieniło się coś, czego ścieżka inkrementalna nie narysowała.

Zdekodowane obrazy trzymamy najwyżej `MAX_BITMAPS` naraz, w kolejce LRU. Strona
PDF-a po zdekodowaniu to kilkanaście megabajtów, a notatnik może ich mieć sto;
wyrzucony obraz wraca z `dataUrl`-a, gdy znowu wjedzie w widok.

Wejście:

- Pióro i mysz rysują, środkowy przycisk i palec przesuwają widok, odwrócona
  końcówka rysika działa jak gumka.
- Punkty zbierane są przez `getCoalescedEvents()`, więc próbki z tabletu nie giną.
- Piksel na ekranie leci przed synchronizacją: `drawLatestSegment` rysuje od razu
  w `pointermove`, a zapis do Yjs jest zbierany w jedną transakcję na klatkę.
- Gumka kasuje **wzdłuż przebytej drogi**, nie w punktach próbkowania — przy
  szybkim ruchu przeglądarka scala kilkadziesiąt zdarzeń w jedno i odstęp między
  dwiema pozycjami bywa większy niż średnica gumki.

## Wczytany PDF

Plik upuszczony na okno albo wybrany przez Plik → „Wczytaj PDF jako tło…"
zamienia się w **zablokowane obrazy tła**: strony jedna pod drugą, z przerwą
`PDF_PAGE_GAP`. Atrament leży na nich tak samo jak na kratce.

Strona PDF-a jest **węższa niż pole robocze** (`PDF_PAGE_WIDTH` 1600 przy
`PAGE_WIDTH` 2400) i wyśrodkowana, więc po obu stronach zostaje pas na notatki
na marginesie. Pasy są zwykłym polem roboczym — pisze się po nich normalnie.

Dlaczego strony są zwykłymi obrazami, a nie osobnym bytem: dzięki temu od razu
działa na nich wszystko, co już umie notatnik — zapis do pliku, kafle, migracje,
cofanie i synchronizacja w sesji. Jedyne, co trzeba było dołożyć, to flaga
`locked`, która wypina stronę z zaznaczania (`findImageAt`, `selectInBox`)
**oraz z gumki** (`eraseAt` w `doc.js` — tryb „Obiekty” kasuje obrazy, więc bez
tego jedno machnięcie gumką usuwało stronę tła). Bez tego jedno pociągnięcie
kursorem przesunęłoby tło pod całą notatką.

Każda strona dostaje cienką ramkę (`drawPageOutlines`), rysowaną wprost na
ekranie, a nie do kafli — dzięki temu ma zawsze jeden piksel niezależnie od
powiększenia. Przy jasnym PDF-ie kartka i margines są tego samego koloru, więc
bez ramki nie było widać, gdzie kończy się dokument.

Numer oglądanej strony pokazuje się w prawym dolnym rogu. Liczy się to, co jest
na środku ekranu, a nie górna krawędź — dzięki temu numer zmienia się wtedy,
kiedy naprawdę patrzysz na nową stronę.

Strony trafiają **pod** to, co już jest w notatniku (`contentBottom`), więc import
nigdy niczego nie przykrywa, a `Ctrl+Z` cofa go w całości.

| Parametr | Wartość | Dlaczego |
| --- | --- | --- |
| `PDF_PAGE_WIDTH` | 1600 | Strona zajmuje 2/3 pola roboczego; reszta to margines na notatki. |
| `PDF_RENDER_WIDTH` | 2400 px | Strona ma 1600 jednostek, więc zostaje ostra mniej więcej do 150 % powiększenia. Wyżej rośnie już tylko waga pliku. |
| `MAX_PDF_PAGES` | 100 | Każda strona to osobny obraz w pliku notatnika. |
| Format rastra | JPEG 0,85 | Strona to zdjęcie tekstu; PNG byłby kilka razy cięższy bez widocznej różnicy. Przy przekroczeniu 5 MB na obraz schodzimy do 0,65 i 0,45. |

### Eksport notatnika zbudowanego na PDF-ie

Gdy w notatniku są strony PDF-a, `Eksportuj do PDF…` nie robi zrzutu kartki
w A4, tylko **jedną stronę wyjściową na jedną stronę źródłową, w jej oryginalnym
rozmiarze** (`srcW`/`srcH` w punktach, zapisane przy imporcie) i bez marginesów
pola roboczego. Wychodzi dokument wyglądający jak oryginał z dopiskami.

Świadomy skutek: notatki zrobione w pasach **obok** strony wypadają poza kadr.
Tak było w zamówieniu — „sam PDF z rysunkami bezpośrednio na nim”. Pliki sprzed
wersji 6 nie mają `srcW`/`srcH`; tam eksport zakłada A4 i proporcje obrazu.

### Tło kartki pod jasnym PDF-em

Przy imporcie próbkujemy cztery rogi pierwszej strony (środek prawie zawsze jest
zadrukowany). Jeśli tło jest jasne, a motyw był ciemny, **włączamy jasny motyw**
— a nie tylko przemalowujemy tło. Powód: `themeInk` odwraca skrajne szarości
według motywu, więc biała kartka przy ciemnym motywie oznaczałaby białą kreskę
na białym tle, czyli notatki zniknęłyby z oczu. Motyw da się cofnąć w menu Widok.

pdf.js (1,5 MB) **nie jest ładowany na starcie** — wchodzi dynamicznym
`<script>` dopiero przy pierwszym imporcie. Dlatego `scripts/arrange-dist.js`
sprawdza obecność `renderer/vendor/pdf.bundle.js` jawnie: skan referencji
w `index.html` by go nie zobaczył, a paczka bez niego wyglądałaby normalnie
i cicho nie umiała wczytać PDF-a.

**Bez workera.** Chromium pod `file://` nie pozwala utworzyć workera — ani
z pliku, ani z `blob:`, ani jako moduł (sprawdzone, wszystkie trzy). pdf.js ma
na to oficjalne wyjście: `globalThis.pdfjsWorker` z `WorkerMessageHandler`
sprawia, że biblioteka liczy na wątku głównym i niczego nie pobiera. Rasteryzacja
blokuje więc interfejs, dlatego między stronami oddajemy sterowanie, a postęp
idzie w tytuł okna. Czcionek standardowych ani cmap nie wozimy — sprawdzone, że
pdf.js radzi sobie bez nich także z PDF-em, który nie osadza czcionek.

`isEvalSupported: false` przy `getDocument`: CSP renderera nie ma `unsafe-eval`,
więc pdf.js nie ma nawet próbować kompilować funkcji czcionkowych.

### Prostowanie kreski

Przytrzymanie pióra w bezruchu (`STRAIGHTEN_HOLD_MS`, z tolerancją
`STRAIGHTEN_MOVE_PX` na drżenie ręki) wywołuje `core.straightenStroke`. Ta
zamienia kreskę w odcinek od pierwszego do ostatniego punktu — **ale tylko
wtedy, gdy ona i tak już jest prawie prosta**: największe odchylenie od cięciwy
musi zmieścić się w `STRAIGHTEN_TOLERANCE` jej długości. Bez tego warunku
zatrzymanie ręki nad celowo narysowanym łukiem niszczyłoby go bez ostrzeżenia.

Kreska przy tym **się skraca**, więc nie da się jej domalować na wierzchu —
trzeba pełnego przemalowania, żeby zdjąć piksele po poprzednim kształcie.
Dlatego `doc.js` ma `setPoints` obok `appendPoints`. Po wyprostowaniu ruch pióra
przesuwa już tylko koniec odcinka, więc da się go dociągnąć dokładnie tam, gdzie
ma się kończyć.

## Strojenie pióra

Sprzęt nigdy nie odpowiada modelowi: tablety mapują nacisk różnie, a część
urządzeń nie zgłasza go wcale. Pokrętła są w `core.js`:

| Stała | Znaczenie |
| --- | --- |
| `PRESSURE_BASE`, `PRESSURE_RANGE` | Krzywa nacisku: szerokość przy zerowym nacisku i to, ile dokłada pełny. |
| `DEFAULT_PRESSURE` | Wartość, gdy urządzenie nie zgłasza nacisku (mysz, część tabletów). |
| `TAPER_RAMP` | Przez ile punktów narasta miękki pędzel na starcie kreski. |
| `MIN_POINT_SPACING`, `SMOOTHING` | Odrzucanie zbyt gęstych próbek i wygładzanie drgań tabletu. |

`widthAt` zależy **wyłącznie** od danych lokalnych punktu: pędzla, nacisku
i indeksu liczonego od początku kreski. Nigdy od jej długości ani odległości od
końca — inaczej `drawLatestSegment` policzyłby inną szerokość niż `drawStroke`
i linia „skoczyłaby” w momencie puszczenia pióra. Z tego samego powodu
wygładzanie jest przyczynowe: `smoothPoint` decyduje tylko o nowym punkcie
i nigdy nie rusza wcześniejszych.

## Tryb online

Aplikacja nigdy nie otwiera nasłuchującego portu i nie ma backendu. Provider
powstaje dopiero po świadomym uruchomieniu sesji; wcześniej nie istnieje żadne
połączenie. Sesja żyje wyłącznie w pamięci uczestników i znika, gdy się kończy.

**Kod zaproszenia** ma postać `mn1-<roomId>-<secret>`; obie połowy to 128 bitów
z `crypto.getRandomValues`, zapisane w base64url. `roomId` widzi serwer
sygnalizacyjny. `secret` trafia **wyłącznie** do opcji `password` providera,
z której y-webrtc wyprowadza przez PBKDF2 klucz AES-GCM i szyfruje nim całą
sygnalizację — łącznie z SDP i odciskami certyfikatów DTLS. Serwer widzi więc
losowy `roomId` i szum: nie podsłucha sesji i nie podstawi własnych kluczy.
Kod nie trafia do pliku notatnika ani do logów.

Uwaga na format: base64url zawiera myślnik, czyli ten sam znak co separator.
Podział jest jednoznaczny wyłącznie dlatego, że obie połowy mają stałą długość
22 znaków, a wyrażenie jest zakotwiczone z obu stron. Test to utrwala.

| Parametr | Wartość | Dlaczego |
| --- | --- | --- |
| `maxConns` | 9 | Razem z tobą maksymalnie 10 osób. |
| `filterBcConns` | `true` | Zgodnie z sekcją 6 instrukcji. |
| `signaling` | `wss://` z ustawień, domyślnie trzy serwery | Tylko wss — po `ws://` metadane szłyby otwartym tekstem. Trzy, bo gdy jedyny domyślny padł, objaw był mylący: sesja startowała, kod się generował, a druga osoba po prostu nigdy się nie pojawiała. y-webrtc łączy się ze wszystkimi naraz, więc wystarczy jeden działający. |
| `iceServers` | STUN + opcjonalny TURN | TURN dla sieci blokujących połączenia bezpośrednie. |
| Kursory | ~20 Hz w sieci, 60 Hz na ekranie | Z domknięciem ostatniej pozycji, żeby cudzy kursor nie zamarzał w locie. Odbiorca trzyma osobno pozycję pokazywaną i dociąga ją do ostatniej znanej co klatkę — bez tego kursor skakał co 50 ms i to było widać jako „klatkowanie” drugiej osoby. Zmierzone: 180 różnych pozycji na 180 klatek zamiast ~60 na 180. Warstwa kursorów nie jest już przebudowywana przy każdej klatce, tylko przesuwana `transform`-em. |
| Rozmiar dokumentu | 200 MB | Po przekroczeniu sesja przerywa się z komunikatem. |

Panel sesji otwiera kropka na dole paska narzędzi i robi obie rzeczy: wkleja się
w nim kod od kogoś („Dołącz") albo rozpoczyna własną sesję („Rozpocznij nową").
To samo jest w menu Online.

Nick i kolor ustawia się **przed dołączeniem**, w tym samym panelu (oraz w panelu
sesji, gdy to ty ją prowadzisz). Podgląd pokazuje dokładnie to, co zobaczą inni.
Etykieta z nickiem wyświetla się nieco w prawo i w dół od cudzego kursora, żeby
nie zasłaniała miejsca, w którym ktoś właśnie rysuje. Nick przechodzi przez tę
samą sanityzację co każda inna treść od innych osób.

W panelu sesji jest też **lista osób**, które są w niej w tej chwili: kropka
w kolorze danej osoby, jej nick i „to Ty” przy tobie. Bierze się wprost
z awareness, więc znika sama, gdy ktoś się rozłączy.

Ustawienia połączenia (adresy sygnalizacji, TURN) oraz nick i kolor żyją
w `localStorage` tego komputera, nigdy w pliku notatnika. Pola adresów są
opcjonalne — puste znaczy „użyj domyślnych”. Wpisany tam zły adres potrafi
wyglądać jak zepsuta aplikacja: nikt nie dołącza do sesji, bo obie strony nie
spotykają się na tym samym serwerze sygnalizacyjnym.

### Dzielenie wiadomości na ramki

Kanał danych WebRTC ma limit pojedynczej wiadomości (w Chromium ok. 256 kB),
a `simple-peer` niczego nie dzieli — woła `channel.send()` wprost. y-webrtc
wysyła całą aktualizację Yjs jako jedną wiadomość, więc wklejony obraz albo
pierwsza synchronizacja notatnika z obrazami przekraczały limit: `send` rzucał
wyjątkiem, kanał się zamykał i od tej chwili **nie docierało już nic, w żadną
stronę** — ani obrazy, ani adnotacje, ani kreski narysowane później.

`scripts/webrtc-frames.js` nakłada na `simple-peer` własną warstwę ramek
(`patchPeer`, wpinany w `scripts/collab-entry.js`, czyli wewnątrz zvendorowanego
bundle'a). Wiadomość do 48 kB idzie jedną ramką, większa jest cięta na ramki
z nagłówkiem: identyfikator wiadomości, numer ramki, liczba ramek. Odbiorca
składa je z powrotem, zanim y-webrtc w ogóle zobaczy zdarzenie `data`.

Druga strona jest niezaufana, więc składanie ma twarde granice: maksymalnie
16 MB na wiadomość, najwyżej 8 rozgrzebanych wiadomości naraz (najstarsze lecą
za burtę), a ramka z niezgodną liczbą ramek, powtórzonym numerem albo numerem
spoza zakresu jest po prostu pomijana. Testy w `test/webrtc-frames.test.js`.

Uwaga metodologiczna: **dwa okna w jednym procesie Electrona niczego tu nie
dowodzą**. y-webrtc synchronizuje je wtedy przez `BroadcastChannel` i nigdy nie
dotyka kanału WebRTC, więc błąd tej klasy wygląda w takim teście na naprawiony.
Trzeba dwóch osobnych procesów z osobnym `--user-data-dir`.

Przy dołączaniu domyślnie wybrany jest **nowy notatnik**, żeby nikt przypadkiem
nie wysłał obcym osobom swoich notatek. „Nowy notatnik” oznacza nowy `Y.Doc`,
nie wyczyszczony stary: w CRDT skasowanie treści to operacja, która rozeszłaby
się po sesji i usunęła notatki pozostałym. Z tego samego powodu w trakcie sesji
nie da się otworzyć ani założyć innego notatnika — najpierw kończy się sesję.

**Model zaufania, świadomie:** każdy, kto zna kod, może w sesji rysować
i kasować wszystko. CRDT gwarantuje, że równoczesne zmiany się nie gubią,
a `UndoManager` cofa tylko twoje. Na dysk zmiany trafiają wyłącznie przez
„Zapisz”. Treść od innych osób jest niezaufana: kreski, obrazy i adnotacje
przechodzą przez walidatory w `core.js`, a nazwy i kolory z awareness przez
`validatePeerState` i wyłącznie `textContent`.

## Skróty klawiszowe

Skróty jednoklawiszowe są konfigurowalne (Edycja → Skróty klawiszowe…)
i zapisywane w `localStorage`. Domyślnie:

| Skrót | Akcja |
| --- | --- |
| `P` / `E` / `V` | Pióro / gumka / kursor |
| `Delete` | Usuń zaznaczenie (narzędzie kursora) |
| `Esc` | Zdejmij zaznaczenie, zamknij panel |
| `B` / `L` | Dodaj adnotację / lista adnotacji |
| `[` / `]` | Mniejsza / większa grubość |
| `1`–`5` | Kolory z palety |
| Strzałki | Przesuwanie widoku |

Skróty z modyfikatorem obsługuje natywne menu:

| Skrót | Akcja |
| --- | --- |
| `Cmd/Ctrl+N` / `+O` | Nowy / otwórz |
| `Cmd/Ctrl+S` / `+Shift+S` | Zapisz / zapisz jako |
| `Cmd/Ctrl+Z` / `+Shift+Z` | Cofnij / ponów |
| `Cmd/Ctrl+0` | Resetuj widok |
| `Cmd/Ctrl+V` | Wklej obraz ze schowka |
| `Cmd/Ctrl` + kółko | Powiększenie |
