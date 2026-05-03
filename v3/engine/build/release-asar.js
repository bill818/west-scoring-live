// Bundles an asar release for OTA distribution. Run AFTER `npm run build`.
//
// Output:
//   dist/release-asar/
//     <version>.asar          — copy of resources/app.asar from latest build
//     <version>.asar.sha256   — hex sha-256 of the asar
//     manifest-snippet.txt    — paste into ENGINE_LATEST in west-worker.js
//
// Publish flow:
//   1. Bump ENGINE_VERSION in v3/engine/main.js (e.g. '3.0.0-dev' → '3.0.1')
//   2. Bump version in v3/engine/package.json
//   3. npm run build  (produces installer + asar)
//   4. node build/release-asar.js
//   5. Upload <version>.asar to Pages preview at /engine/<version>.asar:
//        wrangler pages deploy ... (or copy into your Pages public dir + redeploy)
//   6. Edit ENGINE_LATEST in west-worker.js with the manifest-snippet contents
//   7. Deploy worker (deploy.bat)
//   8. Engines will see the update on next hourly check (or operator clicks "Check now")

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const distDir   = path.join(__dirname, '..', 'dist');
const releaseDir = path.join(distDir, 'release-asar');
const asarSrc   = path.join(distDir, 'win-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(asarSrc)) {
  console.error(`Missing build output: ${asarSrc}\nRun \`npm run build\` first.`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;

fs.mkdirSync(releaseDir, { recursive: true });

const asarOutName = `${version}.asar`;
const asarOut     = path.join(releaseDir, asarOutName);
fs.copyFileSync(asarSrc, asarOut);

const buf  = fs.readFileSync(asarOut);
const sha  = crypto.createHash('sha256').update(buf).digest('hex');
fs.writeFileSync(asarOut + '.sha256', sha + '\n', 'utf8');

const asarUrl = `https://preview.westscoring.pages.dev/engine/${asarOutName}`;
const releasedAt = new Date().toISOString();

const snippet = [
  '// Paste this into ENGINE_LATEST in west-worker.js (in the /v3/engineLatest handler):',
  '',
  'const ENGINE_LATEST = {',
  `  version: '${version}',`,
  `  asarUrl: '${asarUrl}',`,
  `  sha256:  '${sha}',`,
  `  releasedAt: '${releasedAt}',`,
  `  releaseNotes: '',  // fill in if you want operators to see notes`,
  '};',
  '',
].join('\n');

fs.writeFileSync(path.join(releaseDir, 'manifest-snippet.txt'), snippet, 'utf8');

console.log(`Asar release ready at: ${releaseDir}`);
console.log(`  ${asarOutName}             (${(buf.length / 1024).toFixed(1)} KB)`);
console.log(`  ${asarOutName}.sha256       sha256 = ${sha.slice(0, 16)}…`);
console.log(`  manifest-snippet.txt       ready to paste`);
console.log();
console.log(`Next: upload ${asarOutName} to Pages preview at /engine/${asarOutName},`);
console.log(`then update ENGINE_LATEST in west-worker.js + deploy worker.`);
