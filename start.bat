@echo off
setlocal EnableExtensions
rem ============================================================
rem  DWAPAR  -  start the world and open the Drishti observatory
rem  Usage:  start.bat [--seed 42] [--size 128] [--speed 24] [--port 8000]
rem  The world keeps running in the "DWAPAR engine" window.
rem  Close that window (or press Ctrl+C in it) to stop; the world
rem  is checkpointed and resumes next time.
rem ============================================================
cd /d "%~dp0"
title DWAPAR

if not exist ".venv\Scripts\python.exe" (
  echo [X] DWAPAR is not set up yet. Run setup.bat first.
  pause
  exit /b 1
)
if not exist "dashboard\dist\index.html" (
  echo [X] The dashboard has not been built. Run setup.bat first.
  pause
  exit /b 1
)

set "PORT=8000"
:parse
if "%~1"=="" goto :run
if /i "%~1"=="--port" set "PORT=%~2"
set "ARGS=%ARGS% %1"
shift
goto :parse

:run
echo   Starting the DWAPAR engine on http://127.0.0.1:%PORT% ...
start "DWAPAR engine" /d "%~dp0engine" "%~dp0.venv\Scripts\python.exe" -m dwapar serve %ARGS%

rem Wait (up to ~60 s) until the observatory answers, then open the browser.
powershell -NoProfile -Command ^
  "$u='http://127.0.0.1:%PORT%/api/status'; for($i=0;$i -lt 120;$i++){ try { Invoke-WebRequest -UseBasicParsing $u -TimeoutSec 1 | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 (
  echo [X] The engine did not respond. Check the "DWAPAR engine" window for errors.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:%PORT%/"
echo   Observatory opened in your browser. The engine runs in the "DWAPAR engine" window.
exit /b 0
