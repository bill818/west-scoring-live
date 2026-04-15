@echo off
rem ============================================================
rem   WEST Scoring Live — UDP Funnel
rem   Auto-restarts on crash. Close this window to stop.
rem ============================================================

title WEST Scoring Live - Funnel

cd /d "%~dp0"

echo ============================================================
echo   WEST Scoring Live - UDP Funnel
echo   Folder: %~dp0
echo   Close this window to stop.
echo ============================================================
echo.

:loop
echo [%date% %time%] Starting funnel...
echo.
node "%~dp0west-funnel.js"
echo.
echo [%date% %time%] Funnel exited ^(code %errorlevel%^) - restarting in 5 seconds...
echo Press Ctrl+C to stop, or close this window.
echo.
timeout /t 5 /nobreak >nul
goto loop
