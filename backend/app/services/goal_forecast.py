"""
Study-goal pacing forecast -- turns the mastery data the app already
computes into a forward-looking projection ("at this rate you'll hit X% by
Friday") instead of only ever showing a static current-state number.

Linear-rate model, deliberately simple -- consistent with this codebase's
existing preference for explainable heuristics over statistical modeling
(see rl_engine.py's reward shaping, subject_performance.py's bias formula):
assumes mastery has grown roughly linearly from 0% at the tracking start
date (a timetable's week_start) to its current value, and extrapolates that
same daily rate forward to the deadline.
"""
from __future__ import annotations

from datetime import date

# Below this many elapsed days, a rate estimate is too noisy to extrapolate
# from -- one unusually good or bad quiz session would swing the projection
# wildly on day 1.
MIN_DAYS_FOR_FORECAST = 2

# How far below the target the projection has to fall before it's flagged
# "behind" rather than "on_track" -- avoids flapping between statuses for a
# projection that's within a few points of the goal.
ON_TRACK_MARGIN_PCT = 5.0


def project_goal_status(
    overall_mastery_pct: float | None,
    target_mastery_pct: float,
    deadline: date,
    tracking_start: date,
    today: date,
) -> dict:
    """
    Returns {"days_remaining": int, "projected_mastery_pct": float | None, "status": str}.

    status is one of:
      "goal_met"        -- already at or above target, regardless of deadline
      "deadline_passed" -- deadline has passed and target wasn't met
      "not_enough_data" -- too little history yet to extrapolate a rate
      "on_track"        -- projected to reach target (within margin) by the deadline
      "behind"          -- projected to fall short of target by the deadline
    """
    current = overall_mastery_pct or 0.0
    days_remaining = (deadline - today).days

    if current >= target_mastery_pct:
        return {
            "days_remaining": max(days_remaining, 0),
            "projected_mastery_pct": round(current, 1),
            "status": "goal_met",
        }

    if days_remaining <= 0:
        return {
            "days_remaining": 0,
            "projected_mastery_pct": round(current, 1),
            "status": "deadline_passed",
        }

    days_elapsed = (today - tracking_start).days
    if days_elapsed < MIN_DAYS_FOR_FORECAST:
        return {
            "days_remaining": days_remaining,
            "projected_mastery_pct": None,
            "status": "not_enough_data",
        }

    daily_rate = current / days_elapsed
    projected = min(100.0, current + daily_rate * days_remaining)
    status = "on_track" if projected >= target_mastery_pct - ON_TRACK_MARGIN_PCT else "behind"

    return {
        "days_remaining": days_remaining,
        "projected_mastery_pct": round(projected, 1),
        "status": status,
    }
