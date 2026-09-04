@echo off
chcp 65001 >nul
title image-curator
cd /d %~dp0
echo 启动 image-curator... 数据目录: %CD%\data
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:5176"
npx tsx src\server\index.ts
pause
