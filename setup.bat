@echo off
setlocal EnableExtensions
rem ============================================================
rem  DWAPAR  -  one-time setup for Windows
rem  Creates a local Python environment (.venv), installs the
rem  engine, and builds the Drishti dashboard.
rem ============================================================
cd /d "%~dp0"
title DWAPAR setup

echo.
echo   DWAPAR  ^|  An Experiment in Digital Civilization
echo   ------------------------------------------------
echo.

rem --- 1. Find Python 3.10+ -------------------------------------
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [X] Python was not found.
  echo     Install Python 3.10 or newer from https://www.python.org/downloads/
  echo     and tick "Add python.exe to PATH" during installation.
  goto :fail
)
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
if errorlevel 1 (
  echo [X] Python 3.10 or newer is required. Found:
  %PY% --version
  goto :fail
)
for /f "delims=" %%v in ('%PY% --version') do echo [OK] %%v

rem --- 2. Virtual environment + engine --------------------------
if not exist ".venv\Scripts\python.exe" (
  echo [..] Creating virtual environment in .venv
  %PY% -m venv .venv || goto :fail
)
echo [..] Installing the DWAPAR engine and its dependencies
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet || goto :fail
".venv\Scripts\python.exe" -m pip install -e "engine[dev]" --quiet || goto :fail
echo [OK] Engine installed

rem --- 3. Dashboard ---------------------------------------------
where npm >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js / npm was not found.
  echo     Install the LTS version from https://nodejs.org/ then run setup.bat again.
  goto :fail
)
for /f "delims=" %%v in ('node --version') do echo [OK] Node.js %%v
pushd dashboard
echo [..] Installing dashboard packages
call npm install --no-audit --no-fund || (popd & goto :fail)
echo [..] Building the dashboard
call npm run build || (popd & goto :fail)
popd
echo [OK] Dashboard built

echo.
echo   Setup complete.
echo     start.bat           - run the world and open the observatory
echo     start-headless.bat  - run the world without the dashboard
echo.
pause
exit /b 0

:fail
echo.
echo   Setup did not finish. Read the message above, fix it, and run setup.bat again.
echo.
pause
exit /b 1
