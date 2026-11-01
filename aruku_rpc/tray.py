from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable

from .config import Config
from .paths import asset_path, tray_gif_path
from .presence import PresenceService
from .timeutil import truncate

try:  # Optional: the window still works without a tray.
    import pystray
    from PIL import Image, ImageDraw, ImageSequence
except Exception:  # pragma: no cover - depends on optional packages
    pystray = None
    Image = None
    ImageDraw = None
    ImageSequence = None


class TrayIcon:
    def __init__(
        self,
        config: Config,
        service: PresenceService,
        on_open: Callable[[], None],
        on_quit: Callable[[], None],
        logger: logging.Logger | None = None,
        on_settings: Callable[[], None] | None = None,
        on_toggle_session: Callable[[], None] | None = None,
    ) -> None:
        self.config = config
        self.service = service
        self.on_open = on_open
        self.on_quit = on_quit
        self.on_settings = on_settings or on_open
        self.on_toggle_session = on_toggle_session or self._toggle_session
        self.log = logger or logging.getLogger("aruku.tray")

        self._icon = None
        self._thread: threading.Thread | None = None
        self._anim_thread: threading.Thread | None = None
        self._anim_stop = threading.Event()
        self._stop = threading.Event()
        self._frames: list[tuple[object, float]] = []
        self._lock = threading.RLock()

    @property
    def available(self) -> bool:
        return pystray is not None and Image is not None

    def start(self) -> bool:
        if not self.available:
            self.log.warning("pystray/Pillow not installed; tray disabled")
            return False
        with self._lock:
            self._load_frames()
            image = self._frames[0][0] if self._frames else self._fallback_image()
            menu = pystray.Menu(
                pystray.MenuItem("Открыть Aruku RPC", lambda: self.on_open(), default=True),
                pystray.MenuItem(lambda item: self._status_text(), lambda: None, enabled=False),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem(
                    lambda item: "Завершить эфир"
                    if self.service.snapshot().get("active")
                    else "Начать эфир",
                    lambda: self.on_toggle_session(),
                ),
                pystray.MenuItem("Настройки", lambda: self.on_settings()),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Обновить локацию", lambda: self.service.refresh_voice_now()),
                pystray.MenuItem(
                    "Пауза RPC",
                    self._toggle_pause,
                    checked=lambda item: not self.service.snapshot().get("enabled", True),
                ),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Выход", lambda: self.on_quit()),
            )
            self._icon = pystray.Icon("ArukuRPC", image, "Aruku RPC", menu)
            self._thread = threading.Thread(
                target=self._run_icon, name="aruku-tray", daemon=True
            )
            self._thread.start()
        self._start_animation()
        return True

    def stop(self) -> None:
        self._stop.set()
        self._anim_stop.set()
        icon = self._icon
        self._icon = None
        if icon is not None:
            try:
                icon.stop()
            except Exception:
                self.log.debug("Tray stop failed", exc_info=True)
        for thread in (self._anim_thread, self._thread):
            if thread and thread.is_alive():
                thread.join(timeout=2)

    def reload_icon(self) -> None:
        if not self.available:
            return
        self._anim_stop.set()
        if self._anim_thread and self._anim_thread.is_alive():
            self._anim_thread.join(timeout=2)
        with self._lock:
            self._load_frames()
            if self._icon is not None and self._frames:
                self._icon.icon = self._frames[0][0]
        self._start_animation()

    # ------------------------------------------------------------------
    def _run_icon(self) -> None:
        try:
            assert self._icon is not None
            self._icon.run()
        except Exception:
            self.log.exception("Tray icon crashed")

    def _toggle_pause(self) -> None:
        snapshot = self.service.snapshot()
        self.service.set_enabled(not snapshot.get("enabled", True))

    def _toggle_session(self) -> None:
        """Fallback used when the UI does not provide its own callback."""
        snapshot = self.service.snapshot()
        if snapshot.get("active"):
            self.service.stop_session()
            return
        title = str(self.config.get("media.title", "") or "").strip()
        if not title:
            # There is nothing to broadcast yet; let the user fill the title.
            self.on_open()
            return
        kind = str(self.config.get("media.kind", "anime") or "anime")
        platform = str(self.config.get("media.platform", "") or "")
        self.service.start_session(title, kind, platform)

    def _status_text(self) -> str:
        snap = self.service.snapshot()
        if snap.get("active"):
            title = snap.get("media", {}).get("title") or "эфир"
            return truncate(f"В эфире: {title} • {snap.get('elapsed', '0m')}", 80)
        if snap.get("status"):
            return truncate(f"Aruku RPC • {snap['status']}", 80)
        return "Aruku RPC"

    def _load_frames(self) -> None:
        self._frames = []
        if Image is None or ImageSequence is None:
            return
        configured = str(self.config.get("ui.tray_gif", "") or "")
        path = tray_gif_path(configured)
        if not path.exists():
            return
        try:
            with Image.open(path) as image:
                default_duration = int(image.info.get("duration", 100) or 100)
                for frame in ImageSequence.Iterator(image):
                    duration = int(frame.info.get("duration", default_duration) or default_duration)
                    rgba = frame.convert("RGBA").resize((64, 64), Image.Resampling.LANCZOS)
                    self._frames.append((rgba.copy(), max(20, duration) / 1000.0))
        except Exception:
            self.log.exception("Could not load tray GIF %s", path)
            self._frames = []

    def _fallback_image(self):
        if Image is None or ImageDraw is None:
            return None
        png = asset_path("icon.png")
        if png.exists():
            try:
                with Image.open(png) as image:
                    return image.convert("RGBA").resize((64, 64), Image.Resampling.LANCZOS).copy()
            except Exception:
                pass
        image = Image.new("RGBA", (64, 64), (15, 17, 23, 255))
        draw = ImageDraw.Draw(image)
        draw.ellipse((14, 8, 50, 44), fill=(139, 92, 246, 255))
        draw.polygon(((20, 35), (44, 35), (32, 56)), fill=(139, 92, 246, 255))
        draw.ellipse((26, 20, 38, 32), fill=(15, 17, 23, 255))
        return image

    def _start_animation(self) -> None:
        with self._lock:
            frames = list(self._frames)
            icon = self._icon
        if not frames or icon is None:
            return
        self._anim_stop = threading.Event()
        stop = self._anim_stop

        def animate() -> None:
            index = 0
            while not stop.is_set() and not self._stop.is_set():
                frame, duration = frames[index % len(frames)]
                try:
                    icon.icon = frame
                except Exception:
                    self.log.debug("Could not update tray frame", exc_info=True)
                    return
                if stop.wait(duration):
                    break
                index += 1

        self._anim_thread = threading.Thread(
            target=animate, name="aruku-tray-anim", daemon=True
        )
        self._anim_thread.start()
