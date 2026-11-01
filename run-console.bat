@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run run.bat first to create the environment.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" "app.py" --debug
pause
