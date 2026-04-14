@echo off
rem ============================================================
rem   WEST Scoring Live — Watcher v2.0 (pcap edition)
rem   Self-elevates to Administrator — pcap capture requires it.
rem   Auto-restarts on crash. Close the window to stop.
rem ============================================================

title WEST Scoring Live - Watcher v2.0 (pcap)

rem --- Self-elevate to Administrator ------------------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator privileges ^(required for pcap^)...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

rem --- Verify npcap is present --------------------------------------
if not exist "C:\Windows\System32\Npcap" (
  echo.
  echo *** npcap not found ***
  echo.
  echo Install npcap from https://npcap.com before running the watcher.
  echo Accept the default options during install.
  echo.
  pause
  exit /b 1
)

rem --- Verify node_modules\cap is installed -------------------------
if not exist "%~dp0node_modules\cap" (
  echo.
  echo [setup] cap module not installed — running npm install...
  echo.
  call npm install
  if %errorlevel% neq 0 (
    echo.
    echo *** npm install failed ***
    echo Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo ============================================================
echo   WEST Scoring Live - Watcher v2.0 (pcap)
echo   Elevated: YES   ^|   Folder: %~dp0
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
