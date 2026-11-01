@echo off
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\pythonw.exe" (
  ".venv\Scripts\python.exe" -c "import tkinter, PIL, pystray" >nul 2>nul
  if not errorlevel 1 goto run
  echo Installing missing dependencies...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto setupfailed
  ".venv\Scripts\python.exe" -c "import tkinter, PIL, pystray" >nul 2>nul
  if errorlevel 1 goto notk
  goto run
)

echo Creating virtual environment...
py -3 --version >nul 2>nul
if errorlevel 1 (
  python --version >nul 2>nul
  if errorlevel 1 goto nopython
  set "PYTHON=python"
) else (
  set "PYTHON=py -3"
)

%PYTHON% -m venv .venv
if errorlevel 1 goto setupfailed

".venv\Scripts\python.exe" -c "import tkinter" >nul 2>nul
if errorlevel 1 goto notk

".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto setupfailed

:run
start "" ".venv\Scripts\pythonw.exe" "app.py"
exit /b 0

:nopython
echo.
echo Python 3.10+ was not found. Install it from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH" during installation.
pause
exit /b 1

:notk
echo.
echo This Python installation does not include Tkinter.
echo Reinstall Python from https://www.python.org/downloads/ and enable
echo "tcl/tk and IDLE" in the optional features list.
pause
exit /b 1

:setupfailed
echo.
echo Could not install dependencies. Run "run-console.bat" to see the error.
pause
exit /b 1
