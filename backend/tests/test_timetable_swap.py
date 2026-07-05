"""
Regression tests for routers/timetable.py's day-swap logic (_pair_days_for_swap,
_swap_days). These are pure functions — no DB access — despite living in a
router module.

_swap_days's stale-moved_from bug and the swap_breadth feature were both
manually verified live this session; this suite locks in the exact behavior
without needing a live server or MongoDB.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.routers.timetable import _pair_days_for_swap, _swap_days


def _slot(section_id: str) -> dict:
    return {
        "section_id": section_id, "section_title": section_id, "section_content": "",
        "hours_allocated": 1.0, "start_time": "09:00", "end_time": "10:00", "break_minutes": 5,
    }


def test_pair_days_breadth_1_picks_single_worst_best_pair():
    scored = {"Monday": 90.0, "Tuesday": 40.0, "Wednesday": 60.0}
    pairs = _pair_days_for_swap(scored, breadth=1)
    assert pairs == [("Tuesday", "Monday")]


def test_pair_days_breadth_2_pairs_outside_in():
    scored = {"Monday": 90.0, "Tuesday": 40.0, "Wednesday": 60.0, "Thursday": 70.0}
    pairs = _pair_days_for_swap(scored, breadth=2)
    assert pairs == [("Tuesday", "Monday"), ("Wednesday", "Thursday")]


def test_pair_days_stops_on_tie():
    scored = {"Monday": 50.0, "Tuesday": 50.0, "Wednesday": 90.0}
    # Wednesday pairs with one of the tied 50s, but the remaining single day
    # can't form a second pair with itself.
    pairs = _pair_days_for_swap(scored, breadth=2)
    assert len(pairs) == 1


def test_pair_days_single_scored_day_produces_no_pairs():
    assert _pair_days_for_swap({"Monday": 80.0}, breadth=1) == []


def test_swap_days_default_breadth_swaps_one_pair_with_moved_from():
    days = {
        "Monday": [_slot("A")], "Tuesday": [_slot("B")], "Wednesday": [_slot("C")],
    }
    latest_progress = {"A": {"score_pct": 90}, "B": {"score_pct": 40}, "C": {"score_pct": 60}}
    log: list[str] = []

    result = _swap_days(days, latest_progress, log)

    assert result["Monday"][0]["section_id"] == "B"
    assert result["Monday"][0]["moved_from"] == "Tuesday"
    assert result["Tuesday"][0]["section_id"] == "A"
    assert result["Tuesday"][0]["moved_from"] == "Monday"
    assert result["Wednesday"][0]["section_id"] == "C"
    assert "moved_from" not in result["Wednesday"][0]
    assert len(log) == 1


def test_swap_days_breadth_2_swaps_two_pairs():
    days = {
        "Monday": [_slot("A")], "Tuesday": [_slot("B")],
        "Wednesday": [_slot("C")], "Thursday": [_slot("D")],
    }
    latest_progress = {
        "A": {"score_pct": 90}, "B": {"score_pct": 40},
        "C": {"score_pct": 60}, "D": {"score_pct": 70},
    }
    log: list[str] = []

    result = _swap_days(days, latest_progress, log, swap_breadth=2)

    assert result["Monday"][0]["section_id"] == "B"
    assert result["Wednesday"][0]["section_id"] == "D"
    assert result["Thursday"][0]["section_id"] == "C"
    assert len(log) == 2


def test_swap_days_no_moved_from_persists_across_calls():
    # Regression for the stale-moved_from bug: a day untouched by THIS round's
    # swap must not carry a moved_from stamp from a previous round.
    days_v1 = {"Monday": [_slot("A")], "Tuesday": [_slot("B")], "Wednesday": [_slot("C")]}
    log1: list[str] = []
    days_v2 = _swap_days(days_v1, {"A": {"score_pct": 90}, "B": {"score_pct": 10}, "C": {"score_pct": 50}}, log1)

    # Round 2: clear moved_from up front (mirrors adapt_timetable's Step 1
    # loop), then a different pair becomes the extremes — Tuesday untouched.
    days_v2_cleared = {d: [{**s, "moved_from": None} for s in slots] for d, slots in days_v2.items()}
    log2: list[str] = []
    days_v3 = _swap_days(days_v2_cleared, {"A": {"score_pct": 90}, "B": {"score_pct": 10}, "C": {"score_pct": 95}}, log2)

    assert days_v3["Tuesday"][0]["moved_from"] is None


def test_swap_days_no_progress_data_is_noop():
    days = {"Monday": [_slot("A")], "Tuesday": [_slot("B")]}
    log: list[str] = []
    result = _swap_days(days, {}, log)
    assert result == days
    assert log == []


def test_swap_days_single_active_day_is_noop():
    days = {"Monday": [_slot("A")], "Tuesday": []}
    log: list[str] = []
    result = _swap_days(days, {"A": {"score_pct": 90}}, log)
    assert result == days
    assert log == []
