from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path
from typing import Any, Iterable

from .paths import config_path

DEFAULT_PRESETS: dict[str, list[str]] = {
    "anime": [
        "Frieren",
        "One Piece",
        "Jujutsu Kaisen",
        "Chainsaw Man",
        "Mushoku Tensei",
        "Dandadan",
        "Смотрю аниме-марафон",
    ],
    "game": [
        "Genshin Impact",
        "Honkai: Star Rail",
        "Minecraft",
        "Valorant",
        "Elden Ring",
        "Cyberpunk 2077",
        "Прохожу игру",
    ],
    "other": [
        "Just Chatting",
        "Общаюсь с чатом",
        "Слушаю музыку",
        "Рисую",
        "Монтаж видео",
    ],
}

DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "discord": {
        "client_id": "",
        "stream_url": "",
        "poll_interval": 10,
    },
    "server": {
        "name": "Aruku",
        "guild_id": "",
        "invite_url": "",
    },
    "voice": {
        "auto": True,
        "manual_channel_id": "",
        "manual_channel_name": "",
    },
    "media": {
        "title": "",
        "kind": "anime",
        "platform": "Twitch",
    },
    "presence": {
        "enabled": True,
        "show_platform_in_state": True,
        "button_voice": True,
        "button_server": True,
        "large_image": "aruku_voice",
        "large_image_url": "",
        "anime_image": "anime",
        "game_image": "game",
        "other_image": "media",
        "status_display_type": 2,
    },
    "session": {
        "started_at": None,
    },
    "ui": {
        "start_minimized": False,
        "minimize_to_tray": True,
        "autostart": False,
        "tray_gif": "",
    },
    "presets": copy.deepcopy(DEFAULT_PRESETS),
}


def deep_merge(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """Merge incoming into a copy of base, keeping unknown user keys."""
    result = copy.deepcopy(base)
    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _split_path(path: str | Iterable[str]) -> list[str]:
    if isinstance(path, str):
        return [part for part in path.split(".") if part]
    return [str(part) for part in path]


class Config:
    """Thread-safe JSON config with dotted-path access."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path else config_path()
        self._lock = threading.RLock()
        self._data: dict[str, Any] = copy.deepcopy(DEFAULT_CONFIG)
        self.reload()

    def reload(self) -> None:
        with self._lock:
            raw: dict[str, Any] = {}
            if self.path.exists():
                try:
                    loaded = json.loads(self.path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        raw = loaded
                except (OSError, json.JSONDecodeError):
                    # Keep defaults if the file is temporarily unreadable/corrupt.
                    raw = {}
            self._data = deep_merge(DEFAULT_CONFIG, raw)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)

    def get(self, path: str | Iterable[str], default: Any = None) -> Any:
        parts = _split_path(path)
        with self._lock:
            node: Any = self._data
            for part in parts:
                if not isinstance(node, dict) or part not in node:
                    return default
                node = node[part]
            return copy.deepcopy(node)

    def set(self, path: str | Iterable[str], value: Any) -> None:
        parts = _split_path(path)
        if not parts:
            raise ValueError("Config path cannot be empty")
        with self._lock:
            node = self._data
            for part in parts[:-1]:
                child = node.get(part)
                if not isinstance(child, dict):
                    child = {}
                    node[part] = child
                node = child
            node[parts[-1]] = copy.deepcopy(value)

    def update(self, values: dict[str, Any]) -> None:
        with self._lock:
            self._data = deep_merge(self._data, values)

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            payload = json.dumps(self._data, ensure_ascii=False, indent=2)
            tmp.write_text(payload + "\n", encoding="utf-8")
            os.replace(tmp, self.path)

    def ensure_file(self) -> None:
        if not self.path.exists():
            self.save()
