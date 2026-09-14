@echo off
title image-curator
cd /d %~dp0
rem 本机系统 Node 是 16，跑不了 node:sqlite，优先使用项目自带的便携 Node 22
if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
echo Starting image-curator ... data dir: %CD%\data
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:30041"
npx tsx src\server\index.ts 1> server.log 2>&1
pause
