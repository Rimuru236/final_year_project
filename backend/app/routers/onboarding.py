"""
Onboarding / Schedule Constraints router — Day 4.

Stores and retrieves per-user schedule constraints that are wired into
timetable generation.  Completely new router; does not modify any existing
router or collection.  Constraints are stored as sub-fields on the `users`
document — no new collection needed.

Fields stored on users document:
  weekday_free_hours:    dict[str, float]  e.g. {"Monday": 3.0, "Tuesday": 2.0}
  preferred_study_times: list[str]         e.g. ["morning", "evening"]
  blocked_days:          list[str]         e.g. ["Saturday", "Sunday"]
  default_break_ratio:   float             override for break calculation (0.1–0.5)
  preferred_session_length: float          hours per study block (0.5–4.0)

A user who has never visited this page has none of these fields on their
document — generate_timetable falls back to today's even distribution.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from bson import ObjectId

from ..core.database import users_col, progress_col
from ..core.security import get_current_user

router = APIRouter(prefix="/onboarding", tags=["onboarding"])

VALID_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
VALID_TIMES = ["early_morning", "morning", "afternoon", "evening", "night"]

# Behavior-derived blocked-day suggestions: only suggest once there's enough
# history to be a meaningful signal — a brand-new user hasn't "never studied"
# on a day, they just haven't gotten there yet.
MIN_ATTEMPTS_FOR_DAY_SUGGESTION = 5
MIN_HISTORY_DAYS_FOR_SUGGESTION = 21


async def _suggest_blocked_days(user_id: str, current_blocked: list[str] | None) -> list[str]:
    """
    Detect weekdays this user has never studied on, despite not having
    explicitly blocked them, once there's enough history (attempt count +
    time span) to treat that as a real pattern rather than a coincidence.
    """
    docs = await progress_col().find({"user_id": user_id}, {"date": 1}).to_list(2000)
    if len(docs) < MIN_ATTEMPTS_FOR_DAY_SUGGESTION:
        return []

    dates = [d["date"] for d in docs if d.get("date")]
    if not dates:
        return []

    span_days = (max(dates) - min(dates)).days
    if span_days < MIN_HISTORY_DAYS_FOR_SUGGESTION:
        return []

    studied_weekdays = {d.weekday() for d in dates}  # Python: 0=Monday .. 6=Sunday
    blocked = set(current_blocked or [])
    return [
        day_name for idx, day_name in enumerate(VALID_DAYS)
        if day_name not in blocked and idx not in studied_weekdays
    ]


class ScheduleConstraints(BaseModel):
    """
    Schedule constraints submitted by the student.
    All fields are optional — partial updates are supported via PATCH semantics
    (only keys present in the request body are written; others left unchanged).
    """
    weekday_free_hours: Optional[dict[str, float]] = None
    preferred_study_times: Optional[list[str]] = None
    blocked_days: Optional[list[str]] = None
    # 0.1 = 6-min break per hour, 0.5 = 30-min break per hour
    default_break_ratio: Optional[float] = Field(None, ge=0.1, le=0.5)
    # Preferred single-session length in hours before a break
    preferred_session_length: Optional[float] = Field(None, ge=0.25, le=4.0)


class ScheduleConstraintsResponse(ScheduleConstraints):
    """Extends request model with a flag indicating if constraints were ever saved."""
    has_constraints: bool
    # Weekdays this user appears to never study on (based on progress_col()
    # history) that aren't already in blocked_days — see _suggest_blocked_days().
    suggested_blocked_days: list[str] = []


@router.get("/schedule", response_model=ScheduleConstraintsResponse)
async def get_schedule(current: dict = Depends(get_current_user)):
    """
    Return the current user's saved schedule constraints.
    If no constraints have been saved yet, returns all-None fields with
    has_constraints=False — the frontend uses this to show first-time guidance.
    """
    user = await users_col().find_one({"_id": ObjectId(current["user_id"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    has = any(
        k in user for k in [
            "weekday_free_hours", "preferred_study_times",
            "blocked_days", "default_break_ratio", "preferred_session_length",
        ]
    )

    blocked_days = user.get("blocked_days")
    suggested = await _suggest_blocked_days(current["user_id"], blocked_days)

    return ScheduleConstraintsResponse(
        weekday_free_hours=user.get("weekday_free_hours"),
        preferred_study_times=user.get("preferred_study_times"),
        blocked_days=blocked_days,
        default_break_ratio=user.get("default_break_ratio"),
        preferred_session_length=user.get("preferred_session_length"),
        has_constraints=has,
        suggested_blocked_days=suggested,
    )


@router.put("/schedule", response_model=ScheduleConstraintsResponse)
async def save_schedule(
    body: ScheduleConstraints,
    current: dict = Depends(get_current_user),
):
    """
    Save (replace) the user's schedule constraints.
    Only the fields present in the request body are written; fields not included
    are left unchanged (PATCH semantics despite being a PUT endpoint, which is
    consistent with the rest of the codebase).

    Validation:
    - blocked_days and weekday_free_hours keys must be valid weekday names.
    - preferred_study_times values must be in VALID_TIMES.
    - free_hours values must be between 0 and 24.
    """
    update: dict = {}

    if body.blocked_days is not None:
        invalid = [d for d in body.blocked_days if d not in VALID_DAYS]
        if invalid:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid day name(s): {invalid}. Must be one of {VALID_DAYS}",
            )
        update["blocked_days"] = body.blocked_days

    if body.weekday_free_hours is not None:
        invalid_days = [d for d in body.weekday_free_hours if d not in VALID_DAYS]
        if invalid_days:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid day name(s) in weekday_free_hours: {invalid_days}",
            )
        invalid_hours = {d: h for d, h in body.weekday_free_hours.items() if not (0 <= h <= 24)}
        if invalid_hours:
            raise HTTPException(
                status_code=422,
                detail=f"Hours must be between 0 and 24: {invalid_hours}",
            )
        update["weekday_free_hours"] = body.weekday_free_hours

    if body.preferred_study_times is not None:
        invalid = [t for t in body.preferred_study_times if t not in VALID_TIMES]
        if invalid:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid study times: {invalid}. Must be one of {VALID_TIMES}",
            )
        update["preferred_study_times"] = body.preferred_study_times

    if body.default_break_ratio is not None:
        update["default_break_ratio"] = body.default_break_ratio

    if body.preferred_session_length is not None:
        update["preferred_session_length"] = body.preferred_session_length

    if update:
        await users_col().update_one(
            {"_id": ObjectId(current["user_id"])},
            {"$set": update},
        )

    # Return the merged state
    return await get_schedule(current)
