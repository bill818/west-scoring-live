@echo off
title WEST Scoring Live — Deploy Worker
echo.
echo Deploying west-worker to Cloudflare...
echo.
cd /d "%~dp0"
wrangler deploy --config wrangler.worker.toml
echo.
echo Done — press any key to close
pause
