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
cp ./*.html _pages_dist/
cp display-config.js _pages_dist/
cp robots.txt _pages_dist/ 2>/dev/null || true
cp -R assets _pages_dist/assets

# v3 frontend (pages + js modules) — served at /v3/pages/ on preview.
mkdir -p _pages_dist/v3
cp -R v3/pages _pages_dist/v3/pages
cp -R v3/js    _pages_dist/v3/js

echo "Deploying to preview.westscoring.pages.dev ..."
npx wrangler pages deploy --branch=preview --commit-dirty=true

echo "Cleaning staging folder..."
rm -rf _pages_dist

echo "Done. Preview URL: https://preview.westscoring.pages.dev"
