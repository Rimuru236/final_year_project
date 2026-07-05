from __future__ import annotations

from datetime import datetime, timedelta, timezone

from ..core.database import get_db


def _rate_limits_col():
    return get_db()["rate_limits"]


async def check_rate_limit(scope: str, key: str, max_attempts: int, window_minutes: int) -> bool:
    """
    Sliding-window rate limiter backed by MongoDB — consistent with this app's
    everything-in-Mongo pattern (sessions, avatars, etc.), persists across
    restarts, and is scoped per real identity (email/user_id) rather than
    per-process like an in-memory limiter would be.

    Call this BEFORE doing the sensitive check (password/TOTP verification).
    Returns True if the action is allowed (and records this attempt).
    Returns False if the limit has been exceeded (does NOT record the
    rejected attempt itself, but still prunes stale entries).
    """
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(minutes=window_minutes)
    doc_id = f"{scope}:{key}"

    doc = await _rate_limits_col().find_one({"_id": doc_id})
    raw_attempts = doc.get("attempts", []) if doc else []
    # Motor/PyMongo returns naive UTC datetimes on read (BSON dates carry no
    # timezone) — normalize before comparing against the timezone-aware `now`.
    attempts = [
        (a if a.tzinfo else a.replace(tzinfo=timezone.utc))
        for a in raw_attempts
        if (a if a.tzinfo else a.replace(tzinfo=timezone.utc)) > window_start
    ]

    if len(attempts) >= max_attempts:
        await _rate_limits_col().update_one(
            {"_id": doc_id}, {"$set": {"attempts": attempts}}, upsert=True,
        )
        return False

    attempts.append(now)
    await _rate_limits_col().update_one(
        {"_id": doc_id}, {"$set": {"attempts": attempts}}, upsert=True,
    )
    return True
