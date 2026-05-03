#!/usr/bin/env bash
# WEST Scoring Live — deploy frontend to PREVIEW branch (Mac counterpart
# of deploy-preview.bat). Project name + output dir come from
# wrangler.toml (the Pages config). Worker uses wrangler.worker.toml —
# see deploy.sh / deploy.bat.
set -euo pipefail

cd "$(dirname "$0")"

# Cloudflare API token + nvm-installed wrangler.
# shellcheck source=/dev/null
source ~/.cloudflare-env
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"

echo "Staging frontend files..."
rm -rf _pages_dist
mkdir _pages_dist
cp robots.txt _pages_dist/ 2>/dev/null || true
cp -R assets _pages_dist/assets

# v3 is now THE site — pages served at root, no /v3/ URL prefix.
# v2 .html files at the repo root are kept as design references but
# not deployed. v3 page references like "../js/west-foo.js" resolve
# from a root-level page to "/js/west-foo.js" via standard URL
# normalization, so v3/js gets staged at /js/.
cp -R v3/pages/. _pages_dist/
cp -R v3/js      _pages_dist/js

# Engine asar releases — served at /engine/<version>.asar for the in-app
# updater. Built on Windows; won't exist on this Mac. Skip silently if
# the release directory is empty or missing.
if compgen -G "v3/engine/dist/release-asar/*.asar" > /dev/null; then
  mkdir -p _pages_dist/engine
  cp v3/engine/dist/release-asar/*.asar _pages_dist/engine/
  echo "Engine asar releases staged for upload."
fi

echo "Deploying to preview.westscoring.pages.dev ..."
npx wrangler pages deploy --branch=preview --commit-dirty=true

echo "Cleaning staging folder..."
rm -rf _pages_dist

echo "Done. Preview URL: https://preview.westscoring.pages.dev"
