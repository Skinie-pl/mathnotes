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
| `renderer/doc.js` | Model dokumentu na Yjs, `Y.UndoManager`. |
| `renderer/online.js` | Provider y-webrtc, awareness, obsługa pokoju. |
| `renderer.js` | Wyłącznie okablowanie DOM/canvas. |
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
- [ ] 4. `npm run vendor` i bundle Collab.
- [ ] 5. `doc.js` — schemat Yjs, UndoManager, eksport/import JSON.
- [ ] 6. `renderer.js` — pointer events, dwie ścieżki renderowania, kafle, narzędzia, UI.
      Tu też wchodzi potwierdzenie zamknięcia okna z niezapisanym, nienazwanym
      notatnikiem — wcześniej nie ma stanu „są niezapisane zmiany”, którego
      miałoby bronić.
- [ ] 7. `online.js` — kod zaproszenia, provider z `password`, awareness, limity, walidacja.
- [ ] 8. QA.

Pozycje menu z nieukończonych etapów zgłaszają się w tytule okna jako
„Jeszcze niedostępne”, zamiast milczeć.
