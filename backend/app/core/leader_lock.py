"""
Single-leader lock for scheduled jobs.

Running multiple Uvicorn worker processes (see main.py) means the FastAPI
`lifespan` runs once per worker — without this guard, every worker would start
its own APScheduler and the daily note-lifecycle job / streak-nudge emails
would fire once per worker instead of once per day.

This is a coarse Mongo-backed lock: whichever worker acquires it runs the
scheduler; it renews the lock periodically while holding it, and releases it
on shutdown so another worker can take over immediately on redeploy. If a
worker crashes without releasing, the lock simply expires (TTL) and the next
renewal attempt from any worker picks it back up.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

from pymongo.errors import DuplicateKeyError

from .database import get_db

logger = logging.getLogger(__name__)

_LOCK_ID = "scheduler_leader"
_TTL = timedelta(minutes=3)
_RENEW_INTERVAL_SECONDS = 60

_holder_id = str(uuid.uuid4())
_renew_task: asyncio.Task | None = None


def _locks_col():
    return get_db()["app_locks"]


async def _try_acquire() -> bool:
    now = datetime.now(timezone.utc)
    query = {
        "_id": _LOCK_ID,
        "$or": [{"holder": _holder_id}, {"expires_at": {"$lt": now}}],
    }
    update = {"$set": {"holder": _holder_id, "expires_at": now + _TTL}}
    try:
        result = await _locks_col().update_one(query, update, upsert=True)
    except DuplicateKeyError:
        # Two workers raced the initial upsert (no doc existed for either to
        # match) — the other worker's insert won. We don't hold the lock.
        return False
    return result.matched_count > 0 or result.upserted_id is not None


async def _renew_loop():
    while True:
        await asyncio.sleep(_RENEW_INTERVAL_SECONDS)
        try:
            await _locks_col().update_one(
                {"_id": _LOCK_ID, "holder": _holder_id},
                {"$set": {"expires_at": datetime.now(timezone.utc) + _TTL}},
            )
        except Exception:
            logger.exception("[LeaderLock] Failed to renew scheduler lock")


async def acquire_scheduler_leadership() -> bool:
    """Returns True if this process should run the scheduler."""
    global _renew_task
    acquired = await _try_acquire()
    if acquired:
        logger.info("[LeaderLock] This worker acquired scheduler leadership.")
        _renew_task = asyncio.create_task(_renew_loop())
    else:
        logger.info("[LeaderLock] Another worker already holds scheduler leadership.")
    return acquired


async def release_scheduler_leadership() -> None:
    global _renew_task
    if _renew_task:
        _renew_task.cancel()
        _renew_task = None
    try:
        await _locks_col().delete_one({"_id": _LOCK_ID, "holder": _holder_id})
    except Exception:
        logger.exception("[LeaderLock] Failed to release scheduler lock")
