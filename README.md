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

### Zależności i `npm run vendor`

Yjs, y-webrtc, y-protocols i lib0 to moduły ESM z zależnościami, więc nie da się
ich wprost wpiąć przez `<script>`. Jedyny wyjątek od zasady „bez build stepu”:

```bash
npm run vendor
```

Skrypt robi dwie rzeczy: skleja esbuildem Yjs i y-webrtc w jeden
`renderer/vendor/collab.bundle.js` wystawiający
`window.Collab = { Y, WebrtcProvider, awarenessProtocol }`, oraz kopiuje gotowy
UMD jsPDF do `renderer/vendor/jspdf.umd.min.js`. Oba wyniki są commitowane, więc
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
| `MathNotes-<wersja>-win-x64` | Windows 64-bit, wersja przenośna bez instalatora |

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
  "version": 4,
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
  "images": [{ "id": "i1", "x": 0, "y": 0, "w": 100, "h": 50, "dataUrl": "data:image/png;base64,…" }],
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

## Rysowanie

Kartka ma stałą szerokość `PAGE_WIDTH` (900 px) i przewija się w dół bez końca.
Widok trzyma współrzędne świata lewego górnego rogu plus powiększenie; w poziomie
jest przycięty do kartki z marginesem `PAGE_PAN_MARGIN`, więc nie da się odpłynąć
w bok.

**100 % to szerokość kartki dopasowana do okna** i zarazem maksymalne oddalenie —
dalej jest już tylko pustka wokół kartki, więc nie ma po co oddalać. W drugą
stronę można przybliżyć do 800 %. Wskaźnik procentów na dole toolbara resetuje
powiększenie kliknięciem. Ponieważ 100 % zależy od szerokości okna, po zmianie
rozmiaru trzymamy ten sam poziom procentowy, a nie tę samą skalę.

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

Gotowe kreski trzymane są w kafelkach po `TILE_HEIGHT` pikseli świata;
przerysowywane są tylko kafle widoczne i zmienione, a kreski odrzucane po
bboxie. Powyżej `MAX_CACHE_SCALE` kafle są pomijane i kreski lecą wprost na
ekran: w takim powiększeniu kafel byłby ogromny, a widocznych kresek jest mało.
Kreska, która właśnie rośnie — moja albo cudza — żyje na wierzchu i trafia do
kafla dopiero, gdy przestanie się zmieniać.

Wejście:

- Pióro i mysz rysują, środkowy przycisk i palec przesuwają widok, odwrócona
  końcówka rysika działa jak gumka.
- Punkty zbierane są przez `getCoalescedEvents()`, więc próbki z tabletu nie giną.
- Piksel na ekranie leci przed synchronizacją: `drawLatestSegment` rysuje od razu
  w `pointermove`, a zapis do Yjs jest zbierany w jedną transakcję na klatkę.
- Gumka kasuje **wzdłuż przebytej drogi**, nie w punktach próbkowania — przy
  szybkim ruchu przeglądarka scala kilkadziesiąt zdarzeń w jedno i odstęp między
  dwiema pozycjami bywa większy niż średnica gumki.

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
| `signaling` | `wss://` z ustawień | Tylko wss — po `ws://` metadane szłyby otwartym tekstem. |
| `iceServers` | STUN + opcjonalny TURN | TURN dla sieci blokujących połączenia bezpośrednie. |
| Kursory | ~20 Hz | Z domknięciem ostatniej pozycji, żeby cudzy kursor nie zamarzał w locie. |
| Rozmiar dokumentu | 200 MB | Po przekroczeniu sesja przerywa się z komunikatem. |

Nick i kolor ustawia się **przed dołączeniem**, w panelu dołączania (i w panelu
sesji, gdy to ty ją prowadzisz). Podgląd pokazuje dokładnie to, co zobaczą inni.
Etykieta z nickiem wyświetla się nieco w prawo i w dół od cudzego kursora, żeby
nie zasłaniała miejsca, w którym ktoś właśnie rysuje. Nick przechodzi przez tę
samą sanityzację co każda inna treść od innych osób.

Ustawienia połączenia (adresy sygnalizacji, TURN) oraz nick i kolor żyją
w `localStorage` tego komputera, nigdy w pliku notatnika.

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
