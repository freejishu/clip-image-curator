@echo off
title image-curator
cd /d %~dp0
echo Starting image-curator ... data dir: %CD%\data
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:5176"
npx tsx src\server\index.ts 1> server.log 2>&1
pause
