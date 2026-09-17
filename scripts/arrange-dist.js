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

  const to = path.join(DIST, item.to);
  rmrf(to);
  fs.renameSync(from, to);
  fs.writeFileSync(path.join(to, 'CZYTAJ TO.txt'), item.readme, 'utf8');

  const archive = zipFolder(to);
  made.push({ folder: item.to, folderSize: size(to), archiveSize: size(archive) });
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
    console.log('  ' + item.folder + '  (folder ' + item.folderSize + ', zip ' + item.archiveSize + ')');
  }
}
