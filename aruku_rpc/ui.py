from __future__ import annotations

import logging
import queue
import tkinter as tk
import webbrowser
from tkinter import messagebox, ttk
from typing import Any, Callable

from .config import Config
from .paths import asset_path
from .presence import PresenceService
from .theme import (
    ACCENT,
    ACCENT_2,
    ACCENT_DARK,
    AMBER,
    BG,
    BORDER,
    CARD,
    CARD_2,
    DANGER_BG,
    GREEN,
    MUTED,
    RED,
    TEXT,
    apply_theme,
    f,
)
from .timeutil import format_clock, parse_iso


class MainWindow:
    def __init__(
        self,
        root: tk.Tk,
        config: Config,
        service: PresenceService,
        tray: Any = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.root = root
        self.config = config
        self.service = service
        self.tray = tray
        self.log = logger or logging.getLogger("aruku.ui")
        self._queue: queue.Queue[Callable[[], None]] = queue.Queue()
        self._settings = None
        self._quitting = False
        self._first_run_checked = False
        self._banner_visible = False

        apply_theme(root)
        root.title("Aruku RPC")
        root.geometry("560x720")
        root.minsize(520, 680)
        root.configure(bg=BG)
        self._set_window_icon()

        self.location_var = tk.StringVar(value="Aruku/[Voice]")
        self.voice_hint_var = tk.StringVar(value="подключаюсь к Discord…")
        self.title_var = tk.StringVar()
        self.platform_var = tk.StringVar(value="Twitch")
        self.kind_var = tk.StringVar(value="anime")
        self.timer_var = tk.StringVar(value="0m")
        self.timer_hint_var = tk.StringVar(value="Начни эфир, чтобы включить таймер")
        self.enabled_var = tk.BooleanVar(value=True)
        self.pill_var = tk.StringVar(value="Запуск…")
        self.status_var = tk.StringVar(value="Запуск…")

        self._build()
        self._load_from_config()
        self._poll()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(500, self._maybe_first_run)

    # ------------------------------------------------------------------
    # Window construction
    # ------------------------------------------------------------------
    def _set_window_icon(self) -> None:
        try:
            icon = tk.PhotoImage(file=str(asset_path("icon.png")))
            self.root.iconphoto(True, icon)
            self._icon_ref = icon
        except Exception:
            self._icon_ref = None

    def _build(self) -> None:
        main = tk.Frame(self.root, bg=BG)
        main.pack(fill="both", expand=True, padx=18, pady=(14, 8))

        header = tk.Frame(main, bg=BG)
        header.pack(fill="x", pady=(0, 10))
        title_box = tk.Frame(header, bg=BG)
        title_box.pack(side="left")
        tk.Label(
            title_box, text="ARUKU", font=f(21, "bold"), fg=TEXT, bg=BG
        ).pack(anchor="w")
        tk.Label(
            title_box,
            text="rich presence • медиа-креатор",
            font=f(9),
            fg=MUTED,
            bg=BG,
        ).pack(anchor="w")
        self.status_pill = tk.Label(
            header,
            textvariable=self.pill_var,
            font=f(9, "bold"),
            fg=BG,
            bg=MUTED,
            padx=10,
            pady=4,
        )
        self.status_pill.pack(side="right", anchor="n")

        self.banner = tk.Frame(
            main,
            bg="#2a1f14",
            highlightbackground="#5b3a12",
            highlightthickness=1,
        )
        tk.Label(
            self.banner,
            text="Сначала укажи Discord Application ID — без него RPC не подключится.",
            font=f(9),
            fg=AMBER,
            bg="#2a1f14",
            anchor="w",
            justify="left",
            wraplength=390,
        ).pack(side="left", fill="x", expand=True, padx=(10, 6), pady=8)
        tk.Button(
            self.banner,
            text="Настроить",
            command=self.open_settings,
            bg=AMBER,
            fg=BG,
            activebackground="#f59e0b",
            activeforeground=BG,
            bd=0,
            relief="flat",
            highlightthickness=0,
            padx=10,
            pady=4,
            font=f(9, "bold"),
            cursor="hand2",
        ).pack(side="right", padx=8)

        location = self._card(main)
        self.location_card = location.master
        self._section(location, "ГДЕ Я СЕЙЧАС")
        self.location_label = tk.Label(
            location,
            textvariable=self.location_var,
            font=f(15, "bold"),
            fg=TEXT,
            bg=CARD,
            anchor="w",
            justify="left",
            wraplength=480,
            cursor="hand2",
        )
        self.location_label.pack(fill="x", pady=(3, 0))
        self.location_label.bind("<Button-1>", lambda _event: self.open_voice())
        tk.Label(
            location,
            textvariable=self.voice_hint_var,
            font=f(8),
            fg=MUTED,
            bg=CARD,
            anchor="w",
            justify="left",
            wraplength=480,
        ).pack(fill="x", pady=(3, 8))

        buttons = tk.Frame(location, bg=CARD)
        buttons.pack(fill="x")
        self.refresh_btn = self._button(buttons, "Обновить", self.refresh_voice, "ghost")
        self.refresh_btn.pack(side="left")
        self.voice_btn = self._button(buttons, "Открыть войс", self.open_voice, "secondary")
        self.voice_btn.pack(side="left", padx=(8, 0))
        self.copy_btn = self._button(buttons, "Скопировать", self.copy_location, "ghost")
        self.copy_btn.pack(side="right")

        media = self._card(main)
        self._section(media, "ЧТО ПОКАЗЫВАЮ")
        type_row = tk.Frame(media, bg=CARD)
        type_row.pack(fill="x", pady=(2, 8))
        for value, label in (("anime", "Аниме"), ("game", "Игра"), ("other", "Другое")):
            tk.Radiobutton(
                type_row,
                text=label,
                variable=self.kind_var,
                value=value,
                command=self._on_kind_change,
                indicatoron=False,
                bg=CARD_2,
                fg=TEXT,
                selectcolor=ACCENT,
                activebackground=ACCENT_DARK,
                activeforeground="#ffffff",
                bd=0,
                relief="flat",
                highlightthickness=0,
                padx=12,
                pady=5,
                font=f(9, "bold"),
                cursor="hand2",
            ).pack(side="left", padx=(0, 6))

        title_row = tk.Frame(media, bg=CARD)
        title_row.pack(fill="x")
        self.title_combo = ttk.Combobox(
            title_row,
            textvariable=self.title_var,
            style="Dark.TCombobox",
            state="normal",
        )
        self.title_combo.pack(side="left", fill="x", expand=True)
        self.add_preset_btn = self._button(title_row, "＋", self.add_preset, "ghost")
        self.add_preset_btn.pack(side="left", padx=(6, 0))

        platform_row = tk.Frame(media, bg=CARD)
        platform_row.pack(fill="x", pady=(8, 0))
        tk.Label(
            platform_row, text="P", font=f(9, "bold"), fg=ACCENT_2, bg=CARD
        ).pack(side="left")
        self.platform_entry = ttk.Entry(
            platform_row,
            textvariable=self.platform_var,
            style="Dark.TEntry",
        )
        self.platform_entry.pack(side="left", fill="x", expand=True, padx=(8, 0))
        tk.Label(
            platform_row,
            text="платформа / подпись",
            font=f(8),
            fg=MUTED,
            bg=CARD,
        ).pack(side="left", padx=(8, 0))

        self.action_btn = self._button(media, "Начать эфир", self.toggle_session, "primary")
        self.action_btn.pack(fill="x", pady=(12, 0))

        timer = self._card(main)
        self._section(timer, "В ЭФИРЕ")
        self.timer_label = tk.Label(
            timer,
            textvariable=self.timer_var,
            font=f(27, "bold"),
            fg=TEXT,
            bg=CARD,
            anchor="w",
        )
        self.timer_label.pack(fill="x")
        tk.Label(
            timer,
            textvariable=self.timer_hint_var,
            font=f(9),
            fg=MUTED,
            bg=CARD,
            anchor="w",
            justify="left",
            wraplength=480,
        ).pack(fill="x", pady=(1, 6))
        tk.Checkbutton(
            timer,
            text="Показывать RPC в Discord",
            variable=self.enabled_var,
            command=self.toggle_enabled,
            bg=CARD,
            fg=TEXT,
            activebackground=CARD,
            activeforeground=TEXT,
            selectcolor=CARD_2,
            bd=0,
            highlightthickness=0,
            font=f(9),
            cursor="hand2",
        ).pack(anchor="w")

        footer = tk.Frame(main, bg=BG)
        footer.pack(fill="x", pady=(0, 8))
        self._button(footer, "Настройки", self.open_settings, "secondary").pack(side="left")
        self._button(footer, "Свернуть в трей", self.hide_to_tray, "ghost").pack(side="right")

        tk.Label(
            main,
            textvariable=self.status_var,
            font=f(8),
            fg=MUTED,
            bg=BG,
            anchor="w",
            justify="left",
            wraplength=510,
        ).pack(fill="x")

    def _card(self, parent: tk.Misc) -> tk.Frame:
        card = tk.Frame(
            parent,
            bg=CARD,
            highlightbackground=BORDER,
            highlightthickness=1,
        )
        card.pack(fill="x", pady=(0, 10))
        inner = tk.Frame(card, bg=CARD)
        inner.pack(fill="both", expand=True, padx=14, pady=12)
        return inner

    def _section(self, parent: tk.Misc, text: str) -> None:
        tk.Label(
            parent,
            text=text,
            font=f(8, "bold"),
            fg=ACCENT_2,
            bg=CARD,
            anchor="w",
        ).pack(fill="x")

    def _button(
        self,
        parent: tk.Misc,
        text: str,
        command: Callable[[], None],
        kind: str = "secondary",
    ) -> tk.Button:
        colors = {
            "primary": (ACCENT, "#ffffff", ACCENT_DARK),
            "secondary": (CARD_2, TEXT, BORDER),
            "ghost": (CARD, MUTED, CARD_2),
            "danger": (DANGER_BG, RED, "#4a2630"),
        }
        bg, fg, active = colors.get(kind, colors["secondary"])
        return tk.Button(
            parent,
            text=text,
            command=command,
            bg=bg,
            fg=fg,
            activebackground=active,
            activeforeground=fg,
            disabledforeground=MUTED,
            bd=0,
            relief="flat",
            highlightthickness=0,
            padx=12,
            pady=7,
            font=f(9, "bold"),
            cursor="hand2",
        )

    # ------------------------------------------------------------------
    # Config / presets
    # ------------------------------------------------------------------
    def _load_from_config(self) -> None:
        snap = self.config.snapshot()
        kind = str(snap.get("media", {}).get("kind") or "anime")
        if kind not in ("anime", "game", "other"):
            kind = "anime"
        self.kind_var.set(kind)
        self.title_var.set(str(snap.get("media", {}).get("title") or ""))
        self.platform_var.set(str(snap.get("media", {}).get("platform") or ""))
        self.enabled_var.set(bool(snap.get("presence", {}).get("enabled", True)))
        self._refresh_presets()

    def _refresh_presets(self) -> None:
        kind = self.kind_var.get() or "anime"
        values = self.config.get(f"presets.{kind}", []) or []
        values = [str(item) for item in values if str(item).strip()]
        self.title_combo.configure(values=values)

    def _on_kind_change(self) -> None:
        self._refresh_presets()

    def add_preset(self) -> None:
        title = self.title_var.get().strip()
        if not title:
            return
        kind = self.kind_var.get() or "anime"
        values = [str(item) for item in (self.config.get(f"presets.{kind}", []) or [])]
        if title not in values:
            values.append(title)
            self.config.set(f"presets.{kind}", values)
            self.config.save()
        self._refresh_presets()
        self._set_status_text(f"«{title}» добавлено в пресеты")

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def toggle_session(self) -> None:
        snap = self.service.snapshot()
        if snap.get("active"):
            self.service.stop_session()
            self._set_status_text("Эфир завершён")
            return
        title = self.title_var.get().strip()
        if not title:
            self.show()
            messagebox.showwarning(
                "Aruku RPC",
                "Напиши, что показываешь: название аниме, игры или другую подпись.",
                parent=self.root,
            )
            return
        kind = self.kind_var.get() or "anime"
        platform = self.platform_var.get().strip()
        self.service.start_session(title, kind, platform)
        self._set_status_text("Эфир начался — RPC обновится через пару секунд")

    def toggle_enabled(self) -> None:
        self.service.set_enabled(self.enabled_var.get())

    def refresh_voice(self) -> None:
        self.service.refresh_voice_now()
        self._set_status_text("Обновляю локацию из Discord…")

    def open_voice(self) -> None:
        url = self.service.snapshot().get("voice_url", "")
        if url:
            webbrowser.open(url)
        else:
            messagebox.showinfo(
                "Aruku RPC",
                "Ссылка на войс пока недоступна. Включи авто-войс в настройках "
                "или укажи ID канала вручную.",
                parent=self.root,
            )

    def copy_location(self) -> None:
        snapshot = self.service.snapshot()
        voice_url = str(snapshot.get("voice_url") or "")
        text = voice_url or self.location_var.get()
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        if voice_url:
            self._set_status_text("Ссылка на войс скопирована")
        else:
            self._set_status_text(f"Скопировано: {text}")

    def open_settings(self) -> None:
        if self._settings is not None:
            try:
                self._settings.lift()
                self._settings.focus_force()
                return
            except tk.TclError:
                self._settings = None
        from .settings import SettingsWindow

        self._settings = SettingsWindow(self)

    def hide_to_tray(self) -> None:
        if self.tray is not None and getattr(self.tray, "available", False):
            self.root.withdraw()
        else:
            self.root.iconify()

    def show(self) -> None:
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()
        try:
            self.root.attributes("-topmost", True)
            self.root.after(150, lambda: self.root.attributes("-topmost", False))
        except tk.TclError:
            pass

    def on_close(self) -> None:
        if bool(self.config.get("ui.minimize_to_tray", True)) and self.tray is not None:
            if getattr(self.tray, "available", False):
                self.hide_to_tray()
                return
        self.quit()

    def quit(self) -> None:
        if self._quitting:
            return
        self._quitting = True
        try:
            self.service.stop()
        finally:
            if self.tray is not None:
                try:
                    self.tray.stop()
                except Exception:
                    self.log.debug("Tray stop failed", exc_info=True)
            try:
                self.root.destroy()
            except tk.TclError:
                pass

    # ------------------------------------------------------------------
    # Thread-safe queue + polling
    # ------------------------------------------------------------------
    def post(self, callback: Callable[[], None]) -> None:
        self._queue.put(callback)

    def _poll(self) -> None:
        if self._quitting:
            return
        while True:
            try:
                callback = self._queue.get_nowait()
            except queue.Empty:
                break
            try:
                callback()
            except Exception:
                self.log.exception("UI callback failed")

        self._update_from_snapshot()
        self.root.after(1000, self._poll)

    def _update_from_snapshot(self) -> None:
        snap = self.service.snapshot()
        status = str(snap.get("status") or "")
        self.pill_var.set(status)

        if status == "В эфире":
            pill_bg, pill_fg = GREEN, BG
        elif "Ошибка" in status or status == "Нужен Client ID":
            pill_bg, pill_fg = RED, "#ffffff"
        elif status == "RPC выключен":
            pill_bg, pill_fg = BORDER, TEXT
        elif status == "Не в эфире":
            pill_bg, pill_fg = CARD_2, MUTED
        else:
            pill_bg, pill_fg = AMBER, BG
        self.status_pill.configure(bg=pill_bg, fg=pill_fg)

        self.location_var.set(snap.get("location") or "Aruku/[Voice]")
        self.location_label.configure(fg=ACCENT_2 if snap.get("voice_url") else TEXT)

        source = snap.get("voice_source")
        if source == "auto":
            hint = "авто • текущий войс из Discord"
        elif source == "manual":
            hint = "вручную • резервный канал"
        else:
            hint = "резерв • Aruku/[Voice]"
        if not snap.get("auto_voice"):
            hint = "авто выключено • " + hint
        if snap.get("voice_auto_error"):
            hint += " • " + str(snap["voice_auto_error"])
        self.voice_hint_var.set(hint)
        self.voice_btn.configure(
            state="normal" if snap.get("voice_url") else "disabled",
            cursor="hand2" if snap.get("voice_url") else "arrow",
        )

        if snap.get("active"):
            self.timer_var.set(str(snap.get("elapsed") or "0m"))
            started = parse_iso(snap.get("started_at"))
            platform = str(snap.get("media", {}).get("platform") or "").strip()
            hint = f"с {format_clock(started)}"
            if platform:
                hint += f" • {platform}"
            self.timer_hint_var.set(hint)
            self.action_btn.configure(
                text="Завершить эфир",
                bg=DANGER_BG,
                fg=RED,
                activebackground="#4a2630",
                activeforeground=RED,
            )
        else:
            self.timer_var.set("0m")
            self.timer_hint_var.set("Начни эфир, чтобы включить таймер")
            self.action_btn.configure(
                text="Начать эфир",
                bg=ACCENT,
                fg="#ffffff",
                activebackground=ACCENT_DARK,
                activeforeground="#ffffff",
            )

        if self.enabled_var.get() != bool(snap.get("enabled")):
            self.enabled_var.set(bool(snap.get("enabled")))

        needs_setup = not bool(snap.get("client_id_configured"))
        if needs_setup and not self._banner_visible:
            self.banner.pack(
                fill="x",
                pady=(0, 10),
                before=self.location_card,
            )
            self._banner_visible = True
        elif not needs_setup and self._banner_visible:
            self.banner.pack_forget()
            self._banner_visible = False

        error = str(snap.get("error") or "")
        if error:
            self.status_var.set(f"{status} • {error}")
        elif snap.get("connected"):
            user = snap.get("discord_user") or "Discord"
            self.status_var.set(f"Discord: подключен как {user}")
        elif snap.get("client_id_configured"):
            self.status_var.set(f"Discord: нет соединения • {status}")
        else:
            self.status_var.set("Укажи Client ID в настройках, чтобы включить RPC.")

    def _maybe_first_run(self) -> None:
        if self._first_run_checked:
            return
        self._first_run_checked = True
        if not self.config.get("discord.client_id"):
            self.open_settings()

    def _set_status_text(self, text: str) -> None:
        self.status_var.set(text)
