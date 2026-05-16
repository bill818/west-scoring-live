#!/usr/bin/env bash
# WEST Scoring Live — deploy frontend to PRODUCTION (westscoring.live).
#
# The Cloudflare Pages project `westscoring` has production_branch=main
# and Git Provider = None (direct uploads). Deploying with --branch=main
# publishes the staged _pages_dist to the PRODUCTION deployment, which
# the westscoring.live custom domain serves. Any other --branch value is
# a preview deployment (see deploy-preview.sh, --branch=preview).
#
# This is the v2 → v3 cutover script. Mirrors deploy-preview.sh exactly
# except the branch target + a confirmation gate (production is live to
# the public + scoring operators the instant this finishes).
#
# Worker is separate (wrangler.worker.toml, single shared instance) —
# already current. This script ONLY swaps the public frontend.
#
# ROLLBACK: re-promote the last good v2 production deployment from the
# Cloudflare dashboard (Pages → westscoring → Deployments → the prior
# Production row → "Rollback to this deployment"), OR re-run the v2
# deploy from a v2 checkout. Keep this in your back pocket during Devon.
set -euo pipefail

cd "$(dirname "$0")"

# Confirmation gate — this publishes to the PUBLIC production domain.
echo "────────────────────────────────────────────────────────────────"
echo "  PRODUCTION DEPLOY → https://westscoring.live  (Pages branch: main)"
echo "  This replaces the currently-served site for ALL public users"
echo "  and scoring operators immediately. (v2 → v3 cutover.)"
echo "────────────────────────────────────────────────────────────────"
read -r -p "Type 'GO LIVE' to proceed: " CONFIRM
if [ "$CONFIRM" != "GO LIVE" ]; then
  echo "Aborted — no deploy."
  exit 1
fi

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

# v3 is THE site — pages served at root, no /v3/ URL prefix. v2 .html
# files at the repo root are kept as design references but NOT deployed.
# v3 page refs like "../js/west-foo.js" resolve to "/js/west-foo.js"
# from a root-level page, so v3/js gets staged at /js/.
cp -R v3/pages/. _pages_dist/
cp -R v3/js      _pages_dist/js

# Cache-bust: replace ?v=__BUILD__ with a unique token (git short SHA +
# epoch) so mobile Safari can't serve stale JS bundles after the cutover.
BUILD_ID="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%s)"
echo "Build ID: $BUILD_ID"
find _pages_dist -name '*.html' -print0 | xargs -0 sed -i '' "s/__BUILD__/${BUILD_ID}/g"

# Engine asar releases — served at /engine/<version>.asar for the in-app
# updater. Built on Windows; won't exist on this Mac. Skip silently if
# the release directory is empty or missing.
if compgen -G "v3/engine/dist/release-asar/*.asar" > /dev/null; then
  mkdir -p _pages_dist/engine
  cp v3/engine/dist/release-asar/*.asar _pages_dist/engine/
  echo "Engine asar releases staged for upload."
fi

echo "Deploying to PRODUCTION (westscoring.live) ..."
npx wrangler pages deploy --branch=main --commit-dirty=true

echo "Cleaning staging folder..."
rm -rf _pages_dist

echo "Done. PRODUCTION live: https://westscoring.live"
echo "Smoke-test now: admin, a live ring, display kiosk per ring,"
echo "results page, vMix sandbox URL, QR → public show page."
