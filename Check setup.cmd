@echo off
setlocal
title Live Scripture Control - setup check
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
	echo   Node.js is not installed on this PC. Install the LTS build from https://nodejs.org first.
	pause
	exit /b 1
)

node scripts\doctor.mjs
echo.
pause
