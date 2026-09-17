// Minimalne podpórki pod node'owe globale, których szukają zależności y-webrtc
// (simple-peer → readable-stream, debug). Wstrzykiwane przez esbuild `inject`,
// więc trafiają do bundle'a tylko wtedy, gdy ktoś naprawdę ich użyje.
//
// Świadomie nie ma tu pełnego polyfilla node'a: jeśli któraś biblioteka zacznie
// potrzebować czegoś więcej niż poniżej, lepiej to zobaczyć jako błąd builda
// niż dostać po cichu atrapę, która zwraca bzdury.

export const process = {
  env: { NODE_ENV: 'production' },
  browser: true,
  platform: 'browser',
  version: '',
  versions: {},
  nextTick(fn, ...args) {
    queueMicrotask(() => fn(...args));
  },
};
