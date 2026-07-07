import uuid
import logging
from collections import defaultdict
from datetime import datetime, timezone, date
from fastapi import APIRouter, HTTPException, Depends

from ..core.database import progress_col, note_sections_col, timetables_col, notes_col
from ..core.security import get_current_user
from ..schemas import ProgressSubmit, WeeklyReport, SectionProgress, DayProgress, SectionMastery, MasteryReport, GoalForecast
from ..services.rl_engine import update_q_table
from ..services.notifications import notify_user
from ..services.mastery import weighted_mastery_pct, DEFAULT_HALF_LIFE_DAYS
from ..services.goal_forecast import project_goal_status

# "Due for review" nudge: a solid section not attempted in this many days —
# reuses the same half-life used to decay-weight mastery, since that's
# already the point at which an attempt's influence has meaningfully faded.
REVIEW_DUE_DAYS = DEFAULT_HALF_LIFE_DAYS

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/progress", tags=["progress"])


@router.post("/submit")
async def submit_progress(body: ProgressSubmit, current: dict = Depends(get_current_user)):
    user_id = current["user_id"]

    # P1: Basic logical consistency check
    if body.correct_answers > body.questions_attempted:
        raise HTTPException(
            status_code=422,
            detail="correct_answers cannot exceed questions_attempted",
        )

    # P2: Ownership check — ensure the section belongs to this user's note
    section = await note_sections_col().find_one({"_id": body.section_id})
    if section:
        note_id = section.get("note_id")
    else:
        if "_" in body.section_id:
            base_id = body.section_id.rsplit("_", 1)[0]
            base_section = await note_sections_col().find_one({"_id": base_id})
            note_id = base_section.get("note_id") if base_section else None
        else:
            note_id = None

    if note_id:
        note = await notes_col().find_one({"_id": note_id, "user_id": user_id})
        if not note:
            raise HTTPException(
                status_code=403,
                detail="Access denied: section does not belong to your account",
            )

    count = await progress_col().count_documents({"user_id": user_id, "section_id": body.section_id})

    doc = {
        "_id":                 str(uuid.uuid4()),
        "user_id":             user_id,
        "section_id":          body.section_id,
        "timetable_id":        body.timetable_id,
        "score_pct":           body.score_pct,
        "questions_attempted": body.questions_attempted,
        "correct_answers":     body.correct_answers,
        "attempt_number":      count + 1,
        "date":                datetime.now(timezone.utc),
        "avg_response_time_pct": body.avg_response_time_pct,
        "avg_confidence_pct": body.avg_confidence_pct,
    }
    await progress_col().insert_one(doc)

    # RL update — response time and self-reported confidence (when available)
    # temper the reward so a correct-but-slow or correct-but-guessed answer
    # doesn't get treated the same as a fast, confident one.
    action = await update_q_table(
        user_id, body.section_id, body.score_pct,
        body.avg_response_time_pct, body.avg_confidence_pct,
    )

    logger.info(
        "[Progress] user=%s section=%s score=%.1f%% response_time=%s confidence=%s action=%s",
        user_id, body.section_id, body.score_pct,
        body.avg_response_time_pct, body.avg_confidence_pct, action,
    )

    return {
        "message": "Progress saved",
        "attempt_number": count + 1,
        "rl_action": action,
        "score_pct": body.score_pct,
    }


