@echo off
rem ============================================================
rem   WEST Scoring Live — Deploy frontend to PREVIEW branch
rem   Does NOT touch westscoring.live (that's production branch)
rem ============================================================

title WEST Scoring Live - Pages Preview Deploy

setlocal
cd /d "%~dp0"

echo.
echo Staging frontend files...
if exist _pages_dist rmdir /s /q _pages_dist
mkdir _pages_dist
copy /Y robots.txt        _pages_dist\ >nul 2>&1
xcopy /E /I /Y /Q assets _pages_dist\assets >nul 2>&1

rem v3 is now THE site — pages served at root, no /v3/ URL prefix.
rem v2 .html files at the repo root are kept as design references but
rem not deployed. v3 page references like "../js/west-foo.js" resolve
rem from a root-level page to "/js/west-foo.js" via standard URL
rem normalization, so v3/js gets staged at /js/.
xcopy /E /I /Y /Q v3\pages _pages_dist          >nul 2>&1
xcopy /E /I /Y /Q v3\js    _pages_dist\js       >nul 2>&1

rem Engine asar releases — served at /engine/<version>.asar for the in-app updater
if exist v3\engine\dist\release-asar\*.asar (
  mkdir _pages_dist\engine 2>nul
  xcopy /Y /Q v3\engine\dist\release-asar\*.asar _pages_dist\engine\ >nul
  echo Engine asar releases staged for upload.
)

echo.
rem Project name + output dir come from wrangler.toml (the Pages config).
rem The Worker uses wrangler.worker.toml — see deploy.bat.
echo Deploying to preview.westscoring.pages.dev ...
call npx wrangler pages deploy --branch=preview --commit-dirty=true

echo.
echo Cleaning staging folder...
rmdir /s /q _pages_dist

echo.
echo Done. Preview URL: https://preview.westscoring.pages.dev
pause
