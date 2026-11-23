@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  Starts the app in development mode (Vite dev server + Electron).
REM  Uses npm.cmd so it works even when PowerShell blocks npm.ps1.
REM  Double-click this file, or run it from any terminal.
REM ─────────────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js / npm was not found on this machine.
  echo         Install Node.js 18+ from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo Installing dependencies for the first time...
  call npm.cmd install || goto :fail
)

call npm.cmd run dev
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo [ERROR] The app could not start. The messages above explain why.
echo.
pause
exit /b 1
