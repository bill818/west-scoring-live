@echo off
rem ============================================================
rem  WEST Engine — publish update over the air
rem
rem  Run this any time you want operators' "Install & restart"
rem  button to pick up your latest code change.
rem
rem  What this does:
rem    1. Bumps the version in v3\engine\package.json + main.js
rem       (or uses the existing version if you've already bumped)
rem    2. Builds a fresh asar from your current source
rem    3. Uploads the asar to Cloudflare Pages (preview branch)
rem    4. Rewrites ENGINE_LATEST in west-worker.js with the new
rem       version + asar URL + sha256
rem    5. Deploys the worker so operators see the new manifest
rem
rem  After this finishes, every running engine will see "Update
rem  available" within an hour (or sooner if the operator hits
rem  "Check now" on the Settings tab).
rem ============================================================

title WEST Engine — Publish Update

setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ── Step 1: bump version (or accept current) ───────────────
echo.
echo Current engine version:
node -e "console.log('  ' + require('./v3/engine/package.json').version)"
echo.
set /p NEW_VERSION="New version (Enter to keep current): "

if not "%NEW_VERSION%"=="" (
  echo Bumping version to %NEW_VERSION%...
  node -e "const fs=require('fs'),p='v3/engine/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='%NEW_VERSION%';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8');"
  rem Also bump ENGINE_VERSION in main.js
  node -e "const fs=require('fs'),p='v3/engine/main.js';let s=fs.readFileSync(p,'utf8');s=s.replace(/const ENGINE_VERSION = '[^']*';/,\"const ENGINE_VERSION = '%NEW_VERSION%';\");fs.writeFileSync(p,s,'utf8');"
)

rem ── Step 2: build the asar ────────────────────────────────
echo.
echo Building engine asar...
cd v3\engine
call npm run release-asar
if errorlevel 1 (
  echo Build failed. Aborting publish.
  cd ..\..
  pause
  exit /b 1
)
cd ..\..

rem ── Step 3: deploy Pages preview (which now ships the asar) ─
echo.
echo Deploying asar to Cloudflare Pages...
call deploy-preview.bat
if errorlevel 1 (
  echo Pages deploy failed. The new asar isn't hosted — aborting.
  pause
  exit /b 1
)

rem ── Step 4: rewrite ENGINE_LATEST in west-worker.js ───────
echo.
echo Updating worker manifest...
call node v3\engine\build\update-worker-manifest.js
if errorlevel 1 (
  echo Manifest update failed.
  pause
  exit /b 1
)

rem ── Step 5: deploy the worker ─────────────────────────────
echo.
echo Deploying worker so operators see the new manifest...
call deploy.bat

echo.
echo =====================================================
echo  Engine update published.
echo  Operators will see "Update available" within an hour
echo  (or immediately on Settings ^> Updates ^> Check now).
echo =====================================================
echo.
pause
