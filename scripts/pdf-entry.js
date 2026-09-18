// Wejście bundle'a pdf.js. Sklejane esbuildem przez `npm run vendor`.
//
// Renderer chodzi na file://, a Chromium blokuje tam tworzenie workerów —
// sprawdzone: ani z pliku, ani z blob:, ani jako moduł. pdf.js ma na to
// oficjalną ścieżkę: jeśli w globalThis.pdfjsWorker siedzi WorkerMessageHandler,
// biblioteka używa go wprost na wątku głównym i niczego nie pobiera.
//
// Znaczy to, że rasteryzacja blokuje interfejs. Jest to akceptowalne, bo dzieje
// się raz, przy świadomym imporcie pliku, i oddajemy sterowanie między stronami.
import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs';

globalThis.pdfjsWorker = pdfjsWorker;
globalThis.PdfJs = pdfjs;
