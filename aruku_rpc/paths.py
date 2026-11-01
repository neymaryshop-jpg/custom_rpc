from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "ArukuRPC"
APP_DIR_NAME = "ArukuRPC"


def app_data_dir() -> Path:
    """Return a per-user directory for config, logs and downloaded assets."""
    override = os.environ.get("ARUKU_RPC_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()

    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    return base / APP_DIR_NAME


def config_path() -> Path:
    override = os.environ.get("ARUKU_RPC_CONFIG")
    if override:
        return Path(override).expanduser().resolve()
    return app_data_dir() / "config.json"


def log_path() -> Path:
    return app_data_dir() / "logs" / "aruku-rpc.log"


def user_asset_path(name: str) -> Path:
    return app_data_dir() / "assets" / name


def project_root() -> Path:
    """Root of the source tree (or the PyInstaller extraction dir)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def asset_path(name: str) -> Path:
    """Path to a bundled asset."""
    return project_root() / "assets" / name


def tray_gif_path(configured: str | None = None) -> Path:
    """Use a user-selected GIF when present, otherwise the bundled one."""
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.exists():
            return candidate
    return asset_path("location.gif")
