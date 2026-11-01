from __future__ import annotations

import tkinter as tk
from tkinter import ttk

BG = "#0b0d12"
CARD = "#151923"
CARD_2 = "#1d2432"
BORDER = "#2a3242"
TEXT = "#f4f4f5"
MUTED = "#9ca3af"
ACCENT = "#8b5cf6"
ACCENT_DARK = "#7c3aed"
ACCENT_2 = "#22d3ee"
GREEN = "#34d399"
RED = "#f87171"
AMBER = "#fbbf24"
DANGER_BG = "#3a1f25"

FONT = "Segoe UI"


def f(size: int = 10, weight: str = "normal") -> tuple[str, int, str]:
    return (FONT, size, weight)


def apply_theme(root: tk.Misc) -> None:
    root.option_add("*Font", f(10))
    root.option_add("*TCombobox*Listbox.background", CARD_2)
    root.option_add("*TCombobox*Listbox.foreground", TEXT)
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT)
    root.option_add("*TCombobox*Listbox.selectForeground", "#ffffff")
    root.option_add("*TCombobox*Listbox.font", f(10))
    root.option_add("*Text.background", CARD_2)
    root.option_add("*Text.foreground", TEXT)
    root.option_add("*Text.insertBackground", TEXT)

    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass

    style.configure("Dark.TCombobox", fieldbackground=CARD_2, background=CARD_2,
                    foreground=TEXT, arrowcolor=TEXT, bordercolor=BORDER,
                    lightcolor=BORDER, darkcolor=BORDER, padding=6, font=f(10))
    style.map(
        "Dark.TCombobox",
        fieldbackground=[("readonly", CARD_2), ("disabled", CARD)],
        foreground=[("readonly", TEXT), ("disabled", MUTED)],
        selectbackground=[("readonly", CARD_2)],
        selectforeground=[("readonly", TEXT)],
        bordercolor=[("focus", ACCENT)],
    )
    style.configure("Dark.TEntry", fieldbackground=CARD_2, foreground=TEXT,
                    insertcolor=TEXT, bordercolor=BORDER, lightcolor=BORDER,
                    darkcolor=BORDER, padding=6, font=f(10))
    style.map("Dark.TEntry", bordercolor=[("focus", ACCENT)])
    style.configure("Dark.TSpinbox", fieldbackground=CARD_2, foreground=TEXT,
                    arrowcolor=TEXT, bordercolor=BORDER, lightcolor=BORDER,
                    darkcolor=BORDER, padding=6, font=f(10))
    style.configure("Dark.TCheckbutton", background=BG, foreground=TEXT,
                    focuscolor=BG, font=f(9))
    style.map("Dark.TCheckbutton", background=[("active", BG)],
              foreground=[("active", TEXT)])
    style.configure("Card.TCheckbutton", background=CARD, foreground=TEXT,
                    focuscolor=CARD, font=f(9))
    style.map("Card.TCheckbutton", background=[("active", CARD)],
              foreground=[("active", TEXT)])
    style.configure("Dark.TNotebook", background=BG, borderwidth=0)
    style.configure("Dark.TNotebook.Tab", background=CARD_2, foreground=MUTED,
                    padding=[12, 6], font=f(9, "bold"))
    style.map("Dark.TNotebook.Tab",
              background=[("selected", CARD), ("active", BORDER)],
              foreground=[("selected", TEXT), ("active", TEXT)])
    style.configure("Dark.TFrame", background=BG)
    style.configure("Dark.TLabel", background=BG, foreground=TEXT)
    style.configure("Dark.TSeparator", background=BORDER)
    style.configure("Vertical.TScrollbar", background=CARD_2, troughcolor=BG,
                    bordercolor=BG, arrowcolor=MUTED)