@router.get("/report/{timetable_id}", response_model=WeeklyReport)
async def weekly_report(timetable_id: str, current: dict = Depends(get_current_user)):
    user_id = current["user_id"]

    timetable = await timetables_col().find_one({"_id": timetable_id, "user_id": user_id})
    if not timetable:
        raise HTTPException(status_code=404, detail="Timetable not found")

    # ── Build per-day section membership ──────────────────────────────────────
    # day_sections maps day_name -> list[section_id] in timetable order.
    # Used for both the existing section-level report and the new daily_breakdown.
    day_sections: dict[str, list[str]] = {}
    all_slots = []
    for day_name, day_slots in timetable["days"].items():
        day_sections[day_name] = [s["section_id"] for s in day_slots]
        all_slots.extend(day_slots)

    section_ids = list({s["section_id"] for s in all_slots})
    hours_map = {s["section_id"]: s["hours_allocated"] for s in all_slots}

    sections_data = await note_sections_col().find({"_id": {"$in": section_ids}}).to_list(100)
    title_map = {s["_id"]: s["title"] for s in sections_data}

    # Single $in query for all progress (avoids N+1)
    all_progress = await progress_col().find(
        {"user_id": user_id, "section_id": {"$in": section_ids}}
    ).sort("date", -1).to_list(500)

    progs_by_section: dict[str, list] = defaultdict(list)
    for p in all_progress:
        progs_by_section[p["section_id"]].append(p)

    # ── Section-level report (unchanged from original) ─────────────────────
    section_reports = []
    reassignment_log = []
    total_score = 0
    total_improvement = 0
    total_attempts = 0

    for sec_id in section_ids:
        progs = progs_by_section.get(sec_id, [])
        if not progs:
            continue

        current_score  = progs[0]["score_pct"]
        previous_score = progs[1]["score_pct"] if len(progs) > 1 else None
        improvement    = (current_score - previous_score) if previous_score is not None else 0.0
        attempt_no     = progs[0]["attempt_number"]

        section_reports.append(SectionProgress(
            section_id=sec_id,
            section_title=title_map.get(sec_id, sec_id[:20]),
            current_score=current_score,
            previous_score=previous_score,
            improvement=improvement,
            attempt_number=attempt_no,
            hours_allocated=hours_map.get(sec_id, 0),
        ))
        total_score       += current_score
        total_improvement += improvement
        total_attempts    += attempt_no

        if improvement < -5:
            reassignment_log.append(
                f"{title_map.get(sec_id, sec_id)[:30]}: hours increased due to {current_score:.0f}% score"
            )
        elif improvement > 15:
            reassignment_log.append(
                f"{title_map.get(sec_id, sec_id)[:30]}: hours reduced — great improvement!"
            )

    # ── D2-1: Per-day breakdown ────────────────────────────────────────────────
    # For each day in the timetable, average the latest scores across its sections.
    # Days with no progress attempts are still included with zero counts.
    daily_breakdown: dict[str, DayProgress] = {}
    for day_name, sec_ids_for_day in day_sections.items():
        if not sec_ids_for_day:
            continue
        scores = []
        attempted = 0
        for sec_id in sec_ids_for_day:
            progs = progs_by_section.get(sec_id, [])
            if progs:
                scores.append(progs[0]["score_pct"])
                attempted += 1

        avg_score = round(sum(scores) / len(scores), 1) if scores else 0.0
        daily_breakdown[day_name] = DayProgress(
            day_name=day_name,
            average_score=avg_score,
            section_count=len(sec_ids_for_day),
            attempted_count=attempted,
        )

    # ── D2-2: Notify if this is the first time sections are available ─────────
    # The timetable was just created (version 1) and we're reporting on it —
    # fire the "sections are ready" notification for the first day that has slots.
    first_day = next(
        (d for d, slots in timetable["days"].items() if slots),
        None
    )
    if first_day and timetable.get("version", 1) == 1 and not all_progress:
        # Only trigger once — when there's no progress yet (first visit to report)
        await notify_user(
            user_id=user_id,
            event="day_sections_ready",
            payload={
                "timetable_id": timetable_id,
                "day_name": first_day,
            },
        )

    # D3: merge timetable-level reassignment_log_entries (day-swap events written
    # by adapt_timetable) into the section-level reassignment_log so the frontend
    # shows both hour-change and day-swap events in one list.
    timetable_swap_log: list[str] = timetable.get("reassignment_log_entries", [])
    combined_log = timetable_swap_log + reassignment_log

    n = len(section_reports) or 1
    return WeeklyReport(
        user_id=user_id,
        week_label=timetable.get("week_start", "This week"),
        sections=section_reports,
        overall_score=round(total_score / n, 1),
        overall_improvement=round(total_improvement / n, 1),
        total_attempts=total_attempts,
        reassignment_log=combined_log,
        daily_breakdown=daily_breakdown,
    )


@router.get("/section/{section_id}")
async def section_history(section_id: str, current: dict = Depends(get_current_user)):
    """
    P4: Added ownership check — without this any user can read any other
    user's section history by guessing or enumerating section UUIDs.
    """
    user_id = current["user_id"]

    section = await note_sections_col().find_one({"_id": section_id})
    if section:
        note = await notes_col().find_one({"_id": section["note_id"], "user_id": user_id})
        if not note:
            raise HTTPException(status_code=403, detail="Access denied")

    docs = await progress_col().find(
        {"user_id": user_id, "section_id": section_id}
    ).sort("date", 1).to_list(50)
    return [{"attempt": d["attempt_number"], "score": d["score_pct"], "date": d["date"]} for d in docs]


