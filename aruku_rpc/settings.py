from __future__ import annotations

import shutil
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from .config import Config
from .discord_ipc import DiscordIPC, DiscordIPCError
from .paths import app_data_dir, user_asset_path
from .startup import is_autostart_enabled, set_autostart
from .theme import (
    ACCENT,
    ACCENT_2,
    ACCENT_DARK,
    AMBER,
    BG,
    BORDER,
    CARD,
    CARD_2,
    MUTED,
    TEXT,
    apply_theme,
    f,
)

STATUS_DISPLAY_LABELS = {
    "Название приложения": 0,
    "Состояние": 1,
    "Локация": 2,
}


class SettingsWindow(tk.Toplevel):
    def __init__(self, ui) -> None:
        super().__init__(ui.root)
        self.ui = ui
        self.config: Config = ui.config
        self.service = ui.service
        self.title("Настройки — Aruku RPC")
        self.geometry("640x720")
        self.minsize(580, 620)
        self.configure(bg=BG)
        self.transient(ui.root)
        self.protocol("WM_DELETE_WINDOW", self.close)
        apply_theme(self)

        self.vars: dict[str, tk.StringVar] = {}
        self._build()
        self._load()
        self.after(60, self.focus_force)

    # ------------------------------------------------------------------
    def _var(self, key: str, value: str = "") -> tk.StringVar:
        var = tk.StringVar(value=value)
        self.vars[key] = var
        return var

    def _build(self) -> None:
        header = tk.Frame(self, bg=BG)
        header.pack(fill="x", padx=20, pady=(16, 10))
        tk.Label(
            header, text="Настройки", font=f(18, "bold"), fg=TEXT, bg=BG
        ).pack(anchor="w")
        tk.Label(
            header,
            text="Подключение, иконки и поведение Aruku RPC",
            font=f(9),
            fg=MUTED,
            bg=BG,
        ).pack(anchor="w")

        notebook = ttk.Notebook(self, style="Dark.TNotebook")
        notebook.pack(fill="both", expand=True, padx=20, pady=(0, 10))

        conn = tk.Frame(notebook, bg=BG)
        icons = tk.Frame(notebook, bg=BG)
        behavior = tk.Frame(notebook, bg=BG)
        notebook.add(conn, text="Подключение")
        notebook.add(icons, text="Иконки")
        notebook.add(behavior, text="Поведение")

        self._build_connection(conn)
        self._build_icons(icons)
        self._build_behavior(behavior)

        footer = tk.Frame(self, bg=BG)
        footer.pack(fill="x", padx=20, pady=(0, 16))
        tk.Button(
            footer,
            text="Developer Portal",
            command=lambda: webbrowser.open("https://discord.com/developers/applications"),
            bg=CARD,
            fg=MUTED,
            activebackground=CARD_2,
            activeforeground=TEXT,
            bd=0,
            relief="flat",
            highlightthickness=0,
            padx=10,
            pady=8,
            font=f(9, "bold"),
            cursor="hand2",
        ).pack(side="left")
        tk.Button(
            footer,
            text="Сохранить",
            command=self.save,
            bg=ACCENT,
            fg="#ffffff",
            activebackground=ACCENT_DARK,
            activeforeground="#ffffff",
            bd=0,
            relief="flat",
            highlightthickness=0,
            padx=18,
            pady=8,
            font=f(9, "bold"),
            cursor="hand2",
        ).pack(side="right")
        tk.Button(
            footer,
            text="Отмена",
            command=self.close,
            bg=CARD_2,
            fg=TEXT,
            activebackground=BORDER,
            activeforeground=TEXT,
            bd=0,
            relief="flat",
            highlightthickness=0,
            padx=14,
            pady=8,
            font=f(9, "bold"),
            cursor="hand2",
        ).pack(side="right", padx=(0, 8))

    def _build_connection(self, parent: tk.Frame) -> None:
        body = tk.Frame(parent, bg=BG)
        body.pack(fill="both", expand=True, padx=14, pady=14)

        self._row(body, "Discord Client ID", self._var("client_id"),
                  "Application ID из Developer Portal")
        self._row(body, "Название сервера", self._var("server_name"),
                  "например, Aruku")
        self._row(body, "Guild ID", self._var("guild_id"),
                  "нужен для ссылки на войс, если авто не сработает")
        self._row(body, "Invite-ссылка сервера", self._var("invite_url"),
                  "https://discord.gg/… — для второй кнопки")
        self._row(body, "Ссылка на стрим", self._var("stream_url"),
                  "https://twitch.tv/… — сделает статус кликабельным")

        tk.Frame(body, bg=BORDER, height=1).pack(fill="x", pady=12)

        self._check(body, "Автоматически брать текущий войс из Discord",
                    self._var_bool("auto_voice"))
        self._row(body, "ID войс-канала (резерв)", self._var("manual_channel_id"),
                  "если авто-режим недоступен")
        self._row(body, "Название войс-канала", self._var("manual_channel_name"),
                  "показывается в RPC")

        poll_row = tk.Frame(body, bg=BG)
        poll_row.pack(fill="x", pady=5)
        tk.Label(
            poll_row, text="Интервал проверки", width=24, anchor="w",
            font=f(9), fg=TEXT, bg=BG
        ).pack(side="left")
        self.poll_var = self._var("poll_interval", "10")
        ttk.Spinbox(
            poll_row, from_=3, to=120, textvariable=self.poll_var,
            style="Dark.TSpinbox", width=8
        ).pack(side="left")
        tk.Label(
            poll_row, text="секунд", font=f(8), fg=MUTED, bg=BG
        ).pack(side="left", padx=(8, 0))

        tk.Button(
            body,
            text="Проверить подключение",
            command=self.check_discord,
            bg=CARD_2,
            fg=TEXT,
            activebackground=BORDER,
            activeforeground=TEXT,
            bd=0,
            relief="flat",
            highlightthickness=0,
            padx=12,
            pady=7,
            font=f(9, "bold"),
            cursor="hand2",
        ).pack(anchor="w", pady=(14, 0))

        self._hint(
            body,
            "Авто-войс использует локальный Discord RPC GET_SELECTED_VOICE_CHANNEL. "
            "Discord должен быть запущен. Если канал не определяется, включи ручной "
            "резерв или укажи ID канала.",
        )

    def _build_icons(self, parent: tk.Frame) -> None:
        body = tk.Frame(parent, bg=BG)
        body.pack(fill="both", expand=True, padx=14, pady=14)

        self._row(body, "Large image asset", self._var("large_image"),
                  "ключ картинки из Rich Presence → Art Assets")
        self._row(body, "Large image GIF URL", self._var("large_image_url"),
                  "https://… — внешняя GIF/PNG для анимированной иконки")
        self._row(body, "Small image: аниме", self._var("anime_image"),
                  "ключ иконки для аниме")
        self._row(body, "Small image: игра", self._var("game_image"),
                  "ключ иконки для игры")
        self._row(body, "Small image: другое", self._var("other_image"),
                  "ключ иконки для остального")

        tk.Frame(body, bg=BORDER, height=1).pack(fill="x", pady=12)

        tray_row = tk.Frame(body, bg=BG)
        tray_row.pack(fill="x", pady=5)
        tk.Label(
            tray_row, text="GIF для трея", width=24, anchor="w",
            font=f(9), fg=TEXT, bg=BG
        ).pack(side="left")
        self.tray_gif_var = self._var("tray_gif_label", "встроенная иконка")
        tk.Label(
            tray_row, textvariable=self.tray_gif_var, font=f(8), fg=MUTED,
            bg=BG, anchor="w", wraplength=240
        ).pack(side="left", fill="x", expand=True)
        tk.Button(
            tray_row, text="Выбрать", command=self.choose_gif,
            bg=CARD_2, fg=TEXT, activebackground=BORDER, activeforeground=TEXT,
            bd=0, relief="flat", highlightthickness=0, padx=10, pady=6,
            font=f(8, "bold"), cursor="hand2"
        ).pack(side="right")
        tk.Button(
            tray_row, text="Сброс", command=self.reset_gif,
            bg=CARD, fg=MUTED, activebackground=CARD_2, activeforeground=TEXT,
            bd=0, relief="flat", highlightthickness=0, padx=10, pady=6,
            font=f(8, "bold"), cursor="hand2"
        ).pack(side="right", padx=(0, 6))

        tk.Button(
            body,
            text="Открыть Imgur для загрузки GIF",
            command=lambda: webbrowser.open("https://imgur.com/upload"),
            bg=CARD_2,
            fg=TEXT,
            activebackground=BORDER,
            activeforeground=TEXT,
            bd=0,
            relief="flat",
            highlightthickness=0,
            padx=12,
            pady=7,
            font=f(9, "bold"),
            cursor="hand2",
        ).pack(anchor="w", pady=(12, 0))

        self._hint(
            body,
            "Discord умеет показывать анимированный GIF как внешнюю картинку, "
            "если вставить публичную HTTPS-ссылку в Large image GIF URL. "
            "Локальный GIF всегда анимируется в трее. Если Discord сотрёт анимацию "
            "на своей стороне — останется статичный кадр.",
        )

    def _build_behavior(self, parent: tk.Frame) -> None:
        body = tk.Frame(parent, bg=BG)
        body.pack(fill="both", expand=True, padx=14, pady=14)

        self._check(body, "Показывать P в строке статуса",
                    self._var_bool("show_platform"))
        self._check(body, "Кнопка «Войти в войс»",
                    self._var_bool("button_voice"))
        self._check(body, "Кнопка сервера",
                    self._var_bool("button_server"))

        display_row = tk.Frame(body, bg=BG)
        display_row.pack(fill="x", pady=5)
        tk.Label(
            display_row, text="Показывать в списке участников", width=24,
            anchor="w", font=f(9), fg=TEXT, bg=BG
        ).pack(side="left")
        self.display_var = self._var("status_display", "Локация")
        ttk.Combobox(
            display_row,
            textvariable=self.display_var,
            values=list(STATUS_DISPLAY_LABELS),
            state="readonly",
            style="Dark.TCombobox",
            width=24,
        ).pack(side="left", fill="x", expand=True)

        tk.Frame(body, bg=BORDER, height=1).pack(fill="x", pady=12)

        self._check(body, "Запускать вместе с Windows",
                    self._var_bool("autostart"))
        self._check(body, "Стартовать свёрнутым в трей",
                    self._var_bool("start_minimized"))
        self._check(body, "Закрывать окно в трей",
                    self._var_bool("minimize_to_tray"))

        self._hint(
            body,
            "Список участников — новая настройка Discord: можно показать название "
            "приложения, состояние или локацию. Если клиент её не поддерживает, "
            "он просто проигнорирует поле.",
        )

    # ------------------------------------------------------------------
    # Form helpers
    # ------------------------------------------------------------------
    def _row(self, parent: tk.Frame, label: str, var: tk.StringVar, hint: str = "") -> None:
        row = tk.Frame(parent, bg=BG)
        row.pack(fill="x", pady=4)
        tk.Label(
            row, text=label, width=24, anchor="w", font=f(9), fg=TEXT, bg=BG
        ).pack(side="left")
        ttk.Entry(row, textvariable=var, style="Dark.TEntry").pack(
            side="left", fill="x", expand=True
        )
        if hint:
            tk.Label(
                parent, text=hint, font=f(8), fg=MUTED, bg=BG,
                anchor="w", justify="left", wraplength=540
            ).pack(fill="x", padx=(0, 0), pady=(0, 3))

    def _var_bool(self, key: str) -> tk.BooleanVar:
        var = tk.BooleanVar(value=False)
        self.vars[key] = var  # type: ignore[assignment]
        return var

    def _check(self, parent: tk.Frame, label: str, var: tk.BooleanVar) -> None:
        ttk.Checkbutton(
            parent,
            text=label,
            variable=var,
            style="Dark.TCheckbutton",
        ).pack(anchor="w", pady=3)

    def _hint(self, parent: tk.Frame, text: str) -> None:
        tk.Label(
            parent,
            text=text,
            font=f(8),
            fg=MUTED,
            bg=BG,
            anchor="w",
            justify="left",
            wraplength=540,
        ).pack(fill="x", pady=(14, 0))

    # ------------------------------------------------------------------
    # Load / save
    # ------------------------------------------------------------------
    def _load(self) -> None:
        snap = self.config.snapshot()
        values = {
            "client_id": snap.get("discord", {}).get("client_id", ""),
            "server_name": snap.get("server", {}).get("name", "Aruku"),
            "guild_id": snap.get("server", {}).get("guild_id", ""),
            "invite_url": snap.get("server", {}).get("invite_url", ""),
            "stream_url": snap.get("discord", {}).get("stream_url", ""),
            "manual_channel_id": snap.get("voice", {}).get("manual_channel_id", ""),
            "manual_channel_name": snap.get("voice", {}).get("manual_channel_name", ""),
            "poll_interval": str(snap.get("discord", {}).get("poll_interval", 10)),
            "large_image": snap.get("presence", {}).get("large_image", "aruku_voice"),
            "large_image_url": snap.get("presence", {}).get("large_image_url", ""),
            "anime_image": snap.get("presence", {}).get("anime_image", "anime"),
            "game_image": snap.get("presence", {}).get("game_image", "game"),
            "other_image": snap.get("presence", {}).get("other_image", "media"),
        }
        for key, value in values.items():
            if key in self.vars:
                self.vars[key].set(str(value or ""))

        bools = {
            "auto_voice": snap.get("voice", {}).get("auto", True),
            "show_platform": snap.get("presence", {}).get("show_platform_in_state", True),
            "button_voice": snap.get("presence", {}).get("button_voice", True),
            "button_server": snap.get("presence", {}).get("button_server", True),
            "autostart": is_autostart_enabled(),
            "start_minimized": snap.get("ui", {}).get("start_minimized", False),
            "minimize_to_tray": snap.get("ui", {}).get("minimize_to_tray", True),
        }
        for key, value in bools.items():
            if key in self.vars:
                self.vars[key].set(bool(value))  # type: ignore[union-attr]

        display = int(snap.get("presence", {}).get("status_display_type", 2) or 0)
        label = next(
            (name for name, number in STATUS_DISPLAY_LABELS.items() if number == display),
            "Локация",
        )
        self.display_var.set(label)

        gif = str(snap.get("ui", {}).get("tray_gif", "") or "")
        self.tray_gif_var.set(Path(gif).name if gif else "встроенная иконка")

    def _value(self, key: str) -> str:
        var = self.vars.get(key)
        return str(var.get()).strip() if var is not None else ""

    def _bool(self, key: str) -> bool:
        var = self.vars.get(key)
        return bool(var.get()) if var is not None else False

    def save(self) -> None:
        client_id = self._value("client_id")
        guild_id = self._value("guild_id")
        channel_id = self._value("manual_channel_id")

        for label, value in (
            ("Discord Client ID", client_id),
            ("Guild ID", guild_id),
            ("ID войс-канала", channel_id),
        ):
            if value and not value.isdigit():
                messagebox.showwarning(
                    "Aruku RPC",
                    f"{label} должен состоять только из цифр.",
                    parent=self,
                )
                return

        invite_url = self._value("invite_url")
        stream_url = self._value("stream_url")
        large_url = self._value("large_image_url")
        for label, value in (
            ("Invite-ссылка", invite_url),
            ("Ссылка на стрим", stream_url),
            ("Large image GIF URL", large_url),
        ):
            if value and not value.startswith(("https://", "http://")):
                messagebox.showwarning(
                    "Aruku RPC",
                    f"{label} должна начинаться с https:// или http://",
                    parent=self,
                )
                return

        try:
            poll = int(self._value("poll_interval") or "10")
        except ValueError:
            poll = 10
        poll = max(3, min(120, poll))

        display_label = self.display_var.get()
        display_type = STATUS_DISPLAY_LABELS.get(display_label, 2)

        self.config.set("discord.client_id", client_id)
        self.config.set("discord.stream_url", stream_url)
        self.config.set("discord.poll_interval", poll)
        self.config.set("server.name", self._value("server_name") or "Aruku")
        self.config.set("server.guild_id", guild_id)
        self.config.set("server.invite_url", invite_url)
        self.config.set("voice.auto", self._bool("auto_voice"))
        self.config.set("voice.manual_channel_id", channel_id)
        self.config.set("voice.manual_channel_name", self._value("manual_channel_name"))
        self.config.set("presence.show_platform_in_state", self._bool("show_platform"))
        self.config.set("presence.button_voice", self._bool("button_voice"))
        self.config.set("presence.button_server", self._bool("button_server"))
        self.config.set("presence.large_image", self._value("large_image"))
        self.config.set("presence.large_image_url", large_url)
        self.config.set("presence.anime_image", self._value("anime_image"))
        self.config.set("presence.game_image", self._value("game_image"))
        self.config.set("presence.other_image", self._value("other_image"))
        self.config.set("presence.status_display_type", display_type)
        self.config.set("ui.start_minimized", self._bool("start_minimized"))
        self.config.set("ui.minimize_to_tray", self._bool("minimize_to_tray"))
        self.config.save()

        autostart_ok = set_autostart(self._bool("autostart"))
        if self._bool("autostart") and not autostart_ok:
            messagebox.showwarning(
                "Aruku RPC",
                "Не удалось включить автозапуск. Попробуй запустить программу от своего пользователя.",
                parent=self,
            )

        typed_title = self.ui.title_var.get()
        self.service.reload()
        self.ui._load_from_config()
        if not self.service.snapshot().get("active"):
            self.ui.title_var.set(typed_title)
        if self.ui.tray is not None:
            try:
                self.ui.tray.reload_icon()
            except Exception:
                pass
        self.ui._set_status_text("Настройки сохранены")
        self.close()

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def check_discord(self) -> None:
        client_id = self._value("client_id")
        if not client_id or not client_id.isdigit():
            messagebox.showwarning(
                "Aruku RPC",
                "Сначала вставь корректный Discord Client ID.",
                parent=self,
            )
            return

        self.ui._set_status_text("Проверяю подключение к Discord…")

        def worker() -> None:
            message = ""
            ipc = None
            try:
                ipc = DiscordIPC(client_id)
                ipc.connect()
                user = (ipc.user or {}).get("username") or "пользователь"
                try:
                    data = ipc.get_selected_voice_channel()
                    if data:
                        message = (
                            f"Подключено как {user}.\n"
                            f"Текущий войс: {data.get('name')} "
                            f"(guild {data.get('guild_id') or '—'})"
                        )
                    else:
                        message = (
                            f"Подключено как {user}.\n"
                            "Discord не вернул текущий войс — сработает ручной резерв."
                        )
                except DiscordIPCError as exc:
                    if exc.code is None:
                        raise
                    message = (
                        f"Подключено как {user} — RPC работает.\n"
                        f"Авто-войс недоступен ({exc}).\n"
                        "Укажи Guild ID и ID войс-канала вручную."
                    )
            except Exception as exc:
                message = f"Не удалось подключиться:\n{exc}"
            finally:
                if ipc is not None:
                    try:
                        ipc.close()
                    except Exception:
                        pass

            def show_message() -> None:
                messagebox.showinfo("Проверка Discord", message, parent=self)

            self.ui.post(show_message)

        threading.Thread(target=worker, name="aruku-check", daemon=True).start()

    def choose_gif(self) -> None:
        path = filedialog.askopenfilename(
            parent=self,
            title="Выбери анимированный GIF для трея",
            filetypes=[("GIF", "*.gif"), ("Все файлы", "*.*")],
        )
        if not path:
            return
        try:
            dest = user_asset_path("location.gif")
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
            self.config.set("ui.tray_gif", str(dest))
            self.config.save()
            self.tray_gif_var.set(dest.name)
            if self.ui.tray is not None:
                self.ui.tray.reload_icon()
            self.ui._set_status_text(f"GIF для трея обновлён: {dest.name}")
        except Exception as exc:
            messagebox.showerror(
                "Aruku RPC", f"Не удалось скопировать GIF:\n{exc}", parent=self
            )

    def reset_gif(self) -> None:
        self.config.set("ui.tray_gif", "")
        self.config.save()
        self.tray_gif_var.set("встроенная иконка")
        if self.ui.tray is not None:
            self.ui.tray.reload_icon()
        self.ui._set_status_text("Используется встроенная иконка")

    def close(self) -> None:
        self.ui._settings = None
        self.destroy()
