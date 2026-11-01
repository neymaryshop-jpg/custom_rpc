$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    py -3 -m venv .venv
}

& ".venv\Scripts\python.exe" -m pip install --upgrade pip
& ".venv\Scripts\python.exe" -m pip install -r requirements.txt pyinstaller
& ".venv\Scripts\python.exe" "tools\make_assets.py"

& ".venv\Scripts\pyinstaller.exe" `
    --noconfirm `
    --clean `
    --windowed `
    --name "ArukuRPC" `
    --icon "assets\icon.ico" `
    --add-data "assets;assets" `
    --collect-submodules "pystray" `
    --hidden-import "pystray._win32" `
    "app.py"

Write-Host ""
Write-Host "Done: dist\ArukuRPC\ArukuRPC.exe"
