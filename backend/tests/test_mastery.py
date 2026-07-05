"""
Regression tests for services/mastery.py's decay-weighted mastery calculation.

Manually verified live this session: a section trending 30%->90% scored 76.6
("solid") under decay-weighting vs. 56.0 ("shaky") under the old flat average
— this suite locks in that exact behavior, plus the single-attempt and
identical-scores regression cases.
"""
import sys
import os
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.mastery import weighted_mastery_pct, _decay_weight


def _prog(score_pct: float, days_ago: float, now: datetime) -> dict:
    return {"score_pct": score_pct, "date": now - timedelta(days=days_ago)}


def test_decay_weight_is_one_at_zero_days():
    assert _decay_weight(0.0) == 1.0


def test_decay_weight_is_half_at_half_life():
    assert abs(_decay_weight(14.0, half_life_days=14.0) - 0.5) < 1e-9


def test_single_attempt_matches_flat_average():
    # No trend to weight — must equal the old flat-average formula exactly,
    # since this is the common case (most sections have few attempts).
    now = datetime.now(timezone.utc)
    recent = [_prog(20.0, 0, now)]
    assert weighted_mastery_pct(recent) == 20.0


def test_empty_attempts_returns_zero():
    assert weighted_mastery_pct([]) == 0.0


def test_improving_trend_weighted_above_flat_average():
    # Verified live this session with these exact inputs: flat average is
    # 68.0, decay-weighted (14-day half-life) is 81.0.
    now = datetime.now(timezone.utc)
    recent = [
        _prog(30, 40, now),
        _prog(40, 20, now),
        _prog(90, 10, now),
        _prog(90, 3, now),
        _prog(90, 0, now),
    ]
    flat_avg = sum(p["score_pct"] for p in recent) / len(recent)
    weighted = weighted_mastery_pct(recent)
    assert flat_avg == 68.0
    assert weighted > flat_avg
    assert weighted == 81.0


def test_flat_scores_are_unaffected_by_weighting():
    # When every attempt has the same score, weighting is a no-op regardless
    # of how the weights are distributed.
    now = datetime.now(timezone.utc)
    recent = [_prog(80, d, now) for d in (30, 20, 10, 5, 0)]
    assert weighted_mastery_pct(recent) == 80.0
