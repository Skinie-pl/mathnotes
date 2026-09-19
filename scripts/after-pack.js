'use strict';

// Podpisanie paczki macOS podpisem ad-hoc.
//
// Bez tego electron-builder zostawia bundle z samym podpisem linkera:
// `Identifier=Electron`, `Info.plist=not bound`, a Gatekeeper mówi „code has no
// resources but signature indicates they must be present". Skutek na macOS 26/27
// jest taki, że pobrana aplikacja nie uruchamia się w ogóle — system pokazuje
// „aplikacja jest uszkodzona", a prawy klik → Otwórz tego nie obchodzi, bo to
// nie jest pytanie o nieznanego dewelopera, tylko odrzucenie zepsutego podpisu.
//
// Podpis ad-hoc (`--sign -`) nie wymaga konta dewelopera i nie usuwa ostrzeżenia
// o niepodpisanej aplikacji, ale sprawia, że bundle jest spójny i daje się
// otworzyć przez prawy klik → Otwórz.

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) throw new Error('afterPack: nie ma ' + appPath);

  // --deep jest oznaczone jako przestarzałe, ale dla podpisu ad-hoc to nadal
  // jedyny prosty sposób, żeby objąć helpery i framework Electrona.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });

  console.log('  • podpisano ad-hoc  ' + path.relative(process.cwd(), appPath));
};
