from __future__ import annotations

import math

# Half of lifecycle.py's SCORED_ARCHIVE_DAYS=30 "recently active" window — a
# 3-day-old attempt stays ~86% weight, a 30-day-old one drops to ~18%.
DEFAULT_HALF_LIFE_DAYS = 14.0


def _decay_weight(days_since_latest: float, half_life_days: float = DEFAULT_HALF_LIFE_DAYS) -> float:
    """Exponential recency weight: 1.0 at day 0, 0.5 at half_life_days."""
    return math.exp(-math.log(2) * days_since_latest / half_life_days)


def weighted_mastery_pct(recent_progs: list[dict]) -> float:
    """
    recent_progs: up to 5 most-recent progress docs for a section (each with
    "score_pct" and "date"), date-ascending.

    Weights each attempt's normalized (0-2 scale) score by exponential
    recency decay relative to the *most recent attempt in the set* (not
    "now" — so mastery doesn't decay just because the user hasn't opened the
    app), then returns a weighted average expressed as a 0-100 mastery_pct —
    the same output shape/scale as a flat average.
    """
    if not recent_progs:
        return 0.0

    latest_date = recent_progs[-1]["date"]
    weights, values = [], []
    for p in recent_progs:
        days_since = max((latest_date - p["date"]).total_seconds() / 86400.0, 0.0)
        weights.append(_decay_weight(days_since))
        values.append(p["score_pct"] / 50.0)  # same 0-2 normalization as before

    weight_total = sum(weights)
    avg_normalized = sum(w * v for w, v in zip(weights, values)) / weight_total if weight_total else 0.0
    return round((avg_normalized / 2) * 100, 1)
