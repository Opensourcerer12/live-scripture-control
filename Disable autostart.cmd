@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$l=Join-Path ([Environment]::GetFolderPath('Startup')) 'Live Scripture Control.lnk'; if (Test-Path $l) { Remove-Item $l; 'removed' } else { 'not there' }"

echo.
pause
