from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from ..core.database import progress_col, users_col
from .notifications import notify_user

logger = logging.getLogger(__name__)

# Only nudge users who'd actually lose something meaningful — a 1-2 day streak
# lapsing isn't worth an email, but losing a week+ is.
MIN_STREAK_FOR_NUDGE = 3


@dataclass
class StreakResult:
    current_streak: int
    longest_streak: int
    last_study_date: str | None
    studied_today: bool


async def compute_streak(user_id: str) -> StreakResult:
    """
    Compute a user's consecutive-day study streak from progress_col() —
    shared by GET /settings/streak and the daily streak-nudge job so both
    use one, correctly-dated implementation.
    """
    docs = await progress_col().find({"user_id": user_id}, {"date": 1}).to_list(2000)

    unique_dates: set[date] = set()
    for p in docs:
        d = p.get("date")
        if not d:
            continue
        if hasattr(d, "date"):
            unique_dates.add(d.date())
        else:
            try:
                unique_dates.add(datetime.fromisoformat(str(d).replace("Z", "+00:00")).date())
            except ValueError:
                pass

    if not unique_dates:
        return StreakResult(current_streak=0, longest_streak=0, last_study_date=None, studied_today=False)

    today = datetime.now(timezone.utc).date()
    sorted_dates = sorted(unique_dates, reverse=True)

    # Walk backwards from today (or yesterday, if nothing logged yet today)
    # counting consecutive days.
    current_streak = 0
    check_date = today if today in unique_dates else today - timedelta(days=1)
    while check_date in unique_dates:
        current_streak += 1
        check_date -= timedelta(days=1)

    # Longest streak ever, scanning chronologically.
    longest_streak = 0
    temp_streak = 0
    prev_date: date | None = None
    for d in sorted(unique_dates):
        temp_streak = temp_streak + 1 if prev_date and (d - prev_date).days == 1 else 1
        longest_streak = max(longest_streak, temp_streak)
        prev_date = d

    return StreakResult(
        current_streak=current_streak,
        longest_streak=longest_streak,
        last_study_date=sorted_dates[0].isoformat(),
        studied_today=today in unique_dates,
    )


async def run_streak_nudge_job() -> dict:
    """
    Daily evening job: for every user with an active streak who hasn't
    studied yet today, send a "keep your streak alive" reminder. Registered
    in main.py's lifespan alongside the existing note-lifecycle job.

    Note: this fires at one fixed UTC hour for all users — there's no
    per-user timezone-aware scheduling in this codebase yet (users.timezone
    is a display-only field, unused elsewhere), so "evening" is approximate
    for users outside UTC.
    """
    users = await users_col().find({}, {"_id": 1}).to_list(10000)

    nudged = 0
    for u in users:
        user_id = str(u["_id"])
        result = await compute_streak(user_id)
        if not result.studied_today and result.current_streak >= MIN_STREAK_FOR_NUDGE:
            await notify_user(user_id, "streak_reminder", {"current_streak": result.current_streak})
            nudged += 1

    summary = {
        "run_at": datetime.now(timezone.utc),
        "users_checked": len(users),
        "nudged": nudged,
    }
    logger.info("[Streak] Nudge job complete: %s", summary)
    return summary
