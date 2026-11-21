@echo off
setlocal
title Live Scripture Control
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
	echo.
	echo   Node.js is not installed on this PC.
	echo   Install the LTS build from https://nodejs.org and run this file again.
	echo.
	pause
	exit /b 1
)

rem Already running? Then there is nothing to start - just show the page.
netstat -ano | findstr /r /c:":8099 .*LISTENING" >nul
if not errorlevel 1 (
	echo   Live Scripture Control is already running - opening the page.
	start "" "http://localhost:8099"
	exit /b 0
)

if not exist "node_modules\ws" (
	echo   Installing dependencies ^(first run only^)...
	call npm ci
	if errorlevel 1 (
		echo.
		echo   Could not install dependencies. Check the internet connection and try again.
		echo.
		pause
		exit /b 1
	)
)

echo   Starting Live Scripture Control.
echo   Leave this window open during the service; close it or press Ctrl+C to stop.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:8099'"
node server/index.mjs

echo.
echo   The app has stopped.
pause
