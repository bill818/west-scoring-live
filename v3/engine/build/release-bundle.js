// Bundles the installer + README.txt into a single folder for distribution.
// Run via `npm run release` after `npm run build`.
//
// Output:
//   dist/release-bundle/
//     WEST-Engine-Setup-<version>.exe
//     README.txt
//
// Worker URL + auth key are baked into the installer (build/installer.nsh).
// To rotate them: edit installer.nsh, run `npm run build`, redistribute.

const fs = require('fs');
const path = require('path');

const distDir   = path.join(__dirname, '..', 'dist');
const bundleDir = path.join(distDir, 'release-bundle');

fs.mkdirSync(bundleDir, { recursive: true });

// Find the freshest Setup .exe in dist/
const setupExes = fs.readdirSync(distDir)
  .filter(f => /^WEST-Engine-Setup-.*\.exe$/.test(f))
  .map(f => ({ name: f, mtime: fs.statSync(path.join(distDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (!setupExes.length) {
  console.error('No WEST-Engine-Setup-*.exe found in dist/. Run `npm run build` first.');
  process.exit(1);
}

const exeName = setupExes[0].name;
const exeSrc  = path.join(distDir, exeName);
const exeDst  = path.join(bundleDir, exeName);
fs.copyFileSync(exeSrc, exeDst);

const readmeTxt = [
  '═══════════════════════════════════════════════════════════════',
  '  WEST Engine — install instructions',
  '═══════════════════════════════════════════════════════════════',
  '',
  'PREREQUISITE',
  '────────────',
  'Ryegate (the scoring software) must be installed at:',
  '  C:\\Ryegate\\Jumper\\',
  'with Classes\\, tsked.csv, and config.dat present. The engine',
  'reads from these paths.',
  '',
  'INSTALL',
  '───────',
  '1. Right-click ' + exeName + ' → Run as administrator.',
  '   (Windows may show a SmartScreen warning — click "More info"',
  '    → "Run anyway." The installer is unsigned.)',
  '2. Click through the installer (Next → Install).',
  '3. The engine launches automatically when install finishes.',
  '',
  'FIRST RUN',
  '─────────',
  '4. The show picker opens. Pick the show and ring this PC',
  '   should track. Click Switch.',
  '5. Done. The engine is now relaying UDP to RSServer (default)',
  '   AND posting .cls / tsked / UDP events to the worker for the',
  '   selected show.',
  '',
  'WHAT THE INSTALLER DOES',
  '───────────────────────',
  '  • Installs WestEngine.exe to c:\\west-engine\\',
  '  • Creates Start Menu and Desktop shortcuts',
  '  • Creates state directory c:\\west\\v3\\ for config + logs',
  '  • Drops a config.json with worker URL + auth key already',
  '    filled in (only on fresh install — preserved on upgrade)',
  '  • Adds an uninstaller to Windows Add/Remove Programs',
  '',
  'Your config and logs at c:\\west\\v3\\ are NOT touched on uninstall',
  'or reinstall — operator data persists.',
  '',
  'AUTO-START ON BOOT',
  '──────────────────',
  'Open Settings inside the engine and toggle "Launch on Windows',
  'boot." The engine will then start automatically when this PC',
  'signs in.',
  '',
  'TROUBLESHOOTING',
  '───────────────',
  'Logs:    c:\\west\\v3\\engine_log.txt',
  'Config:  c:\\west\\v3\\config.json',
  'Crash:   c:\\west\\v3\\crash_log.json (only present if the engine has crashed)',
  '',
].join('\r\n');

fs.writeFileSync(path.join(bundleDir, 'README.txt'), readmeTxt, 'utf8');

console.log(`Release bundle ready at: ${bundleDir}`);
console.log(`  ${exeName}`);
console.log(`  README.txt`);
