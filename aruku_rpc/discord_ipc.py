from __future__ import annotations

import json
import logging
import os
import socket
import struct
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, BinaryIO

OP_HANDSHAKE = 0
OP_FRAME = 1
OP_CLOSE = 2
OP_PING = 3
OP_PONG = 4

MAX_FRAME_SIZE = 4 * 1024 * 1024


class DiscordIPCError(RuntimeError):
    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.code = code


class DiscordIPC:
    """Minimal Discord local-RPC client.

    It speaks the documented IPC protocol directly, which lets us use both
    SET_ACTIVITY and GET_SELECTED_VOICE_CHANNEL without a third-party RPC
    wrapper.
    """

    def __init__(self, client_id: str, logger: logging.Logger | None = None) -> None:
        self.client_id = str(client_id).strip()
        self.log = logger or logging.getLogger("aruku.ipc")
        self.user: dict[str, Any] | None = None
        self._lock = threading.RLock()
        self._conn: BinaryIO | socket.socket | None = None
        self._path: str | None = None

    @property
    def is_connected(self) -> bool:
        return self._conn is not None

    def connect(self) -> None:
        if not self.client_id:
            raise DiscordIPCError("Не указан Discord Client ID")
        with self._lock:
            if self._conn is not None:
                return
            conn, path = self._open_connection()
            self._conn = conn
            self._path = path
            try:
                self._send_frame(OP_HANDSHAKE, {"v": 1, "client_id": self.client_id})
                op, payload = self._read_frame()
                if op == OP_CLOSE:
                    raise DiscordIPCError("Discord закрыл RPC-соединение")
                if op != OP_FRAME:
                    raise DiscordIPCError(f"Неожиданный ответ Discord RPC (opcode {op})")
                if payload.get("evt") == "ERROR":
                    data = payload.get("data") or {}
                    raise DiscordIPCError(
                        str(data.get("message") or "Ошибка рукопожатия Discord RPC"),
                        int(data.get("code")) if data.get("code") is not None else None,
                    )
                if payload.get("evt") != "READY":
                    raise DiscordIPCError("Discord RPC не прислал READY")
                data = payload.get("data") or {}
                self.user = data.get("user")
                self.log.info("Discord RPC connected via %s", path)
            except Exception:
                self.close()
                raise

    def close(self) -> None:
        with self._lock:
            conn = self._conn
            self._conn = None
            if conn is None:
                return
            try:
                self._send_frame_to(conn, OP_CLOSE, {"v": 1, "client_id": self.client_id})
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
            self.log.info("Discord RPC disconnected")

    def request(self, cmd: str, args: dict[str, Any] | None = None) -> Any:
        with self._lock:
            if self._conn is None:
                raise DiscordIPCError("Нет соединения с Discord RPC")
            nonce = str(uuid.uuid4())
            self._send_frame(
                OP_FRAME,
                {"cmd": cmd, "args": args or {}, "nonce": nonce},
            )
            while True:
                op, payload = self._read_frame()
                if op == OP_PING:
                    self._send_frame(OP_PONG, payload if isinstance(payload, dict) else {})
                    continue
                if op == OP_CLOSE:
                    self.close()
                    raise DiscordIPCError("Discord закрыл RPC-соединение")
                if op != OP_FRAME:
                    continue
                if payload.get("nonce") != nonce:
                    # Other events (VOICE_CHANNEL_SELECT etc.) are harmless here.
                    continue
                if payload.get("evt") == "ERROR":
                    data = payload.get("data") or {}
                    code = data.get("code")
                    raise DiscordIPCError(
                        str(data.get("message") or f"Discord RPC error in {cmd}"),
                        int(code) if code is not None else None,
                    )
                return payload.get("data")

    def set_activity(self, activity: dict[str, Any] | None) -> Any:
        args: dict[str, Any] = {"pid": os.getpid()}
        if activity is not None:
            args["activity"] = activity
        return self.request("SET_ACTIVITY", args)

    def clear_activity(self) -> Any:
        return self.set_activity(None)

    def get_selected_voice_channel(self) -> dict[str, Any] | None:
        data = self.request("GET_SELECTED_VOICE_CHANNEL", {})
        return data if isinstance(data, dict) else None

    def get_guild(self, guild_id: str) -> dict[str, Any] | None:
        data = self.request("GET_GUILD", {"guild_id": str(guild_id)})
        return data if isinstance(data, dict) else None

    # ------------------------------------------------------------------
    # Transport helpers
    # ------------------------------------------------------------------
    def _open_connection(self) -> tuple[BinaryIO | socket.socket, str]:
        if os.name == "nt":
            last_error: Exception | None = None
            for path in _windows_pipe_paths():
                try:
                    conn = open(path, "r+b", buffering=0)
                    return conn, path
                except OSError as exc:
                    last_error = exc
            raise DiscordIPCError(
                "Discord не запущен или RPC-канал недоступен. Запусти Discord для Windows."
            ) from last_error

        last_error = None
        for path in _unix_socket_paths():
            if not path.exists():
                continue
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(10.0)
            try:
                sock.connect(str(path))
                return sock, str(path)
            except OSError as exc:
                last_error = exc
                try:
                    sock.close()
                except Exception:
                    pass
        raise DiscordIPCError(
            "Discord не запущен или RPC-канал недоступен. Запусти Discord."
        ) from last_error

    def _send_frame(self, opcode: int, payload: dict[str, Any]) -> None:
        if self._conn is None:
            raise DiscordIPCError("Нет соединения с Discord RPC")
        self._send_frame_to(self._conn, opcode, payload)

    @staticmethod
    def _send_frame_to(conn: BinaryIO | socket.socket, opcode: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        frame = struct.pack("<II", opcode, len(body)) + body
        if isinstance(conn, socket.socket):
            conn.sendall(frame)
        else:
            conn.write(frame)
            conn.flush()

    def _read_frame(self) -> tuple[int, Any]:
        if self._conn is None:
            raise DiscordIPCError("Нет соединения с Discord RPC")
        header = self._read_exact(8)
        opcode, length = struct.unpack("<II", header)
        if length > MAX_FRAME_SIZE:
            self.close()
            raise DiscordIPCError("Слишком большой кадр от Discord RPC")
        body = self._read_exact(length) if length else b""
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self.close()
            raise DiscordIPCError("Некорректный JSON от Discord RPC") from exc
        return opcode, payload

    def _read_exact(self, size: int) -> bytes:
        if self._conn is None:
            raise DiscordIPCError("Нет соединения с Discord RPC")
        chunks: list[bytes] = []
        remaining = size
        while remaining > 0:
            try:
                if isinstance(self._conn, socket.socket):
                    chunk = self._conn.recv(remaining)
                else:
                    chunk = self._conn.read(remaining)
            except (OSError, TimeoutError) as exc:
                self.close()
                raise DiscordIPCError("Соединение с Discord RPC потеряно") from exc
            if not chunk:
                self.close()
                raise DiscordIPCError("Discord закрыл RPC-соединение")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)


def _windows_pipe_paths() -> list[str]:
    # Both spellings are used in the wild; try the common one first.
    paths: list[str] = []
    for base in (r"\\.\pipe", r"\\?\pipe"):
        for index in range(10):
            paths.append(f"{base}\\discord-ipc-{index}")
    return paths


def _unix_socket_paths() -> list[Path]:
    candidates: list[Path] = []
    for env_name in ("XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"):
        value = os.environ.get(env_name)
        if value:
            candidates.append(Path(value))
    candidates.append(Path("/tmp"))

    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        base = Path(runtime)
        candidates.extend(
            [
                base / "app" / "com.discordapp.Discord",
                base / "app" / "com.discordapp.DiscordCanary",
                base / "snap.discord",
                base / "snap.discord-canary",
            ]
        )

    seen: set[str] = set()
    paths: list[Path] = []
    for directory in candidates:
        for index in range(10):
            path = directory / f"discord-ipc-{index}"
            key = str(path)
            if key not in seen:
                seen.add(key)
                paths.append(path)
    return paths
