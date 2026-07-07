"""
Note & Storage Lifecycle Management — Day 8.

Implements a background APScheduler job that archives the bulk text content of
old notes to prevent unbounded MongoDB storage growth.

Lifecycle policy (documented in CHANGELOG D8-1; revision-nudge grace period
added as a follow-up to reconcile this with spaced-repetition mastery decay):
  SCORED  archive: content cleared when the note hasn't been STUDIED in >= 30
                   days (per-user override: users.archive_after_days) AND its
                   best score >= 80%. Keyed off last study activity rather
                   than note creation date — a note the user keeps revisiting
                   isn't archived just because the note itself is old.

                   Crossing this threshold no longer clears content
                   immediately: it's exactly the "solid but aging" signal
                   spaced repetition should use to resurface material for
                   review, not delete it. Instead, one "revision_due"
                   notification is sent and notes.revision_nudge_sent_at is
                   stamped; the note is only actually archived if
                   REVIEW_GRACE_DAYS pass with no further study activity. If
                   the student studies the note again in the meantime,
                   last_studied_at advances past the cutoff and the note
                   drops out of archive-eligibility entirely until it ages
                   past the threshold again (which resets the nudge).
  HARD    archive: content cleared unconditionally at 90 days since creation,
                   regardless of score or study activity (prevents indefinite
                   growth for notes never studied — a true storage ceiling).
                   Not subject to the revision-nudge grace period — this is
                   an unconditional ceiling by design.

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

# Spaced-repetition reconciliation: a note that just crossed the scored-archive
# threshold is, by definition, exactly the "solid but aging" content spaced
# repetition would want to resurface for review — not delete. Rather than
# clearing it immediately, send one revision-due nudge and give the student
# this many days to revisit it (which pushes last_studied_at forward and
# pulls the note back out of archive-eligibility) before archiving for real.
REVIEW_GRACE_DAYS = 7


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
    from app.services.notifications import notify_user

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
        {"_id": 1, "created_at": 1, "user_id": 1, "revision_nudge_sent_at": 1, "filename": 1, "subject": 1},
    ).to_list(5000)

    archived_scored = 0
    archived_hard   = 0
    nudged          = 0
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
            nudge_sent_at = note.get("revision_nudge_sent_at")
            if nudge_sent_at and nudge_sent_at.tzinfo is None:
                nudge_sent_at = nudge_sent_at.replace(tzinfo=timezone.utc)

            # A nudge sent before the student's last study session is stale —
            # they already came back once since then, so this is a fresh
            # archive-eligibility window (they let it lapse again) rather
            # than a continuation of the old grace period.
            if nudge_sent_at and nudge_sent_at < last_studied_at:
                nudge_sent_at = None

            if nudge_sent_at is None:
                # First time this note has crossed the scored-archive
                # threshold (or has again, after a review reset it). Give
                # the student one revision-due nudge and a grace window to
                # act on it before content is actually cleared — spaced
                # repetition should resurface aging-but-solid material, not
                # silently delete the ability to re-quiz it.
                await notes_col().update_one(
                    {"_id": note["_id"]},
                    {"$set": {"revision_nudge_sent_at": now}},
                )
                await notify_user(
                    note["user_id"],
                    "revision_due",
                    {
                        "note_id": note_id,
                        "best_score": best_score,
                        "subject": note.get("subject"),
                        "filename": note.get("filename"),
                    },
                )
                nudged += 1
                skipped += 1
                continue

            if (now - nudge_sent_at).days < REVIEW_GRACE_DAYS:
                # Still inside the grace window — give the nudge time to work.
                skipped += 1
                continue

            # Grace period elapsed with no further review — archive now.
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
        "nudged_for_review": nudged,
        "skipped":         skipped,
    }
    logger.info("[Lifecycle] Job complete — %s", summary)
    return summary
