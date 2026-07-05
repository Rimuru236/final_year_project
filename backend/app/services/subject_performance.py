from __future__ import annotations

import difflib

from ..core.database import notes_col, note_sections_col, progress_col
from .mastery import weighted_mastery_pct

MIN_ATTEMPTS_FOR_BIAS = 3
LOW_BAND_PCT = 60.0    # aggregate below this -> increase hours
HIGH_BAND_PCT = 85.0   # aggregate above this -> decrease hours
MAX_BIAS_PCT = 0.20    # cap adjustment at +/-20% of the base recommended_hours

# Real subjects are free-text and prone to typos/variants ("Mordern" vs
# "Modern"). 0.85 empirically separates near-duplicates (typos, extra
# whitespace, singular/plural — typically 0.88-0.97) from genuinely
# different subjects (typically <0.5).
SUBJECT_SIMILARITY_THRESHOLD = 0.85


def _subjects_match(a: str, b: str) -> bool:
    if a == b:
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= SUBJECT_SIMILARITY_THRESHOLD


async def get_subject_aggregate_score(user_id: str, subject: str) -> tuple[float | None, int]:
    """
    3-hop join: progress -> note_sections (by section_id) -> notes (by note_id),
    filtered to this user's notes whose subject fuzzy-matches (case/whitespace-
    insensitive, plus a similarity threshold for typos/near-duplicates).
    Returns (aggregate_score_0_100 | None, attempt_count).
    None means "insufficient data" — caller must not apply a bias.
    """
    norm_subject = subject.strip().lower()

    notes = await notes_col().find(
        {"user_id": user_id},
        {"_id": 1, "subject": 1},
    ).to_list(500)
    matching_note_ids = [
        n["_id"] for n in notes
        if _subjects_match(norm_subject, n.get("subject", "").strip().lower())
    ]
    if not matching_note_ids:
        return None, 0

    sections = await note_sections_col().find(
        {"note_id": {"$in": matching_note_ids}},
        {"_id": 1},
    ).to_list(2000)
    section_ids = [s["_id"] for s in sections]
    if not section_ids:
        return None, 0

    docs = await progress_col().find(
        {"user_id": user_id, "section_id": {"$in": section_ids}},
        {"score_pct": 1, "date": 1},
    ).sort("date", 1).to_list(1000)

    if len(docs) < MIN_ATTEMPTS_FOR_BIAS:
        return None, len(docs)

    return weighted_mastery_pct(docs), len(docs)


def apply_subject_bias(recommended_hours: float, aggregate_pct: float | None) -> tuple[float, bool]:
    """
    Nudge recommended_hours based on this user's own historical performance
    in the same subject. Returns (adjusted_hours, bias_applied).
    """
    if aggregate_pct is None:
        return recommended_hours, False

    if aggregate_pct < LOW_BAND_PCT:
        severity = min((LOW_BAND_PCT - aggregate_pct) / LOW_BAND_PCT, 1.0)
        factor = 1.0 + MAX_BIAS_PCT * severity
    elif aggregate_pct > HIGH_BAND_PCT:
        severity = min((aggregate_pct - HIGH_BAND_PCT) / (100 - HIGH_BAND_PCT), 1.0)
        factor = 1.0 - MAX_BIAS_PCT * severity
    else:
        return recommended_hours, False

    adjusted = max(1.0, round(recommended_hours * factor, 1))  # same floor as predict.py
    return adjusted, True
