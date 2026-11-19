@echo off
title Video Prospect Worker
echo ====================================================
echo      VIDEO PROSPECT - WORKER LOCAL (WINDOWS)
echo ====================================================
echo.

set APP_URL=https://prospect-video-studio.lovable.app
set WORKER_SHARED_SECRET=bdc1eb84ecc1f759aabb2296e15fd08e0863506c7c368a93
set PORT=8080

echo [OK] Iniciando o servidor na porta 8080...
echo Mantenha esta janela aberta enquanto estiver gerando videos!
echo.
node index.mjs
pause
