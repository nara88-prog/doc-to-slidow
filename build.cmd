@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  Builds the production app into .\release (unpacked, ready to run).
REM  Uses npm.cmd so it works even when PowerShell blocks npm.ps1.
REM ─────────────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

call npm.cmd run build
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. See the messages above.
  echo.
  pause
  exit /b 1
)

echo.
echo Build finished. Launching the app...
echo.
start "" "release\win-unpacked\Doc to Slides.exe"
exit /b 0
