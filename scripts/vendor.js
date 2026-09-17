'use strict';

// Jedyny wyjątek od zasady „bez build stepu”. Uruchamiaj TYLKO przy aktualizacji
// Yjs / y-webrtc / y-protocols / lib0 — nigdy w `npm start`. Wynik commitujesz.
//
//   npm run vendor

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(__dirname, 'collab-entry.js');
const SHIMS = path.join(__dirname, 'node-shims.js');
const VENDOR_DIR = path.join(ROOT, 'renderer', 'vendor');
const OUTFILE = path.join(VENDOR_DIR, 'collab.bundle.js');

// jsPDF publikuje gotowy UMD, więc nie ma czego sklejać — kopiujemy artefakt
// autora, sprawdzamy pod CSP i commitujemy razem z resztą vendora.
const JSPDF_SRC = path.join(ROOT, 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js');
const JSPDF_OUT = path.join(VENDOR_DIR, 'jspdf.umd.min.js');

// Electron 44 wozi dużo nowszy Chromium; niższy cel nic nie kosztuje,
// a chroni przed składnią, której akurat nie obsługuje.
const TARGET = 'chrome114';

// CSP renderera to `script-src 'self'` bez unsafe-eval. Bundle, który trafia
// do <script>, nie ma prawa wołać eval ani new Function — inaczej zobaczylibyśmy
// to dopiero jako błąd w runtime, w losowym miejscu sesji online.
const FORBIDDEN = [
  { name: 'eval(', re: /(?<![.\w$])eval\s*\(/g },
  { name: 'new Function(', re: /new\s+Function\s*\(/g },
];

function checkCsp(code) {
  const problems = [];
  for (const { name, re } of FORBIDDEN) {
    for (const match of code.matchAll(re)) {
      const line = code.slice(0, match.index).split('\n').length;
      problems.push(name + ' w linii ' + line);
    }
  }
  return problems;
}

function pinnedVersions() {
  const pkg = require(path.join(ROOT, 'package.json'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return ['yjs', 'y-webrtc', 'y-protocols', 'lib0', 'simple-peer', 'jspdf'].map((name) => {
    const installed = require(path.join(ROOT, 'node_modules', name, 'package.json')).version;
    return { name, declared: all[name], installed };
  });
}

async function main() {
  const versions = pinnedVersions();
  for (const { name, declared, installed } of versions) {
    if (!declared) throw new Error(name + ' nie jest zadeklarowany w package.json');
    if (declared !== installed) {
      throw new Error(
        name + ': package.json mówi ' + declared + ', a zainstalowane jest ' + installed +
          '. Bundle musi odpowiadać przypiętym wersjom — uruchom `npm install`.',
      );
    }
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: TARGET,
    inject: [SHIMS],
    define: {
      global: 'globalThis',
      'process.env.NODE_ENV': '"production"',
    },
    // Licencje zależności zostają w pliku — to jest ich jedyna kopia w repo.
    legalComments: 'eof',
    // Bez minifikacji: to jest commitowany kod obcego pochodzenia,
    // który ma dać się przejrzeć i zdiffować przy aktualizacji.
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
  });

  const code = fs.readFileSync(OUTFILE, 'utf8');

  const problems = checkCsp(code);
  if (problems.length > 0) {
    fs.rmSync(OUTFILE, { force: true });
    throw new Error(
      'Bundle łamie CSP renderera (script-src bez unsafe-eval):\n  ' + problems.join('\n  '),
    );
  }

  if (!code.includes('globalThis.Collab')) {
    fs.rmSync(OUTFILE, { force: true });
    throw new Error('Bundle nie wystawia globalThis.Collab — sprawdź scripts/collab-entry.js');
  }

  // --- jsPDF ---------------------------------------------------------------

  const jspdf = fs.readFileSync(JSPDF_SRC, 'utf8');
  const jspdfProblems = checkCsp(jspdf);
  if (jspdfProblems.length > 0) {
    throw new Error('jsPDF łamie CSP renderera:\n  ' + jspdfProblems.join('\n  '));
  }
  if (!jspdf.includes('jspdf')) {
    throw new Error('jsPDF nie wygląda na spodziewany artefakt UMD.');
  }
  fs.writeFileSync(JSPDF_OUT, jspdf);

  const kb = (Buffer.byteLength(code, 'utf8') / 1024).toFixed(0);
  const jspdfKb = (Buffer.byteLength(jspdf, 'utf8') / 1024).toFixed(0);
  console.log('Skopiowano ' + path.relative(ROOT, JSPDF_OUT) + ' (' + jspdfKb + ' kB)');
  console.log('Zbudowano ' + path.relative(ROOT, OUTFILE) + ' (' + kb + ' kB)');
  for (const { name, installed } of versions) console.log('  ' + name + ' ' + installed);
  console.log('Pamiętaj: wynik idzie do repo. Uruchom `npm test`.');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
