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

## Architektura

Bez bundlera i bez transpilacji w runtime — zwykłe pliki `.js` ładowane przez
`<script>`, więc `npm start` działa od razu po `npm install`.

| Plik | Rola |
| --- | --- |
| `main.js` | Okno, natywne menu po polsku, blokada nawigacji, handlery IPC, pliki. |
| `notebook-file.js` | Atomowy zapis: `.tmp` + fsync → kopia do `.bak` → `rename`. |
| `preload.js` | Jedyny most renderer↔Node (`window.api`, jawnie nazwane metody). |
| `renderer/core.js` | Logika bez DOM: format pliku, walidacja, geometria, `widthFactor`. Testowana w `test/`. |
| `renderer/doc.js` | Model dokumentu na Yjs, `Y.UndoManager`, jedyne miejsce mutujące Y.Doc. |
| `renderer/online.js` | Provider y-webrtc, awareness, obsługa pokoju. |
| `renderer.js` | Wyłącznie okablowanie DOM/canvas. |
| `renderer/vendor/collab.bundle.js` | Zvendorowany Yjs + y-webrtc, budowany przez `npm run vendor`. |
| `index.html` | Nagłówek CSP, ciemna skóra UI. |

### Zależności i `npm run vendor`

Yjs, y-webrtc, y-protocols i lib0 to moduły ESM z zależnościami, więc nie da się
ich wprost wpiąć przez `<script>`. Jedyny wyjątek od zasady „bez build stepu”:

```bash
npm run vendor
```

Skrypt skleja je esbuildem w jeden `renderer/vendor/collab.bundle.js`, który
eksponuje `window.Collab = { Y, WebrtcProvider, awarenessProtocol }`. Wynik jest
commitowany do repo, więc aplikacja jest samowystarczalna po spakowaniu.
Uruchamiaj go **tylko** przy aktualizacji tych bibliotek, nigdy w `npm start`.
Wersje są przypięte dokładnie (bez `^`) i trzymane w `devDependencies`, bo do
runtime'u trafia wyłącznie zvendorowany bundle.

Co wchodzi do bundle'a, decyduje `scripts/collab-entry.js` — reszta bibliotek
zostaje w środku. `scripts/node-shims.js` dokłada minimalne podpórki pod
node'owe globale, których szukają zależności y-webrtc (`simple-peer` →
`readable-stream`, `debug`). Świadomie nie ma tam pełnego polyfilla node'a:
gdy któraś biblioteka zacznie potrzebować czegoś więcej, lepiej zobaczyć błąd
builda niż dostać po cichu atrapę zwracającą bzdury.

Sam skrypt pilnuje trzech rzeczy i przerywa build, gdy któraś nie gra:

1. Zainstalowane wersje odpowiadają przypiętym w `package.json` — bundle nie
   może pochodzić z innych wersji, niż deklaruje repo.
2. Wynik nie zawiera `eval(` ani `new Function(`. CSP renderera to
   `script-src 'self'` bez `unsafe-eval`, więc inaczej wywaliłoby się dopiero
   w runtime, w losowym miejscu sesji online. Ten sam warunek sprawdza test,
   żeby ręcznie dłubany bundle też nie przeszedł.
3. Wynik faktycznie wystawia `globalThis.Collab`.

Bundle nie jest minifikowany: to commitowany kod obcego pochodzenia, który ma
dać się przejrzeć i zdiffować przy aktualizacji. Licencje zależności zostają
na końcu pliku — to ich jedyna kopia w repo.

## Format pliku

Plik notatnika to tekstowy JSON z polem `version`, nigdy binarny stan Yjs —
dzięki temu format nie zależy od biblioteki. Zapisywany jest kompaktowo, bez
wcięć: przy dokumencie z dziesiątkami tysięcy kresek wcięcie na każdą liczbę
w `pts` potroiłoby rozmiar pliku.

Kształt stanu (`version: 2`):

