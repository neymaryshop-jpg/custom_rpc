from __future__ import annotations

from datetime import datetime, timezone


def now_local() -> datetime:
    return datetime.now().astimezone()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed


def to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.astimezone()
    return value.isoformat(timespec="seconds")


def elapsed_seconds(started_at: datetime | None, now: datetime | None = None) -> int:
    if started_at is None:
        return 0
    current = now or datetime.now(timezone.utc)
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    return max(0, int((current - started_at).total_seconds()))


def format_elapsed(seconds: int | float) -> str:
    """Return a compact human duration: 0m, 14m, 2h 14m."""
    total = max(0, int(seconds))
    minutes = total // 60
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def format_clock(value: datetime | None) -> str:
    if value is None:
        return "—"
    return value.astimezone().strftime("%H:%M")


def truncate(value: str, limit: int = 128) -> str:
    value = (value or "").strip()
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"
