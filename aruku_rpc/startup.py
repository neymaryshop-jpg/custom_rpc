from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "ArukuRPC"


def _command() -> str:
    if getattr(sys, "frozen", False):
        args = [sys.executable, "--minimized"]
    else:
        python = Path(sys.executable)
        pythonw = python.with_name("pythonw.exe")
        if pythonw.exists():
            python = pythonw
        app = Path(__file__).resolve().parent.parent / "app.py"
        args = [str(python), str(app), "--minimized"]
    return subprocess.list2cmdline(args)


def is_autostart_enabled() -> bool:
    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, VALUE_NAME)
            return bool(value)
    except OSError:
        return False


def set_autostart(enabled: bool) -> bool:
    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE
        ) as key:
            if enabled:
                winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, _command())
            else:
                try:
                    winreg.DeleteValue(key, VALUE_NAME)
                except FileNotFoundError:
                    pass
        return True
    except OSError:
        return False
