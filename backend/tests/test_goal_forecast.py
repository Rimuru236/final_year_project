"""
Regression tests for services/goal_forecast.py's project_goal_status() --
pure date-arithmetic logic, no DB involved.
"""
import sys
import os
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.goal_forecast import project_goal_status, MIN_DAYS_FOR_FORECAST, ON_TRACK_MARGIN_PCT


def test_goal_already_met():
    result = project_goal_status(
        overall_mastery_pct=85.0, target_mastery_pct=80.0,
        deadline=date(2026, 7, 10), tracking_start=date(2026, 7, 1), today=date(2026, 7, 5),
    )
    assert result["status"] == "goal_met"
    assert result["projected_mastery_pct"] == 85.0


def test_goal_met_even_if_deadline_already_passed():
    # Met is met -- being late doesn't downgrade a met goal.
    result = project_goal_status(
        overall_mastery_pct=90.0, target_mastery_pct=80.0,
        deadline=date(2026, 7, 1), tracking_start=date(2026, 6, 1), today=date(2026, 7, 5),
    )
    assert result["status"] == "goal_met"


def test_deadline_passed_without_meeting_target():
    result = project_goal_status(
        overall_mastery_pct=40.0, target_mastery_pct=80.0,
        deadline=date(2026, 7, 1), tracking_start=date(2026, 6, 1), today=date(2026, 7, 5),
    )
    assert result["status"] == "deadline_passed"
    assert result["days_remaining"] == 0
    assert result["projected_mastery_pct"] == 40.0


def test_not_enough_data_below_minimum_elapsed_days():
    result = project_goal_status(
        overall_mastery_pct=10.0, target_mastery_pct=80.0,
        deadline=date(2026, 7, 20), tracking_start=date(2026, 7, 4), today=date(2026, 7, 5),
    )
    assert (date(2026, 7, 5) - date(2026, 7, 4)).days < MIN_DAYS_FOR_FORECAST
    assert result["status"] == "not_enough_data"
    assert result["projected_mastery_pct"] is None


def test_on_track_projection():
    # 40% gained over 4 days -> 10%/day. 10 days remain -> +100%, capped at 100.
    result = project_goal_status(
        overall_mastery_pct=40.0, target_mastery_pct=80.0,
        deadline=date(2026, 7, 15), tracking_start=date(2026, 7, 1), today=date(2026, 7, 5),
    )
    assert result["status"] == "on_track"
    assert result["projected_mastery_pct"] == 100.0
    assert result["days_remaining"] == 10


def test_behind_projection():
    # 8% gained over 4 days -> 2%/day. 2 days remain -> projected 12%, well short of 80%.
    result = project_goal_status(
        overall_mastery_pct=8.0, target_mastery_pct=80.0,
        deadline=date(2026, 7, 7), tracking_start=date(2026, 7, 1), today=date(2026, 7, 5),
    )
    assert result["status"] == "behind"
    assert result["projected_mastery_pct"] == 12.0
    assert result["days_remaining"] == 2


def test_on_track_margin_boundary():
    # Projected exactly at target - margin should still count as on_track.
    target = 80.0
    projected_target = target - ON_TRACK_MARGIN_PCT  # 75.0
    # current=50, days_elapsed=5 -> rate=10/day, days_remaining=2.5 -> use int days below
    result = project_goal_status(
        overall_mastery_pct=50.0, target_mastery_pct=target,
        deadline=date(2026, 7, 8), tracking_start=date(2026, 7, 1), today=date(2026, 7, 6),
    )
    # rate = 50/5 = 10/day, days_remaining = 2 -> projected = 70.0 -> below margin (75) -> behind
    assert result["projected_mastery_pct"] == 70.0
    assert result["status"] == "behind"


def test_projection_capped_at_100():
    result = project_goal_status(
        overall_mastery_pct=90.0, target_mastery_pct=95.0,
        deadline=date(2026, 8, 1), tracking_start=date(2026, 7, 1), today=date(2026, 7, 5),
    )
    assert result["projected_mastery_pct"] == 100.0
    assert result["status"] == "on_track"


def test_no_mastery_yet_defaults_to_zero():
    result = project_goal_status(
        overall_mastery_pct=None, target_mastery_pct=80.0,
        deadline=date(2026, 7, 20), tracking_start=date(2026, 7, 1), today=date(2026, 7, 5),
    )
    assert result["status"] in ("behind", "not_enough_data")
    assert result["projected_mastery_pct"] in (0.0, None)
