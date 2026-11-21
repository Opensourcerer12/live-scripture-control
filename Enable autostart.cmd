@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$l=Join-Path ([Environment]::GetFolderPath('Startup')) 'Live Scripture Control.lnk'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath='%~dp0Start Live Scripture.cmd'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='Live Scripture Control'; $s.Save()"

if errorlevel 1 (
	echo   Could not create the start-up shortcut.
	pause
	exit /b 1
)

echo   Done - Live Scripture Control will start minimised when you log on.
echo   Undo it with Disable autostart.cmd.
echo.
pause
