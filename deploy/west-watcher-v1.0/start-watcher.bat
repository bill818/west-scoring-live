@echo off
rem ============================================================
rem   WEST Scoring Live — Watcher v1.x
rem   Auto-restarts on crash. Close the window to stop.
rem ============================================================

title WEST Scoring Live - Watcher

cd /d "%~dp0"

echo ============================================================
echo   WEST Scoring Live - Watcher
echo   Folder: %~dp0
echo   Close this window to stop.
echo ============================================================
echo.

:loop
echo [%date% %time%] Starting watcher...
echo.
node "%~dp0west-watcher.js"
echo.
echo [%date% %time%] Watcher exited ^(code %errorlevel%^) - restarting in 5 seconds...
echo Press Ctrl+C to stop, or close this window.
echo.
timeout /t 5 /nobreak >nul
goto loop