@router.get("/mastery/{timetable_id}", response_model=MasteryReport)
async def section_mastery(timetable_id: str, current: dict = Depends(get_current_user)):
    """
    Feature 1: Section Mastery Classification Endpoint
    Computes mastery level per section using the last 5 quiz scores,
    and classifies each section as solid, shaky, revise, or untouched.
    """
    user_id = current["user_id"]

    # 1. Fetch timetable with ownership check
    timetable = await timetables_col().find_one({"_id": timetable_id, "user_id": user_id})
    if not timetable:
        raise HTTPException(status_code=404, detail="Timetable not found")

    # 2. Collect all section_id values from all days' slots
    all_slots = []
    for day_slots in timetable["days"].values():
        all_slots.extend(day_slots)

    section_ids = list({s["section_id"] for s in all_slots})
    hours_map = {s["section_id"]: s["hours_allocated"] for s in all_slots}

    # Build title_map from note_sections_col
    sections_data = await note_sections_col().find({"_id": {"$in": section_ids}}).to_list(100)
    title_map = {s["_id"]: s["title"] for s in sections_data}

    # 3. Fetch all progress documents for this user + these section IDs, sorted by date ascending
    all_progress = await progress_col().find(
        {"user_id": user_id, "section_id": {"$in": section_ids}}
    ).sort("date", 1).to_list(500)

    # Group progress by section_id
    progs_by_section: dict[str, list] = defaultdict(list)
    for p in all_progress:
        progs_by_section[p["section_id"]].append(p)

    # 4. Compute mastery for each section
    solid = []
    shaky = []
    revise = []
    untouched = []
    due_for_review = []
    mastery_values = []
    now = datetime.now(timezone.utc)

    for section_id in section_ids:
        progs = progs_by_section.get(section_id, [])
        if not progs:
            untouched.append(SectionMastery(
                section_id=section_id,
                section_title=title_map.get(section_id, section_id[:20]),
                mastery_pct=None,
                classification="untouched",
                attempt_count=0,
                hours_allocated=hours_map.get(section_id, 0),
            ))
            continue

        # Take the last 5 attempts (progs is already date-ascending) and weight
        # them by recency — a recent attempt should count more than an old one.
        recent = progs[-5:]
        mastery_pct = weighted_mastery_pct(recent)

        # 5. Classify the section
        if mastery_pct >= 75:
            classification = "solid"
            section_mastery_entry = SectionMastery(
                section_id=section_id,
                section_title=title_map.get(section_id, section_id[:20]),
                mastery_pct=mastery_pct,
                classification=classification,
                attempt_count=len(progs),
                hours_allocated=hours_map.get(section_id, 0),
            )
            solid.append(section_mastery_entry)

            # "Due for review" — solid, but its most recent attempt is aging.
            last_attempt_date = progs[-1]["date"]
            if last_attempt_date.tzinfo is None:
                last_attempt_date = last_attempt_date.replace(tzinfo=timezone.utc)
            if (now - last_attempt_date).days >= REVIEW_DUE_DAYS:
                due_for_review.append(section_mastery_entry)
        elif mastery_pct >= 45:
            classification = "shaky"
            shaky.append(SectionMastery(
                section_id=section_id,
                section_title=title_map.get(section_id, section_id[:20]),
                mastery_pct=mastery_pct,
                classification=classification,
                attempt_count=len(progs),
                hours_allocated=hours_map.get(section_id, 0),
            ))
        else:
            classification = "revise"
            revise.append(SectionMastery(
                section_id=section_id,
                section_title=title_map.get(section_id, section_id[:20]),
                mastery_pct=mastery_pct,
                classification=classification,
                attempt_count=len(progs),
                hours_allocated=hours_map.get(section_id, 0),
            ))

        mastery_values.append(mastery_pct)

    # 6. Compute overall_mastery_pct as unweighted average of all non-None mastery values
    overall_mastery_pct = round(sum(mastery_values) / len(mastery_values), 1) if mastery_values else None

    # 7. Build sections_by_day mapping for frontend day-scoped filtering
    sections_by_day: dict[str, list[str]] = {
        day_name: [slot["section_id"] for slot in day_slots]
        for day_name, day_slots in timetable["days"].items()
        if day_slots  # skip empty days
    }

    # 7b. Pacing forecast — only when a goal has been set on this timetable
    # (PUT /timetable/{id}/goal). week_start is used as the tracking-start
    # reference point for the linear-rate extrapolation.
    goal_forecast = None
    goal_mastery_pct = timetable.get("goal_mastery_pct")
    goal_deadline_str = timetable.get("goal_deadline")
    if goal_mastery_pct is not None and goal_deadline_str:
        deadline = date.fromisoformat(goal_deadline_str)
        tracking_start = date.fromisoformat(timetable["week_start"])
        projection = project_goal_status(
            overall_mastery_pct=overall_mastery_pct,
            target_mastery_pct=goal_mastery_pct,
            deadline=deadline,
            tracking_start=tracking_start,
            today=now.date(),
        )
        goal_forecast = GoalForecast(
            target_mastery_pct=goal_mastery_pct,
            deadline=deadline,
            days_remaining=projection["days_remaining"],
            projected_mastery_pct=projection["projected_mastery_pct"],
            status=projection["status"],
        )

    # 8. Return MasteryReport
    return MasteryReport(
        timetable_id=timetable_id,
        solid=solid,
        shaky=shaky,
        revise=revise,
        untouched=untouched,
        total_sections=len(section_ids),
        overall_mastery_pct=overall_mastery_pct,
        sections_by_day=sections_by_day,
        goal=goal_forecast,
        due_for_review=due_for_review,
    )
