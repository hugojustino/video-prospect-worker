@echo off
chcp 65001 >nul
title Instalador Video Prospect Worker
set "DEST=%LOCALAPPDATA%\VideoProspectWorker"
echo Instalando em %DEST% ...
if not exist "%DEST%" mkdir "%DEST%"
xcopy /Y /Q "%~dp0..\*.mjs" "%DEST%\" >nul
xcopy /Y /Q "%~dp0..\package.json" "%DEST%\" >nul
where node >nul 2>nul || (echo ERRO: Node.js nao encontrado. Instale em https://nodejs.org & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo ERRO: FFmpeg nao encontrado no PATH. & pause & exit /b 1)
if not exist "%DEST%\cloudflared.exe" (
  echo Baixando o tunel gratuito da Cloudflare...
  curl -L -o "%DEST%\cloudflared.exe" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe || (echo ERRO no download & pause & exit /b 1)
)
if not exist "%DEST%\config.bat" (
  set /p SEGREDO=Cole a CHAVE SECRETA do worker e aperte Enter: 
)
if not exist "%DEST%\config.bat" (
  > "%DEST%\config.bat" echo set "APP_URL=https://prospect-video-studio.lovable.app"
  >> "%DEST%\config.bat" echo set "WORKER_SHARED_SECRET=%SEGREDO%"
)
> "%DEST%\rodar.bat" echo @echo off
>> "%DEST%\rodar.bat" echo cd /d "%DEST%"
>> "%DEST%\rodar.bat" echo call config.bat
>> "%DEST%\rodar.bat" echo set "PORT=8080"
>> "%DEST%\rodar.bat" echo set "CLOUDFLARED=%DEST%\cloudflared.exe"
>> "%DEST%\rodar.bat" echo :loop
>> "%DEST%\rodar.bat" echo node tunnel.mjs ^>^> worker.log 2^>^&1
>> "%DEST%\rodar.bat" echo timeout /t 10 ^>nul
>> "%DEST%\rodar.bat" echo goto loop
> "%DEST%\oculto.vbs" echo CreateObject("WScript.Shell").Run """%DEST%\rodar.bat""", 0, False
copy /Y "%DEST%\oculto.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\VideoProspectWorker.vbs" >nul
taskkill /F /IM cloudflared.exe >nul 2>nul
wscript "%DEST%\oculto.vbs"
echo.
echo PRONTO! O worker ja esta rodando escondido e vai iniciar sozinho sempre que o Windows ligar.
echo Em 1 minuto o aplicativo mostra o worker como conectado.
pause
