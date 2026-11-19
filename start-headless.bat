@echo off
setlocal EnableExtensions
rem ============================================================
rem  DWAPAR  -  run the world without the dashboard
rem  Usage:  start-headless.bat [--days N] [--speed 0] [--seed 42]
rem    --speed 0   as fast as the computer allows (default here)
rem    --days N    stop after N simulated days (default: run until closed)
rem  Press Ctrl+C to stop. The world is checkpointed and resumes next time.
rem  Long experiments:  start-headless.bat experiment --budget-minutes 60
rem ============================================================
cd /d "%~dp0"
title DWAPAR (headless)

if not exist ".venv\Scripts\python.exe" (
  echo [X] DWAPAR is not set up yet. Run setup.bat first.
  pause
  exit /b 1
)
pushd engine
if /i "%~1"=="experiment" (
  "%~dp0.venv\Scripts\python.exe" -m dwapar %*
) else (
  "%~dp0.venv\Scripts\python.exe" -m dwapar run --speed 0 %*
)
popd
echo.
echo   DWAPAR stopped. Latest state is saved in data\dwapar.sqlite
pause
