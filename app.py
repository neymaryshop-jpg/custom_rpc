from __future__ import annotations

import argparse
import logging
import platform
import sys
import traceback
from logging.handlers import RotatingFileHandler

import tkinter as tk
from tkinter import messagebox

from aruku_rpc import __version__
from aruku_rpc.config import Config
from aruku_rpc.paths import log_path
from aruku_rpc.presence import PresenceService
from aruku_rpc.tray import TrayIcon
from aruku_rpc.ui import MainWindow


def setup_logging(debug: bool = False) -> logging.Logger:
    logger = logging.getLogger("aruku")
    logger.setLevel(logging.DEBUG if debug else logging.INFO)
    logger.propagate = False
    if logger.handlers:
        return logger

    path = log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        path, maxBytes=1_500_000, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-8s %(name)s: %(message)s")
    )
    logger.addHandler(handler)

    if debug:
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        logger.addHandler(console)
    return logger


def main() -> int:
    parser = argparse.ArgumentParser(description="Aruku RPC — Discord Rich Presence tray app")
    parser.add_argument("--minimized", action="store_true", help="start in the tray")
    parser.add_argument("--debug", action="store_true", help="verbose console logging")
    args = parser.parse_args()

    logger = setup_logging(args.debug)
    logger.info("Aruku RPC %s starting on %s", __version__, platform.platform())

    config = Config()
    config.ensure_file()
    service = PresenceService(config, logger)

    try:
        root = tk.Tk()
    except Exception:
        logger.exception("Could not start Tk")
        print("Не удалось запустить графический интерфейс. Установи Python с Tkinter.")
        return 1

    def report_callback_exception(exc_type, exc_value, exc_tb) -> None:
        logger.error(
            "Tk callback exception: %s",
            "".join(traceback.format_exception(exc_type, exc_value, exc_tb)),
        )

    root.report_callback_exception = report_callback_exception

    ui_ref: dict[str, MainWindow | None] = {"ui": None}

    def open_window() -> None:
        ui = ui_ref["ui"]
        if ui is not None:
            ui.post(ui.show)

    def open_settings() -> None:
        ui = ui_ref["ui"]
        if ui is None:
            return

        def action() -> None:
            ui.show()
            ui.open_settings()

        ui.post(action)

    def toggle_session() -> None:
        ui = ui_ref["ui"]
        if ui is not None:
            ui.post(ui.toggle_session)

    def quit_app() -> None:
        ui = ui_ref["ui"]
        if ui is not None:
            ui.post(ui.quit)

    tray = TrayIcon(
        config,
        service,
        open_window,
        quit_app,
        logger,
        on_settings=open_settings,
        on_toggle_session=toggle_session,
    )
    ui = MainWindow(root, config, service, tray, logger)
    ui_ref["ui"] = ui

    try:
        tray_started = tray.start()
    except Exception:
        logger.exception("Could not start the tray icon")
        tray_started = False
    if not tray_started:
        logger.warning("Tray unavailable; close button will exit the app")
    service.start()

    if args.minimized or bool(config.get("ui.start_minimized", False)):
        if config.get("discord.client_id"):
            ui.hide_to_tray()

    try:
        root.mainloop()
    except KeyboardInterrupt:
        logger.info("Interrupted")
    except Exception:
        logger.exception("Fatal UI error")
        try:
            messagebox.showerror(
                "Aruku RPC",
                "Произошла ошибка. Подробности в логе:\n"
                f"{log_path()}",
            )
        except Exception:
            pass
    finally:
        try:
            service.stop()
        except Exception:
            logger.debug("Service stop failed", exc_info=True)
        try:
            tray.stop()
        except Exception:
            logger.debug("Tray stop failed", exc_info=True)
        logger.info("Aruku RPC stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
