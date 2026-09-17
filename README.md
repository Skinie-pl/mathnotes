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

Obok pliku żyją dwie ścieżki pomocnicze:

- `<plik>.tmp` — istnieje tylko w trakcie zapisu; po nieudanym zapisie jest
  sprzątany, więc jego obecność oznacza ubity proces.
- `<plik>.bak` — dokładnie jedna wersja wstecz, nie historia. Odzyskanie jest
  ręczne: zmiana nazwy na `.json`.

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
- [ ] 3. `core.js` — format v2, migracja z v1, walidatory, geometria, `widthFactor`.
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
