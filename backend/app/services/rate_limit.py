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

    Each attempt is its own document (scope, key, at) rather than one
    growing-array document per key. That avoids two problems the old
    read-array/append/rewrite-array approach had under concurrent load:
      1. Lost updates — two concurrent requests both read the same array,
         both append in memory, and whichever writes last clobbers the
         other's recorded attempt, undercounting real attempts.
      2. Unbounded growth / hot-document contention — every attempt against
         a given key serialized through read-modify-write on one document,
         and old entries were only pruned on the next read of that same key.
    A TTL index (see database.create_indexes) auto-expires attempt documents
    once they're out of any window that would reference them, so no manual
    cleanup pass is needed.

    Call this BEFORE doing the sensitive check (password/TOTP verification).
    Returns True if the action is allowed (and records this attempt).
    Returns False if the limit has been exceeded (does NOT record the
    rejected attempt itself).
    """
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(minutes=window_minutes)

    count = await _rate_limits_col().count_documents(
        {"scope": scope, "key": key, "at": {"$gte": window_start}}
    )
    if count >= max_attempts:
        return False

    await _rate_limits_col().insert_one({
        "scope": scope,
        "key": key,
        "at": now,
        # Slack past the window so the TTL sweep never removes a document
        # before a still-in-window count_documents() call could need it.
        "expires_at": now + timedelta(minutes=window_minutes * 2),
    })
    return True
