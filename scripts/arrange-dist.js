'use strict';

// Porządkuje wynik electron-buildera w foldery nazwane po platformie i dokłada
// do każdego krótkie „jak uruchomić”. electron-builder nazywa katalogi celu
// `dir` po swojemu (mac, mac-arm64, win-unpacked) i nie da się tego ustawić
// per-target, więc przekładamy je tutaj.
//
//   npm run dist

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const { version } = require(path.join(ROOT, 'package.json'));

const LAYOUT = [
  {
    from: 'mac-arm64',
    to: 'MathNotes-' + version + '-mac-arm64',
    readme:
      'MathNotes ' + version + ' — macOS, procesory Apple Silicon (M1 i nowsze)\n\n' +
      'Uruchomienie: kliknij dwukrotnie MathNotes.app.\n\n' +
      'Aplikacja nie jest podpisana certyfikatem Apple, więc przy pierwszym\n' +
      'uruchomieniu system może ją zablokować. Wtedy: prawy klik na MathNotes.app\n' +
      '→ Otwórz → Otwórz. Wystarczy raz.\n',
  },
  {
    from: 'mac',
    to: 'MathNotes-' + version + '-mac-x64',
    readme:
      'MathNotes ' + version + ' — macOS, procesory Intel\n\n' +
      'Uruchomienie: kliknij dwukrotnie MathNotes.app.\n\n' +
      'Aplikacja nie jest podpisana certyfikatem Apple, więc przy pierwszym\n' +
      'uruchomieniu system może ją zablokować. Wtedy: prawy klik na MathNotes.app\n' +
      '→ Otwórz → Otwórz. Wystarczy raz.\n',
  },
  {
    from: 'win-unpacked',
    to: 'MathNotes-' + version + '-win-x64',
    readme:
      'MathNotes ' + version + ' — Windows 64-bit, wersja przenośna\n\n' +
      'Uruchomienie: MathNotes.exe. Nie ma instalatora — cały folder jest\n' +
      'aplikacją, można go skopiować gdziekolwiek, także na pendrive.\n\n' +
      'Aplikacja nie jest podpisana, więc SmartScreen może pokazać ostrzeżenie.\n' +
      'Wtedy: Więcej informacji → Uruchom mimo to.\n\n' +
      'Notatniki zapisują się domyślnie w Dokumenty\\MathNotes.\n',
  },
];

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** Lista plików w archiwum asar, czytana z jego nagłówka (zwykły JSON na początku). */
function asarFiles(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);

    const out = [];
    const walk = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files || {})) {
        if (value.files) walk(value, prefix + name + '/');
        else out.push(prefix + name);
      }
    };
    walk(JSON.parse(json.toString('utf8')), '');
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Sprawdza, że w paczce jest wszystko, co ładuje index.html. Pominięcie choćby
 * jednego skryptu daje aplikację, która wygląda normalnie i nie robi zupełnie
 * nic — właśnie tak wypadł kiedyś renderer.js. Lepiej wywalić build.
 */
function verifyPackage(appDir, label) {
  const asarPath = path.join(appDir, 'app.asar');
  if (!fs.existsSync(asarPath)) throw new Error(label + ': brak app.asar w ' + appDir);

  const inside = new Set(asarFiles(asarPath));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => !/^(https?:)?\/\//.test(ref));

  const missing = referenced.filter((ref) => !inside.has(ref));
  // main.js i preload.js nie są w index.html, a bez nich nie ma aplikacji.
  for (const required of ['main.js', 'preload.js', 'notebook-file.js']) {
    if (!inside.has(required)) missing.push(required);
  }

  if (missing.length > 0) {
    throw new Error(label + ': w paczce brakuje plików: ' + missing.join(', '));
  }
  return referenced.length + 3;
}

function zipFolder(folder) {
  const archive = folder + '.zip';
  rmrf(archive);
  // ditto zachowuje uprawnienia i dowiązania w .app; na innych systemach
  // wystarczy zwykły zip.
  if (process.platform === 'darwin') {
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', folder, archive]);
  } else {
    execFileSync('zip', ['-qry', archive, path.basename(folder)], { cwd: path.dirname(folder) });
  }
  return archive;
}

function size(target) {
  let total = 0;
  const walk = (p) => {
    const stat = fs.lstatSync(p);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
    else total += stat.size;
  };
  walk(target);
  return (total / 1024 / 1024).toFixed(0) + ' MB';
}

const made = [];
for (const item of LAYOUT) {
  const from = path.join(DIST, item.from);
  if (!fs.existsSync(from)) continue;

  // Zanim cokolwiek przełożymy — sprawdzamy, czy paczka w ogóle jest kompletna.
  const resources =
    item.from.startsWith('mac')
      ? path.join(from, 'MathNotes.app', 'Contents', 'Resources')
      : path.join(from, 'resources');
  const checked = verifyPackage(resources, item.to);

  const to = path.join(DIST, item.to);
  rmrf(to);
  fs.renameSync(from, to);
  fs.writeFileSync(path.join(to, 'CZYTAJ TO.txt'), item.readme, 'utf8');

  const archive = zipFolder(to);
  made.push({ folder: item.to, folderSize: size(to), archiveSize: size(archive), checked });
}

// Pozostałości pośrednie electron-buildera — nie mają czego szukać obok paczek.
for (const junk of ['builder-debug.yml', '.icon-icns', '.icon-ico', '.icon-set']) {
  rmrf(path.join(DIST, junk));
}

if (made.length === 0) {
  console.log('Brak świeżych paczek — najpierw `npm run dist:mac` albo `npm run dist:win`.');
} else {
  console.log('Gotowe paczki w dist/:');
  for (const item of made) {
    console.log(
      '  ' + item.folder + '  (folder ' + item.folderSize + ', zip ' + item.archiveSize +
        ', sprawdzono ' + item.checked + ' plików)',
    );
  }
}
