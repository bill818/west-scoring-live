@echo off
rem ============================================================
rem   WEST Scoring Live — Scoring PC Install Script
rem   Run as Administrator on the scoring PC going to the show
rem ============================================================

title WEST Scoring Live - Installer

echo.
echo ============================================================
echo   WEST Scoring Live - Scoring PC Setup
echo ============================================================
echo.
echo This will:
echo   1. Verify Node.js is installed (installs if missing)
echo   2. Create C:\west\ folder
echo   3. Copy west-watcher.js and start-watcher.bat
echo   4. Create a config.json template
echo   5. Remind you to disable sleep on this PC
echo.
pause

rem --- Step 1: Check Node.js ---
echo.
echo [1/5] Checking for Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo *** Node.js NOT FOUND ***
  echo.
  echo Please install Node.js LTS from: https://nodejs.org/
  echo Pick the LTS version, accept all defaults during install.
  echo After install, re-run this script.
  echo.
  echo Opening the Node.js download page now...
  start https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODE_VER=%%v
echo     Node.js found: %NODE_VER%

rem --- Step 2: Create c:\west\ folder ---
echo.
echo [2/5] Creating C:\west\ folder...
if not exist "C:\west" mkdir "C:\west"
echo     Done.

rem --- Step 3: Copy watcher files ---
echo.
echo [3/5] Copying watcher files...
copy /Y "%~dp0west-watcher.js" "C:\west\west-watcher.js" >nul
if %errorlevel% neq 0 (
  echo *** Failed to copy west-watcher.js — is it in the same folder as this installer? ***
  pause
  exit /b 1
)
echo     Copied west-watcher.js

if exist "%~dp0start-watcher.bat" (
  copy /Y "%~dp0start-watcher.bat" "C:\west\start-watcher.bat" >nul
) else (
  rem Build start-watcher.bat inline if not present
  (
    echo @echo off
    echo title WEST Scoring Live - Watcher
    echo echo ============================================
    echo echo   WEST Scoring Live - Watcher
    echo echo   Auto-restarts on crash
    echo echo   Close this window to stop
    echo echo ============================================
    echo echo.
    echo.
    echo :loop
    echo echo [%%date%% %%time%%] Starting watcher...
    echo echo.
    echo node "%%~dp0west-watcher.js"
    echo echo.
    echo echo [%%date%% %%time%%] Watcher exited ^(code %%errorlevel%%^) - restarting in 5 seconds...
    echo echo Press Ctrl+C to stop, or close this window.
    echo echo.
    echo timeout /t 5 /nobreak ^>nul
    echo goto loop
  ) > "C:\west\start-watcher.bat"
)
echo     Copied start-watcher.bat

rem --- Step 4: config.json ---
echo.
echo [4/5] Setting up config.json...
if exist "C:\west\config.json" (
  echo     config.json ALREADY EXISTS - leaving it alone.
  echo     If you need to change settings, edit C:\west\config.json manually.
) else (
  if exist "%~dp0config.json" (
    copy /Y "%~dp0config.json" "C:\west\config.json" >nul
    echo     Copied config.json from installer folder.
  ) else (
    (
      echo {
      echo   "workerUrl": "https://west-worker.bill-acb.workers.dev",
      echo   "authKey": "west-scoring-2026",
      echo   "slug": "CHANGE-ME-TO-SHOW-SLUG"
      echo }
    ) > "C:\west\config.json"
    echo     Created config.json template.
    echo     *** EDIT C:\west\config.json AND SET THE SHOW SLUG BEFORE RUNNING ***
  )
)

rem --- Step 5: Reminders ---
echo.
echo [5/5] IMPORTANT REMINDERS:
echo.
echo     [ ] Set Windows Power Options:
echo         - "Put the computer to sleep" = Never (when plugged in)
echo         - "Turn off hard disk" = Never
echo         - "USB selective suspend" = Disabled
echo.
echo     [ ] Verify C:\west\config.json has the correct:
echo         - slug (matches the show in the admin page)
echo         - authKey (must match the worker's expected key)
echo.
echo     [ ] Start the watcher:
echo         Double-click: C:\west\start-watcher.bat
echo.
echo     [ ] Check that Ryegate's config.dat has the right FTP path:
echo         SHOWS/West/YYYY/ShowName/wkN/ringN
echo         (this auto-detects the ring number)
echo.
echo ============================================================
echo   Install complete.
echo ============================================================
echo.
pause
