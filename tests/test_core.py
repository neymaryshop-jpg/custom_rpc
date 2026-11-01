from __future__ import annotations

import json
import socket
import struct
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aruku_rpc.config import Config
from aruku_rpc.discord_ipc import DiscordIPC
from aruku_rpc.presence import PresenceService, VoiceInfo
from aruku_rpc.timeutil import format_elapsed, format_clock, truncate


class ConfigTests(unittest.TestCase):
    def test_dotted_paths_and_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            cfg = Config(path)
            cfg.set("discord.client_id", "123")
            cfg.set("presets.anime", ["Frieren"])
            cfg.save()

            loaded = Config(path)
            self.assertEqual(loaded.get("discord.client_id"), "123")
            self.assertEqual(loaded.get("presets.anime"), ["Frieren"])
            self.assertEqual(loaded.get("server.name"), "Aruku")

    def test_unknown_keys_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"custom": {"x": 1}}), encoding="utf-8")
            cfg = Config(path)
            self.assertEqual(cfg.get("custom.x"), 1)


class TimeTests(unittest.TestCase):
    def test_format_elapsed(self) -> None:
        self.assertEqual(format_elapsed(0), "0m")
        self.assertEqual(format_elapsed(59), "0m")
        self.assertEqual(format_elapsed(60), "1m")
        self.assertEqual(format_elapsed(3600), "1h 0m")
        self.assertEqual(format_elapsed(3600 + 14 * 60 + 30), "1h 14m")
        self.assertEqual(format_elapsed(2 * 3600 + 14 * 60), "2h 14m")

    def test_truncate(self) -> None:
        self.assertEqual(truncate("abc", 3), "abc")
        self.assertTrue(truncate("abcdef", 4).endswith("…"))


class ActivityTests(unittest.TestCase):
    def make_service(self) -> PresenceService:
        cfg = Config(Path(tempfile.mkdtemp()) / "config.json")
        cfg.set("server.name", "Aruku")
        cfg.set("server.guild_id", "999")
        cfg.set("server.invite_url", "https://discord.gg/aruku")
        cfg.set("media.title", "Frieren")
        cfg.set("media.kind", "anime")
        cfg.set("media.platform", "Twitch")
        cfg.set("presence.large_image_url", "https://example.com/pin.gif")
        cfg.set("presence.anime_image", "anime")
        cfg.set("discord.stream_url", "https://twitch.tv/aruku")
        service = PresenceService(cfg)
        service._voice = VoiceInfo(
            channel_id="111",
            channel_name="General",
            guild_id="999",
            guild_name="Aruku",
            source="auto",
        )
        service._session_start = datetime.now(timezone.utc) - timedelta(hours=2, minutes=14)
        return service

    def test_activity_contains_location_media_timer_links(self) -> None:
        service = self.make_service()
        activity = service._build_activity(service.config.snapshot(), service._session_start)
        self.assertEqual(activity["details"], "Aruku / General")
        self.assertEqual(activity["state"], "Смотрю аниме • Frieren • Twitch")
        self.assertEqual(activity["type"], 3)
        self.assertIn("timestamps", activity)
        self.assertEqual(
            activity["assets"]["large_image"], "https://example.com/pin.gif"
        )
        self.assertEqual(activity["assets"]["small_image"], "anime")
        self.assertEqual(activity["details_url"], "https://discord.com/channels/999/111")
        self.assertEqual(activity["state_url"], "https://twitch.tv/aruku")
        self.assertEqual(len(activity["buttons"]), 2)
        self.assertEqual(activity["buttons"][0]["url"], "https://discord.com/channels/999/111")

    def test_fallback_location(self) -> None:
        service = self.make_service()
        service._voice = VoiceInfo(source="fallback")
        activity = service._build_activity(service.config.snapshot(), service._session_start)
        self.assertEqual(activity["details"], "Aruku/[Voice]")
        self.assertNotIn("details_url", activity)
        self.assertEqual(len(activity["buttons"]), 1)  # server button only

    def test_manual_channel_name_without_id_is_visible(self) -> None:
        service = self.make_service()
        service._voice = VoiceInfo(channel_name="General", source="manual")
        activity = service._build_activity(service.config.snapshot(), service._session_start)
        self.assertEqual(activity["details"], "Aruku / General")
        self.assertNotIn("details_url", activity)
        self.assertEqual(len(activity["buttons"]), 1)

    def test_snapshot_elapsed(self) -> None:
        service = self.make_service()
        snap = service.snapshot()
        self.assertTrue(snap["active"])
        self.assertEqual(snap["elapsed"], "2h 14m")
        self.assertEqual(snap["location"], "Aruku / General")


class IPCTests(unittest.TestCase):
    def test_frame_roundtrip(self) -> None:
        left, right = socket.socketpair()
        try:
            ipc = DiscordIPC("123")
            ipc._conn = left
            ipc._send_frame(1, {"cmd": "TEST", "args": {}, "nonce": "n"})
            header = right.recv(8)
            opcode, length = struct.unpack("<II", header)
            self.assertEqual(opcode, 1)
            payload = json.loads(right.recv(length).decode("utf-8"))
            self.assertEqual(payload["cmd"], "TEST")
        finally:
            left.close()
            right.close()


if __name__ == "__main__":
    unittest.main()