```jsonc
{
  "version": 2,
  "meta": { "title": "", "background": "plain" },   // plain | grid | lines
  "strokes": [{
    "id": "a1",
    "tool": "pen",        // pen | highlighter
    "brush": "round",     // round = reaguje na nacisk, fine = stała szerokość
    "color": "#ffffff",
    "size": 2,
    "pts": [10, 20, 0.5]  // płasko [x, y, nacisk, ...], 0,1 px i 0,01 nacisku
  }],
  "images": [{ "id": "i1", "x": 0, "y": 0, "w": 100, "h": 50, "dataUrl": "data:image/png;base64,…" }]
}
```

Migracje trzymane są w `MIGRATIONS` w `core.js` i wykonują się po kolei, więc
bump wersji to dopisanie jednego kroku. Wersja 1 to kształt sprzed przejścia na
Yjs: punkty jako obiekty `{x, y, pressure}`. Plik bez pola `version` traktowany
jest jako v1, plik z wersją nowszą niż `FILE_FORMAT_VERSION` jest odrzucany
z czytelnym błędem, a nie otwierany z utratą danych.

`normalizeState` zwraca `{ state, skipped }`. Elementy, które nie przejdą
walidacji, są pomijane (fail closed), a nie po cichu naprawiane — `skipped`
mówi ile, żeby dało się o tym powiedzieć użytkownikowi.

Obok pliku żyją dwie ścieżki pomocnicze:

- `<plik>.tmp` — istnieje tylko w trakcie zapisu; po nieudanym zapisie jest
  sprzątany, więc jego obecność oznacza ubity proces.
- `<plik>.bak` — dokładnie jedna wersja wstecz, nie historia. Odzyskanie jest
  ręczne: zmiana nazwy na `.json`.

## Dokument i cofanie

Dokument to CRDT (Yjs). `renderer/doc.js` jest jedynym miejscem, które mutuje
Y.Doc; konwersja JSON↔Y.Doc siedzi w `core.js` i dostaje `Y` argumentem, żeby
core pozostał modułem bez zależności.

```
doc.getArray('strokes')  → Y.Map { id, tool, color, size, brush, pts: Y.Array }
doc.getArray('images')   → Y.Map { id, x, y, w, h, dataUrl }
doc.getMap('meta')       → { title, background }
```

**Cofanie robi `Y.UndoManager`, nie migawki stanu.** `trackedOrigins` to
wyłącznie lokalny origin instancji, więc undo zdejmuje tylko twoje zmiany —
migawka cofnęłaby w sesji online także to, co narysował ktoś inny. Przy okazji
znika problem pamięci przy obrazach. Test `undo cofa TYLKO moje zmiany`
utrwala to na dwóch połączonych dokumentach.

Granice kroków cofania domykamy jawnie przez `stopCapturing()` przy puszczeniu
pióra, zamiast polegać na samym `captureTimeout` — dzięki temu jedno
pociągnięcie to dokładnie jedno undo, także gdy ktoś rysuje bardzo wolno.

Wczytanie pliku leci osobnym originem i czyści historię: otwarcie notatnika nie
jest zmianą, którą da się cofnąć w pustkę.

## Rysowanie

Kartka ma stałą szerokość `PAGE_WIDTH` i przewija się tylko w pionie.
„Rozmiar rzeczywisty” (`Cmd/Ctrl+0`) to szerokość kartki równa szerokości okna —
przy tym powiększeniu nigdy nie ma przewijania w poziomie. Dopiero po
powiększeniu ponad ten poziom kartka wystaje poza okno i widok da się przesunąć
w bok (`Shift`+kółko albo palcem). To przesunięcie widoku po powiększonej
kartce, a nie druga oś dokumentu — dokument pozostaje kartką, nie tablicą.

Gotowe kreski trzymane są w kafelkach po `TILE_HEIGHT` pikseli strony;
przerysowywane są tylko kafle widoczne i zmienione, a kreski odrzucane po
bboxie. Powyżej `MAX_CACHE_SCALE` kafle są pomijane i kreski lecą wprost na
ekran: w takim powiększeniu kafel byłby ogromny, a widocznych kresek jest mało.

