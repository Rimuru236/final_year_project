"""
Note & Storage Lifecycle Management — Day 8.

Implements a background APScheduler job that archives the bulk text content of
old notes to prevent unbounded MongoDB storage growth.

Lifecycle policy (documented in CHANGELOG D8-1):
  SCORED  archive: content cleared when the note hasn't been STUDIED in >= 30
                   days (per-user override: users.archive_after_days) AND its
                   best score >= 80%. Keyed off last study activity rather
                   than note creation date — a note the user keeps revisiting
                   isn't archived just because the note itself is old.
  HARD    archive: content cleared unconditionally at 90 days since creation,
                   regardless of score or study activity (prevents indefinite
                   growth for notes never studied — a true storage ceiling).

"Archive" means:
  - notes.raw_text → "" (nulled)
  - note_sections.content → "" (nulled per-section)
  - notes.content_archived = True, notes.archived_at = <timestamp>
  - All small metadata (filename, subject, topic, title, section_index, note_id,
    created_at, word_count) is PRESERVED so progress reports and the note list
    continue to work correctly.

MCQ fallback decision (per §0.3 ambiguity policy, documented here):
  Rather than pre-generating and caching MCQs before archival (which would
  consume Groq API credits at unknown cost and time), archived sections degrade
  gracefully: the MCQ endpoint already returns a 404/empty when no cached MCQs
  exist for a section, and the frontend already handles this.  This is simpler,
  more maintainable, and avoids surprise API charges.  The UploadPage will show
  an "Archived" badge so users know content is no longer interactive.

The scheduler runs daily at 02:00 UTC (low-traffic window).
It is started from main.py's lifespan so no separate process is needed.
"""

import logging
from datetime import datetime, timedelta, timezone
from bson import ObjectId

logger = logging.getLogger(__name__)

# ── Policy constants ──────────────────────────────────────────────────────────
SCORED_ARCHIVE_DAYS  = 30    # Archive if score >= SCORED_THRESHOLD and age >= 30 days
SCORED_THRESHOLD_PCT = 80.0  # Minimum overall score to qualify for early archive
HARD_ARCHIVE_DAYS    = 90    # Unconditional archive regardless of score


async def _get_note_progress_stats(note_id: str) -> tuple[float | None, datetime | None]:
    """
    Return (best_score, last_studied_at) across all progress records for this
    note's sections. Both None if the note has never been studied.

    last_studied_at drives SCORED archive eligibility (see run_lifecycle_job) —
    using the most recent *study* activity rather than the note's creation
    date means a note the user keeps revisiting doesn't get archived out from
    under them just because the note itself is old.
    """
    from app.core.database import progress_col, note_sections_col

    sections = await note_sections_col().find(
        {"note_id": note_id}, {"_id": 1}
    ).to_list(200)
    if not sections:
        return None, None

    section_ids = [s["_id"] for s in sections]

    docs = await progress_col().find(
        {"section_id": {"$in": section_ids}},
        {"score_pct": 1, "date": 1},
    ).sort("date", -1).to_list(200)

    if not docs:
        return None, None

    return max(d["score_pct"] for d in docs), docs[0]["date"]


async def _archive_note(note_id: str, reason: str) -> None:
    """
    Clear the bulk text fields of a single note and its sections.
    Preserves all metadata fields.
    """
    from app.core.database import notes_col, note_sections_col

    now = datetime.now(timezone.utc)

    # Clear note-level raw_text
    await notes_col().update_one(
        {"_id": note_id},
        {"$set": {
            "raw_text":         "",
            "content_archived": True,
            "archived_at":      now,
            "archive_reason":   reason,
        }},
    )

    # Clear section-level content (preserves title, section_index, word_count, etc.)
    await note_sections_col().update_many(
        {"note_id": note_id},
        {"$set": {"content": ""}},
    )

    logger.info("[Lifecycle] Archived note %s — reason: %s", note_id, reason)


async def run_lifecycle_job() -> dict:
    """
    Main lifecycle job — called by APScheduler daily at 02:00 UTC.

    Returns a summary dict for logging (not exposed via API).
    """
    from app.core.database import notes_col, users_col

    now    = datetime.now(timezone.utc)
    cutoff_scored = now - timedelta(days=SCORED_ARCHIVE_DAYS)
    cutoff_hard   = now - timedelta(days=HARD_ARCHIVE_DAYS)

    logger.info(
        "[Lifecycle] Starting note lifecycle job — scored_cutoff=%s hard_cutoff=%s",
        cutoff_scored.date(), cutoff_hard.date(),
    )

    # Only process notes that have NOT already been archived
    candidates = await notes_col().find(
        {"content_archived": {"$ne": True}},
        {"_id": 1, "created_at": 1, "user_id": 1},
    ).to_list(5000)

    archived_scored = 0
    archived_hard   = 0
    skipped         = 0

    for note in candidates:
        note_id    = str(note["_id"])
        created_at = note.get("created_at")

        if not created_at:
            skipped += 1
            continue

        # Ensure timezone-aware comparison
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)

        # ── Hard archive: unconditional at HARD_ARCHIVE_DAYS ──────────────
        if created_at <= cutoff_hard:
            await _archive_note(note_id, f"hard_archive_{HARD_ARCHIVE_DAYS}d")
            archived_hard += 1
            continue

        # ── Scored archive: last STUDIED >= SCORED_ARCHIVE_DAYS ago AND
        #    score >= 80% — keyed off last study activity, not note age, so a
        #    note the user keeps revisiting doesn't get archived just because
        #    it's old. (Hard archive above is intentionally unconditional —
        #    a true storage ceiling regardless of activity.)
        # Per-user override — fall back to global default if not set
        user_doc = await users_col().find_one(
            {"_id": ObjectId(note["user_id"])},
            {"archive_after_days": 1}
        )
        scored_days = (user_doc or {}).get("archive_after_days") or SCORED_ARCHIVE_DAYS
        cutoff_scored_user = now - timedelta(days=scored_days)

        best_score, last_studied_at = await _get_note_progress_stats(note_id)
        if last_studied_at and last_studied_at.tzinfo is None:
            last_studied_at = last_studied_at.replace(tzinfo=timezone.utc)

        if (
            best_score is not None
            and best_score >= SCORED_THRESHOLD_PCT
            and last_studied_at is not None
            and last_studied_at <= cutoff_scored_user
        ):
            await _archive_note(
                note_id,
                f"scored_archive_{scored_days}d_score{best_score:.0f}pct",
            )
            archived_scored += 1
            continue

        skipped += 1

    summary = {
        "run_at":          now.isoformat(),
        "candidates":      len(candidates),
        "archived_hard":   archived_hard,
        "archived_scored": archived_scored,
        "skipped":         skipped,
    }
    logger.info("[Lifecycle] Job complete — %s", summary)
    return summary
