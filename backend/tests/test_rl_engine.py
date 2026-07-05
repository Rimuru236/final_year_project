"""
Regression tests for services/rl_engine.py's pure reward-shaping logic.

_reward()'s response-time capping was manually verified live this session
(identical 90% scores produced different Q-values depending on response
time) — this test suite makes that regression-safe going forward.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.rl_engine import _reward, _score_band, apply_action


def test_score_band_boundaries():
    assert _score_band(59.9) == "low"
    assert _score_band(60.0) == "mid"
    assert _score_band(79.9) == "mid"
    assert _score_band(80.0) == "high"


def test_reward_by_band_without_timing():
    assert _reward(90) == 1.0
    assert _reward(70) == 0.0
    assert _reward(40) == -1.0


def test_reward_high_score_fast_response_gets_full_reward():
    assert _reward(90, avg_response_time_pct=40) == 1.0


def test_reward_high_score_slow_response_is_capped():
    # Correct-but-slow (>=85% of allotted time used) should not get the same
    # reward as a fast, confident answer — this is what stops premature
    # hour cuts on content the student is still working hard on.
    assert _reward(90, avg_response_time_pct=85) == 0.0
    assert _reward(90, avg_response_time_pct=99) == 0.0


def test_reward_mid_and_low_bands_unaffected_by_timing():
    # Timing only tempers the *high*-score reward; mid/low bands are
    # already 0/-1 and shouldn't change based on response time.
    assert _reward(70, avg_response_time_pct=99) == 0.0
    assert _reward(40, avg_response_time_pct=99) == -1.0


def test_apply_action_respects_floor_and_ceiling():
    assert apply_action(0.1, "decrease") >= 0.25  # MIN_SLOT_HOURS floor
    assert apply_action(7.0, "increase") <= 8.0    # MAX_SLOT_HOURS ceiling


def test_apply_action_keep_is_noop():
    assert apply_action(2.5, "keep") == 2.5
