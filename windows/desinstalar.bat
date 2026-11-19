@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\VideoProspectWorker.vbs" 2>nul
taskkill /F /IM cloudflared.exe >nul 2>nul
wmic process where "commandline like '%%VideoProspectWorker%%'" call terminate >nul 2>nul
echo Inicializacao automatica removida.
pause
