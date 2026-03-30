@echo off
title WEST Scoring Live — Deploy Worker
echo.
echo Deploying west-worker to Cloudflare...
echo.
cd /d "%~dp0"
wrangler deploy west-worker.js --name west-worker --compatibility-date 2024-01-01
echo.
echo Done — press any key to close
pause