Wejście:

- Pióro i mysz rysują, palec przewija, odwrócona końcówka rysika działa jak gumka.
- Punkty zbierane są przez `getCoalescedEvents()`, więc próbki z tabletu nie giną.
- Piksel na ekranie leci przed synchronizacją: `drawLatestSegment` rysuje od razu
  w `pointermove`, a zapis do Yjs jest zbierany w jedną transakcję na klatkę.
- Gumka kasuje **wzdłuż przebytej drogi**, nie w punktach próbkowania — przy
  szybkim ruchu przeglądarka scala kilkadziesiąt zdarzeń w jedno i odstęp między
  dwiema pozycjami bywa większy niż średnica gumki.

## Strojenie pióra

Sprzęt nigdy nie odpowiada modelowi: tablety mapują nacisk różnie, a część
urządzeń nie zgłasza go wcale. Pokrętła są w `core.js`, przy `widthFactor`:

| Stała | Znaczenie |
| --- | --- |
| `PRESSURE_GAMMA` | Krzywa nacisku. Wyżej = trzeba mocniej docisnąć, żeby pogrubić. |
| `MIN_WIDTH_FACTOR` | Dolna granica szerokości — kreska nigdy nie znika. |
| `DEFAULT_PRESSURE` | Wartość, gdy urządzenie nie zgłasza nacisku (mysz, część tabletów). |
| `MIN_POINT_DISTANCE` | Próbki bliżej niż to od ostatniego punktu są odrzucane. |

`widthFactor` zależy **wyłącznie** od danych lokalnych punktu: pędzla, narzędzia
i nacisku. Nigdy od długości kreski ani odległości od jej końca — inaczej
`drawLatestSegment` policzyłby inną szerokość niż `drawStroke` i linia
„skoczyłaby” w momencie puszczenia pióra. Z tego samego powodu wygładzanie jest
przyczynowe: `shouldKeepPoint` decyduje tylko o nowym punkcie i nigdy nie rusza
wcześniejszych.

## Skróty klawiszowe

| Skrót | Akcja |
| --- | --- |
| `Cmd/Ctrl+N` | Nowy notatnik |
| `Cmd/Ctrl+O` | Otwórz |
| `Cmd/Ctrl+S` | Zapisz |
| `Cmd/Ctrl+Shift+S` | Zapisz jako |
| `Cmd/Ctrl+Shift+I` | Wstaw obraz |
| `Cmd/Ctrl+Z` | Cofnij (`Y.UndoManager`, nie undo DOM) |
| `Cmd/Ctrl+Shift+Z` | Ponów |
| `Cmd/Ctrl+=` / `Cmd/Ctrl+-` / `Cmd/Ctrl+0` | Powiększ / pomniejsz / rozmiar rzeczywisty |

## Stan budowy

Realizacja idzie etapami z sekcji 8 instrukcji. Po każdym etapie `npm test`.

- [x] 1. Szkielet Electron: okno, `preload.js`, CSP, blokada nawigacji, menu.
- [x] 2. `notebook-file.js` — atomowy zapis, `.bak`, testy.
- [x] 3. `core.js` — format v2, migracja z v1, walidatory, geometria, `widthFactor`.
- [x] 4. `npm run vendor` i bundle Collab.
- [x] 5. `doc.js` — schemat Yjs, UndoManager, eksport/import JSON.
- [x] 6. `renderer.js` — pointer events, dwie ścieżki renderowania, kafle, narzędzia, UI,
      potwierdzenie zamknięcia przy niezapisanych zmianach.
- [ ] 7. `online.js` — kod zaproszenia, provider z `password`, awareness, limity, walidacja.
- [ ] 8. QA.

Pozycje menu z nieukończonych etapów zgłaszają się w tytule okna jako
„Jeszcze niedostępne”, zamiast milczeć.
