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
copy /Y *.html            _pages_dist\ >nul
copy /Y display-config.js _pages_dist\ >nul
copy /Y robots.txt        _pages_dist\ >nul 2>&1
xcopy /E /I /Y /Q assets _pages_dist\assets >nul 2>&1

echo.
echo Deploying to preview.westscoring.pages.dev ...
call npx wrangler pages deploy _pages_dist --project-name=westscoring --branch=preview --commit-dirty=true

echo.
echo Cleaning staging folder...
rmdir /s /q _pages_dist

echo.
echo Done. Preview URL: https://preview.westscoring.pages.dev
pause
