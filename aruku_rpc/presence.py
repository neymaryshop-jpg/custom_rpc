from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .config import Config
from .discord_ipc import DiscordIPC, DiscordIPCError
from .timeutil import (
    elapsed_seconds,
    format_elapsed,
    now_local,
    parse_iso,
    to_iso,
    truncate,
)


@dataclass
class VoiceInfo:
    channel_id: str | None = None
    channel_name: str | None = None
    guild_id: str | None = None
    guild_name: str | None = None
    source: str = "fallback"


class PresenceService:
    """Owns the Discord IPC connection and the presence update loop."""

    def __init__(self, config: Config, logger: logging.Logger | None = None) -> None:
        self.config = config
        self.log = logger or logging.getLogger("aruku.presence")
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

        self._ipc: DiscordIPC | None = None
        self._client_id: str | None = None
        self._connected = False
        self._discord_user = ""

        self._voice = VoiceInfo()
        self._guild_names: dict[str, str | None] = {}
        self._voice_auto_error = ""

        self._last_activity_json: str | None = None
        self._last_sent_at = 0.0
        self._activity_sent = False

        cfg = self.config.snapshot()
        self._session_start = parse_iso(cfg.get("session", {}).get("started_at"))
        self._enabled = bool(cfg.get("presence", {}).get("enabled", True))
        self._status = "Запуск…"
        self._error = ""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="aruku-presence", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=4)
        self._clear_presence()
        self._disconnect()
        self._set_status("Остановлено")

    def wake(self) -> None:
        self._wake.set()

    def reload(self) -> None:
        cfg = self.config.snapshot()
        with self._lock:
            self._enabled = bool(cfg.get("presence", {}).get("enabled", True))
            self._session_start = parse_iso(cfg.get("session", {}).get("started_at"))
            client_id = str(cfg.get("discord", {}).get("client_id", "")).strip()
            if self._client_id and client_id != self._client_id:
                self._disconnect()
            self._last_activity_json = None
        self.wake()

    def start_session(self, title: str, kind: str, platform: str) -> None:
        started = now_local()
        with self._lock:
            self.config.set("media.title", title)
            self.config.set("media.kind", kind)
            self.config.set("media.platform", platform)
            self.config.set("session.started_at", to_iso(started))
            self.config.save()
            self._session_start = started
            self._last_activity_json = None
        self.wake()

    def stop_session(self) -> None:
        with self._lock:
            self._session_start = None
            self.config.set("session.started_at", None)
            self.config.save()
        self.wake()

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            self._enabled = bool(enabled)
            self.config.set("presence.enabled", bool(enabled))
            self.config.save()
        self.wake()

    def refresh_voice_now(self) -> None:
        self.wake()

    def snapshot(self) -> dict[str, Any]:
        cfg = self.config.snapshot()
        with self._lock:
            started = self._session_start
            voice = self._voice
            location = self._location_text(voice, cfg)
            voice_url = self._voice_url(voice, cfg)
            media = cfg.get("media", {})
            started_iso = to_iso(started)
            elapsed = elapsed_seconds(started)
            return {
                "connected": self._connected,
                "discord_user": self._discord_user,
                "status": self._status,
                "error": self._error,
                "enabled": self._enabled,
                "active": started is not None,
                "started_at": started_iso,
                "elapsed": format_elapsed(elapsed),
                "elapsed_seconds": elapsed,
                "location": location,
                "voice_url": voice_url,
                "voice_source": voice.source,
                "voice_auto_error": self._voice_auto_error,
                "voice_name": voice.channel_name or "",
                "guild_name": voice.guild_name or "",
                "media": {
                    "title": str(media.get("title") or ""),
                    "kind": str(media.get("kind") or "anime"),
                    "platform": str(media.get("platform") or ""),
                },
                "client_id_configured": bool(
                    str(cfg.get("discord", {}).get("client_id", "")).strip()
                ),
                "auto_voice": bool(cfg.get("voice", {}).get("auto", True)),
                "server_name": str(cfg.get("server", {}).get("name") or "Aruku"),
            }

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------
    def _loop(self) -> None:
        while not self._stop.is_set():
            timeout = 5.0
            try:
                self._tick()
                poll = int(self.config.get("discord.poll_interval", 10) or 10)
                timeout = max(3.0, min(60.0, float(poll)))
            except Exception as exc:  # noqa: BLE001 - keep the tray app alive
                self.log.exception("Presence loop error")
                self._set_status("Ошибка", str(exc))
                self._disconnect()
                timeout = 5.0
            self._wake.wait(timeout)
            self._wake.clear()

    def _tick(self) -> None:
        cfg = self.config.snapshot()
        client_id = str(cfg.get("discord", {}).get("client_id", "")).strip()
        if not client_id:
            self._clear_presence()
            self._disconnect()
            self._set_status(
                "Нужен Client ID",
                "Создай приложение в Discord Developer Portal и вставь Application ID в настройках.",
            )
            return

        if not self._enabled:
            self._clear_presence()
            self._set_status("RPC выключен")
            return

        self._ensure_connected(client_id)
        self._refresh_voice(cfg)

        with self._lock:
            started = self._session_start
        if started is None:
            self._clear_presence()
            self._set_status("Не в эфире")
            return

        activity = self._build_activity(cfg, started)
        activity_json = json.dumps(activity, sort_keys=True, ensure_ascii=False)
        now = time.monotonic()
        if (
            activity_json != self._last_activity_json
            or now - self._last_sent_at > 60
            or not self._activity_sent
        ):
            assert self._ipc is not None
            self._ipc.set_activity(activity)
            self._last_activity_json = activity_json
            self._last_sent_at = now
            self._activity_sent = True
        self._set_status("В эфире")

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------
    def _ensure_connected(self, client_id: str) -> None:
        with self._lock:
            if (
                self._ipc is not None
                and self._ipc.is_connected
                and self._client_id == client_id
            ):
                return
            self._disconnect()
            ipc = DiscordIPC(client_id, self.log)
            ipc.connect()
            self._ipc = ipc
            self._client_id = client_id
            self._connected = True
            self._activity_sent = False
            self._last_activity_json = None
            user = ipc.user or {}
            self._discord_user = str(user.get("username") or "")
            self._guild_names.clear()
            self._voice_auto_error = ""

    def _disconnect(self) -> None:
        with self._lock:
            ipc = self._ipc
            self._ipc = None
            self._connected = False
            self._activity_sent = False
            self._last_activity_json = None
            self._client_id = None
        if ipc is not None:
            try:
                ipc.close()
            except Exception:
                self.log.debug("IPC close failed", exc_info=True)

    def _clear_presence(self) -> None:
        with self._lock:
            ipc = self._ipc
            should_clear = self._activity_sent and ipc is not None and ipc.is_connected
        if not should_clear:
            return
        try:
            assert ipc is not None
            ipc.clear_activity()
            with self._lock:
                self._activity_sent = False
                self._last_activity_json = None
        except Exception:
            self.log.debug("Could not clear presence", exc_info=True)
            self._disconnect()

    # ------------------------------------------------------------------
    # Voice
    # ------------------------------------------------------------------
    def _refresh_voice(self, cfg: dict[str, Any]) -> None:
        auto = bool(cfg.get("voice", {}).get("auto", True))
        manual_id = str(cfg.get("voice", {}).get("manual_channel_id", "")).strip()
        manual_name = str(cfg.get("voice", {}).get("manual_channel_name", "")).strip()
        server_name = str(cfg.get("server", {}).get("name", "") or "Aruku").strip()
        guild_id = str(cfg.get("server", {}).get("guild_id", "")).strip()

        voice: VoiceInfo | None = None
        auto_error = ""

        if auto and self._ipc is not None and self._ipc.is_connected:
            try:
                data = self._ipc.get_selected_voice_channel()
                if data:
                    channel_id = str(data.get("id") or "")
                    channel_name = str(data.get("name") or "Voice")
                    voice_guild_id = str(data.get("guild_id") or "")
                    guild_name = self._resolve_guild_name(voice_guild_id)
                    voice = VoiceInfo(
                        channel_id=channel_id or None,
                        channel_name=channel_name,
                        guild_id=voice_guild_id or None,
                        guild_name=guild_name,
                        source="auto",
                    )
            except DiscordIPCError as exc:
                if exc.code in (4006, 4007):
                    auto_error = (
                        "Discord не отдал текущий войс без OAuth. "
                        "Включи ручной войс в настройках или укажи канал вручную."
                    )
                    self.log.warning("Auto voice unavailable: %s", exc)
                else:
                    raise

        if voice is None and (manual_id or manual_name):
            voice = VoiceInfo(
                channel_id=manual_id or None,
                channel_name=manual_name or ("Voice" if manual_id else None),
                guild_id=guild_id or None,
                guild_name=server_name or None,
                source="manual",
            )
        if voice is None:
            voice = VoiceInfo(source="fallback")

        with self._lock:
            self._voice = voice
            self._voice_auto_error = auto_error

    def _resolve_guild_name(self, guild_id: str) -> str | None:
        if not guild_id:
            return None
        with self._lock:
            if guild_id in self._guild_names:
                return self._guild_names[guild_id]
        name: str | None = None
        if self._ipc is not None and self._ipc.is_connected:
            try:
                guild = self._ipc.get_guild(guild_id)
                if guild:
                    name = str(guild.get("name") or "") or None
            except Exception:
                self.log.debug("Could not fetch guild %s", guild_id, exc_info=True)
        with self._lock:
            self._guild_names[guild_id] = name
        return name

    def _location_text(self, voice: VoiceInfo, cfg: dict[str, Any]) -> str:
        server_name = str(cfg.get("server", {}).get("name", "") or "Aruku").strip() or "Aruku"
        # A manually configured channel name is useful even without a channel ID
        # (for example when the user only wants the label, not a clickable link).
        if voice.channel_name:
            guild_name = voice.guild_name or server_name
            return truncate(f"{guild_name} / {voice.channel_name}")
        if voice.channel_id:
            return truncate(f"{server_name} / Voice")
        return truncate(f"{server_name}/[Voice]")

    def _voice_url(self, voice: VoiceInfo, cfg: dict[str, Any]) -> str:
        if not voice.channel_id:
            return ""
        guild_id = voice.guild_id or str(cfg.get("server", {}).get("guild_id", "")).strip()
        if not guild_id:
            return ""
        return f"https://discord.com/channels/{guild_id}/{voice.channel_id}"

    # ------------------------------------------------------------------
    # Activity
    # ------------------------------------------------------------------
    def _build_activity(self, cfg: dict[str, Any], started: datetime) -> dict[str, Any]:
        media = cfg.get("media", {})
        presence = cfg.get("presence", {})
        title = str(media.get("title") or "").strip() or "Без названия"
        kind = str(media.get("kind") or "anime").lower()
        platform = str(media.get("platform") or "").strip()
        verb = {
            "anime": "Смотрю аниме",
            "game": "Играю в",
            "other": "Показываю",
        }.get(kind, "Показываю")

        state = f"{verb} • {title}"
        if platform and bool(presence.get("show_platform_in_state", True)):
            state = f"{state} • {platform}"

        with self._lock:
            voice = self._voice
        location = self._location_text(voice, cfg)
        voice_url = self._voice_url(voice, cfg)

        activity: dict[str, Any] = {
            "type": 3 if kind in ("anime", "other") else 0,
            "details": truncate(location),
            "state": truncate(state),
            "timestamps": {"start": int(started.timestamp() * 1000)},
            "instance": True,
        }

        assets: dict[str, Any] = {}
        large_url = str(presence.get("large_image_url") or "").strip()
        large_key = str(presence.get("large_image") or "").strip()
        if large_url.startswith(("https://", "http://")):
            # A direct image URL (including a GIF) works as an external asset.
            assets["large_image"] = large_url
        elif large_key:
            assets["large_image"] = large_key
        if assets.get("large_image"):
            assets["large_text"] = truncate(location)
            if voice_url:
                assets["large_url"] = voice_url

        small_key = str(
            presence.get(
                {
                    "anime": "anime_image",
                    "game": "game_image",
                    "other": "other_image",
                }.get(kind, "other_image"),
                "",
            )
            or ""
        ).strip()
        if small_key:
            assets["small_image"] = small_key
            small_text = "Медиа-креатор"
            if platform:
                small_text = f"{small_text} • {platform}"
            assets["small_text"] = truncate(small_text)

        if assets:
            activity["assets"] = assets

        stream_url = str(cfg.get("discord", {}).get("stream_url", "")).strip()
        if stream_url.startswith(("https://", "http://")):
            activity["state_url"] = stream_url
            if assets:
                assets["small_url"] = stream_url

        if voice_url:
            activity["details_url"] = voice_url

        buttons: list[dict[str, str]] = []
        if voice_url and bool(presence.get("button_voice", True)):
            buttons.append({"label": "🎧 Войти в войс", "url": voice_url})

        server_url = str(cfg.get("server", {}).get("invite_url", "")).strip()
        guild_id = str(cfg.get("server", {}).get("guild_id", "")).strip()
        if not server_url and guild_id:
            server_url = f"https://discord.com/channels/{guild_id}"
        if server_url.startswith(("https://", "http://")) and bool(
            presence.get("button_server", True)
        ):
            label = truncate(str(cfg.get("server", {}).get("name") or "Aruku"), 32)
            buttons.append({"label": label, "url": server_url})
        if buttons:
            activity["buttons"] = buttons[:2]

        display_type = presence.get("status_display_type", 2)
        if display_type in (0, 1, 2):
            activity["status_display_type"] = int(display_type)

        return activity

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------
    def _set_status(self, status: str, error: str = "") -> None:
        with self._lock:
            self._status = status
            self._error = error
