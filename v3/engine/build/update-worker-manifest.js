// Edits ENGINE_LATEST in ../../../west-worker.js to point at the most
// recently built asar. Called from publish-engine.bat after release-asar.js.
//
// What it changes (in west-worker.js, inside the /v3/engineLatest handler):
//
//   const ENGINE_LATEST = {
//     version: '...',     ← rewritten to package.json version
//     asarUrl: '...',     ← rewritten to https://preview.westscoring.pages.dev/engine/<version>.asar
//     sha256:  '...',     ← rewritten to sha256 of the new asar
//     releasedAt: ...,    ← rewritten to current ISO timestamp
//     releaseNotes: '...',← left alone (operator-edited)
//   };

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot   = path.resolve(__dirname, '..', '..', '..');
const workerPath = path.join(repoRoot, 'west-worker.js');
const distDir    = path.join(__dirname, '..', 'dist');
const releaseDir = path.join(distDir, 'release-asar');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;
const asarOutName = `${version}.asar`;
const asarPath = path.join(releaseDir, asarOutName);

if (!fs.existsSync(asarPath)) {
  console.error(`Asar missing: ${asarPath}\nRun \`npm run release-asar\` first.`);
  process.exit(1);
}
if (!fs.existsSync(workerPath)) {
  console.error(`west-worker.js missing at ${workerPath}`);
  process.exit(1);
}

const buf = fs.readFileSync(asarPath);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const asarUrl = `https://preview.westscoring.pages.dev/engine/${asarOutName}`;
const releasedAt = new Date().toISOString();

let workerSrc = fs.readFileSync(workerPath, 'utf8');

// Match the ENGINE_LATEST block — anchored on `const ENGINE_LATEST = {` and the
// closing `};`. Non-greedy on the body so the regex doesn't cross into the
// next code block. Whitespace tolerant on each field.
const blockRe = /const ENGINE_LATEST = \{[\s\S]*?\};/;
if (!blockRe.test(workerSrc)) {
  console.error('Could not locate ENGINE_LATEST block in west-worker.js');
  console.error('Expected: `const ENGINE_LATEST = { ... };` inside the /v3/engineLatest handler.');
  process.exit(1);
}

// Preserve releaseNotes if present — otherwise default to empty string.
const existing = workerSrc.match(blockRe)[0];
const notesMatch = existing.match(/releaseNotes:\s*['"`]([^'"`]*)['"`]/);
const releaseNotes = notesMatch ? notesMatch[1] : '';

const newBlock = [
  'const ENGINE_LATEST = {',
  `        version: '${version}',`,
  `        asarUrl: '${asarUrl}',`,
  `        sha256:  '${sha}',`,
  `        releasedAt: '${releasedAt}',`,
  `        releaseNotes: '${releaseNotes.replace(/'/g, "\\'")}',`,
  '      };',
].join('\n      ');

const updated = workerSrc.replace(blockRe, newBlock);
fs.writeFileSync(workerPath, updated, 'utf8');

console.log(`Updated ENGINE_LATEST in west-worker.js:`);
console.log(`  version:    ${version}`);
console.log(`  asarUrl:    ${asarUrl}`);
console.log(`  sha256:     ${sha.slice(0, 16)}…`);
console.log(`  releasedAt: ${releasedAt}`);
