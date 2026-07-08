import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends

from ..core.database import timetables_col, note_sections_col, progress_col, q_table_col, notes_col, users_col
from ..core.security import get_current_user
from ..schemas import TimetableGenerateRequest, TimetableResponse, TimetableSlot, StudyGoalRequest
from ..services.rl_engine import apply_action

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/timetable", tags=["timetable"])

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

START_HOUR = 9
MIN_SLOT_HOURS = 0.25  # 15 mins
MAX_SECTION_WORDS = 2000

# D4 follow-up: maps onboarding.py's VALID_TIMES labels to a schedule start
# hour. Mirrors the hour ranges shown in OnboardingPage.tsx's STUDY_TIME_LABELS
# (early_morning "5-8am", morning "8am-12pm", afternoon "12-5pm",
# evening "5-9pm", night "9pm-12am").
TIME_OF_DAY_START_HOUR = {
    "early_morning": 5,
    "morning": 8,
    "afternoon": 12,
    "evening": 17,
    "night": 21,
}


def _resolve_start_hour(preferred_study_times: list[str] | None) -> int:
    """
    Anchor the day's schedule to the earliest of the user's preferred study
    times, so a user who only selects "evening" gets sections starting at
    5pm instead of the 9am default. None/empty/all-invalid -> unchanged
    default behavior (START_HOUR).
    """
    if not preferred_study_times:
        return START_HOUR
    hours = [TIME_OF_DAY_START_HOUR[t] for t in preferred_study_times if t in TIME_OF_DAY_START_HOUR]
    return min(hours) if hours else START_HOUR


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _time_str(hour_offset: float, start_hour: int = START_HOUR) -> str:
    total_mins = int(hour_offset * 60)
    h = start_hour + total_mins // 60
    m = total_mins % 60
    h = min(h, 23)
    return f"{h:02d}:{m:02d}"


def _split_large_sections(sections: list[dict]) -> list[dict]:
    """
    Split oversized note sections into smaller study chunks.

    Example:
        Chapter 1 (5000 words)
            ->
        Chapter 1 Part 1
        Chapter 1 Part 2
        Chapter 1 Part 3
    """
    expanded_sections = []

    for sec in sections:
        content = sec.get("content", "")
        words = content.split()

        if len(words) <= MAX_SECTION_WORDS:
            expanded_sections.append(sec)
            continue

        logger.info(
            "[Timetable] Splitting large section '%s' (%d words)",
            sec.get("title", "Untitled"),
            len(words),
        )

        chunks = [
            words[i:i + MAX_SECTION_WORDS]
            for i in range(0, len(words), MAX_SECTION_WORDS)
        ]

        for idx, chunk in enumerate(chunks):
            expanded_sections.append({
                **sec,
                "_id": f"{sec['_id']}_{idx}",
                "title": f"{sec['title']} (Part {idx + 1})",
                "content": " ".join(chunk),
                "word_count": len(chunk),
            })

    logger.info("[Timetable] Expanded into %d study chunks", len(expanded_sections))
    return expanded_sections


def _distribute_sections(
    sections: list[dict],
    recommended_hours: float,
    study_days: int,
    is_weak: bool = False,
    # D4: optional per-user schedule constraints; None = today's default behaviour
    weekday_free_hours: dict | None = None,
    blocked_days: list | None = None,
    break_ratio_override: float | None = None,
    preferred_study_times: list[str] | None = None,
) -> dict[str, list]:
    """
    Distribute note sections across study days.

    Improvements (T2, T3):
    - Weak-topic prioritisation: larger (harder) sections are scheduled
      earlier in the week, not randomly distributed.
    - Tighter day-budget cap (1.1x instead of 1.2x) to prevent overloading.
    - proportional time allocation
    - round-robin distribution with least-loaded fallback
    - embedded segmented note content (full, not truncated)

    D4 additions (backward compatible — all new params default to None):
    - blocked_days: days omitted entirely from the schedule.
    - weekday_free_hours: per-day hour cap; day_budget capped to free_hours[day].
    - break_ratio_override: user-preferred break ratio replaces the global default.
    - preferred_study_times: anchors each day's start time to the earliest
      selected time-of-day block instead of the fixed 9am default.
    """
    start_hour = _resolve_start_hour(preferred_study_times)
    if not sections:
        logger.warning("[Timetable] No sections to distribute")
        return {d: [] for d in DAYS[:study_days]}

    # T2: Sort largest sections first so heavier content falls early in the week
    sorted_sections = sorted(sections, key=lambda s: s.get("word_count", 0), reverse=True)

    total_words = sum(s.get("word_count", 1) for s in sorted_sections) or 1

    # D4: build the active day list, skipping blocked_days
    active_days = [
        d for d in DAYS[:study_days]
        if not blocked_days or d not in blocked_days
    ]
    if not active_days:
        # All requested days are blocked — fall back to all days (defensive)
        logger.warning("[Timetable] All study days are blocked — ignoring block list")
        active_days = DAYS[:study_days]

    effective_study_days = len(active_days)
    day_budget = recommended_hours / effective_study_days

    # D4: per-day budget caps from weekday_free_hours
    day_caps: dict[str, float] = {}
    for day in active_days:
        if weekday_free_hours and day in weekday_free_hours:
            day_caps[day] = min(weekday_free_hours[day], day_budget * 1.5)
        else:
            day_caps[day] = day_budget

    # D4: break ratio — use per-user override if provided, otherwise global default
    break_ratio = break_ratio_override if break_ratio_override is not None else (10 / 60) / 0.75

    days_schedule: dict[str, list] = {d: [] for d in active_days}
    day_keys = list(days_schedule.keys())
    day_used = [0.0] * effective_study_days

    logger.info(
        "[Timetable] Distributing %d sections across %d active days (weak=%s, blocked=%s)",
        len(sorted_sections), effective_study_days, is_weak, blocked_days,
    )

    for i, sec in enumerate(sorted_sections):
        weight = sec.get("word_count", 1) / total_words
        alloc = max(round(recommended_hours * weight, 2), MIN_SLOT_HOURS)

        logger.info(
            "[Timetable] Section '%s' | words=%d | alloc=%.2f",
            sec.get("title", "Untitled"), sec.get("word_count", 0), alloc,
        )

        # Round-robin with least-loaded fallback
        natural_day = i % effective_study_days

        # T3 + D4: Tighter cap: respect both the 1.1x budget and per-day free_hours cap
        day_name_nat = day_keys[natural_day]
        cap = day_caps.get(day_name_nat, day_budget) * 1.1
        if day_used[natural_day] + alloc <= cap:
            day_idx = natural_day
        else:
            # Fall back to least-loaded day that still fits within its cap
            day_idx = next(
                (
                    j for j in sorted(range(effective_study_days), key=lambda x: day_used[x])
                    if day_used[j] + alloc <= day_caps.get(day_keys[j], day_budget) * 1.1
                ),
                day_used.index(min(day_used)),  # absolute fallback: least loaded
            )

        day_name = day_keys[day_idx]
        start_offset = day_used[day_idx]
        end_offset = start_offset + alloc
        break_mins = max(int(alloc / 0.75 * 10), 5)

        days_schedule[day_name].append(
            TimetableSlot(
                section_id=str(sec["_id"]),
                section_title=sec.get("title", "Untitled Section"),
                # Full content — smart truncation only happens inside MCQ generation
                section_content=sec.get("content", ""),
                hours_allocated=alloc,
                start_time=_time_str(start_offset, start_hour),
                end_time=_time_str(end_offset, start_hour),
                break_minutes=break_mins,
            )
        )

        day_used[day_idx] += alloc + alloc * break_ratio

        logger.debug(
            "[Timetable] '%s' -> %s | %.2fh",
            sec.get("title", "Untitled"), day_name, alloc,
        )

    return days_schedule


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/generate", response_model=TimetableResponse)
async def generate_timetable(
    body: TimetableGenerateRequest,
    current: dict = Depends(get_current_user),
):
    """
    Generate AI-powered study timetable.

    T4: Ownership check added — verifies the note belongs to the requesting
    user before building a timetable. Without this, any authenticated user
    could generate a timetable from another user's note by guessing its UUID.
    """
    # T4: Ownership check
    note = await notes_col().find_one({"_id": body.note_id, "user_id": current["user_id"]})
    if not note:
        raise HTTPException(
            status_code=403,
            detail="Note not found or access denied",
        )

    sections = (
        await note_sections_col()
        .find({"note_id": body.note_id})
        .sort("section_index", 1)
        .to_list(200)
    )

    if not sections:
        raise HTTPException(
            status_code=404,
            detail=(
                "No sections found for this note. "
                "Upload a note first or segment it manually."
            ),
        )

    logger.info("[Timetable] Found %d original sections", len(sections))

    sections = _split_large_sections(sections)

    study_days = min(max(body.study_days, 1), 7)

    # D4: Load per-user schedule constraints; fall back to defaults if unset.
    from bson import ObjectId as _ObjId
    user_doc = await users_col().find_one({"_id": _ObjId(current["user_id"])})
    weekday_free_hours    = user_doc.get("weekday_free_hours") if user_doc else None
    blocked_days          = user_doc.get("blocked_days")       if user_doc else None
    break_ratio_ovr       = user_doc.get("default_break_ratio") if user_doc else None
    preferred_study_times = user_doc.get("preferred_study_times") if user_doc else None

    logger.info(
        "[Timetable] D4 constraints: blocked=%s free_hours=%s preferred_times=%s",
        blocked_days, weekday_free_hours, preferred_study_times,
    )

    days_schedule = _distribute_sections(
        sections,
        body.recommended_hours,
        study_days,
        is_weak=body.is_weak,
        weekday_free_hours=weekday_free_hours,
        blocked_days=blocked_days,
        break_ratio_override=break_ratio_ovr,
        preferred_study_times=preferred_study_times,
    )

    # Fill unused days with empty schedules (including blocked days)
    for d in DAYS:
        if d not in days_schedule:
            days_schedule[d] = []

    timetable_id = str(uuid.uuid4())
    week_start = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    doc = {
        "_id": timetable_id,
        "user_id": current["user_id"],
        "note_id": body.note_id,
        "week_start": week_start,
        "version": 1,
        "days": {
            d: [s.model_dump() for s in slots]
            for d, slots in days_schedule.items()
        },
    }

    await timetables_col().insert_one(doc)
    logger.info("[Timetable] Created timetable %s", timetable_id)

    return TimetableResponse(
        timetable_id=timetable_id,
        note_id=body.note_id,
        week_start=week_start,
        version=1,
        days=days_schedule,
    )


@router.get("/{timetable_id}", response_model=TimetableResponse)
async def get_timetable(
    timetable_id: str,
    current: dict = Depends(get_current_user),
):
    doc = await timetables_col().find_one({
        "_id": timetable_id,
        "user_id": current["user_id"],
    })

    if not doc:
        raise HTTPException(status_code=404, detail="Timetable not found")

    days = {
        d: [TimetableSlot(
            section_id=s.get("section_id"),
            section_title=s.get("section_title"),
            section_content=s.get("section_content", ""),
            hours_allocated=s.get("hours_allocated", 0),
            start_time=s.get("start_time", "00:00"),
            end_time=s.get("end_time", "00:00"),
            break_minutes=s.get("break_minutes", 0),
            moved_from=s.get("moved_from"),
        ) for s in slots]
        for d, slots in doc["days"].items()
    }

    return TimetableResponse(
        timetable_id=timetable_id,
        note_id=doc["note_id"],
        week_start=doc["week_start"],
        version=doc["version"],
        days=days,
    )


@router.put("/{timetable_id}/goal")
async def set_goal(
    timetable_id: str,
    body: StudyGoalRequest,
    current: dict = Depends(get_current_user),
):
    """
    Set (or replace) a mastery-target pacing goal on this timetable.
    Progress toward it is computed against week_start as the tracking-start
    reference — see services/goal_forecast.py and progress.section_mastery().
    """
    doc = await timetables_col().find_one({"_id": timetable_id, "user_id": current["user_id"]})
    if not doc:
        raise HTTPException(status_code=404, detail="Timetable not found")

    await timetables_col().update_one(
        {"_id": timetable_id},
        {"$set": {
            "goal_mastery_pct": body.target_mastery_pct,
            "goal_deadline": body.deadline.isoformat(),
        }},
    )
    return {"message": "Goal saved"}


@router.delete("/{timetable_id}/goal")
async def clear_goal(
    timetable_id: str,
    current: dict = Depends(get_current_user),
):
    doc = await timetables_col().find_one({"_id": timetable_id, "user_id": current["user_id"]})
    if not doc:
        raise HTTPException(status_code=404, detail="Timetable not found")

    await timetables_col().update_one(
        {"_id": timetable_id},
        {"$unset": {"goal_mastery_pct": "", "goal_deadline": ""}},
    )
    return {"message": "Goal cleared"}


@router.get("/", response_model=list[TimetableResponse])
async def list_timetables(
    current: dict = Depends(get_current_user),
):
    """
    List all timetables for the current user — metadata + slot structure only.
    section_content is omitted to prevent multi-hundred-KB payloads on list.
    """
    docs = (
        await timetables_col()
        .find({"user_id": current["user_id"]})
        .sort("week_start", -1)
        .to_list(20)
    )

    result = []

    for doc in docs:
        days = {
            d: [TimetableSlot(
                section_id=s.get("section_id"),
                section_title=s.get("section_title"),
                section_content="",  # omitted in list — fetch by ID for full content
                hours_allocated=s.get("hours_allocated", 0),
                start_time=s.get("start_time", "00:00"),
                end_time=s.get("end_time", "00:00"),
                break_minutes=s.get("break_minutes", 0),
            ) for s in slots]
            for d, slots in doc["days"].items()
        }

        result.append(
            TimetableResponse(
                timetable_id=doc["_id"],
                note_id=doc["note_id"],
                week_start=doc["week_start"],
                version=doc["version"],
                days=days,
            )
        )

    return result


# ---------------------------------------------------------------------------
# Day Reallocation helpers (D3)
# ---------------------------------------------------------------------------

def _recompute_day_times(slots: list[dict], start_hour: int = START_HOUR) -> list[dict]:
    """
    Recompute start_time / end_time for every slot in a day after slots have
    been moved or hours have been changed.  Mirrors the T5 fix already used
    in the hour-rescaling step.
    """
    break_ratio = (10 / 60) / 0.75
    offset = 0.0
    recomputed = []
    for slot in slots:
        alloc = slot["hours_allocated"]
        recomputed.append({
            **slot,
            "start_time": _time_str(offset, start_hour),
            "end_time":   _time_str(offset + alloc, start_hour),
        })
        offset += alloc + alloc * break_ratio
    return recomputed


def _day_average_score(
    day_name: str,
    slots: list[dict],
    latest_progress: dict,
) -> float | None:
    """
    Average the latest score for every section in a day.
    Returns None when no section has any progress data (not the same as 0%).
    """
    scores = [
        latest_progress[s["section_id"]]["score_pct"]
        for s in slots
        if s["section_id"] in latest_progress
    ]
    return sum(scores) / len(scores) if scores else None


def _swap_one_pair(
    days: dict[str, list],
    worst_day: str,
    best_day: str,
    scored_days: dict[str, float],
    reassignment_log: list[str],
    start_hour: int = START_HOUR,
) -> dict[str, list]:
    """
    Swap sections between exactly one worst/best day pair, stamping "moved_from"
    on each relocated slot and recomputing times. Extracted from the original
    single-pair _swap_days body so multi-pair swaps (_pair_days_for_swap) reuse
    the exact same, already-verified logic per pair.
    """
    logger.info(
        "[Adapt-D3] Swapping sections: %s (%.1f%%) <-> %s (%.1f%%)",
        worst_day, scored_days[worst_day], best_day, scored_days[best_day],
    )

    new_days = dict(days)

    # Stamp moved_from on each slot before swapping
    worst_slots_stamped = [
        {**s, "moved_from": worst_day} for s in new_days[worst_day]
    ]
    best_slots_stamped = [
        {**s, "moved_from": best_day} for s in new_days[best_day]
    ]

    new_days[worst_day] = _recompute_day_times(best_slots_stamped, start_hour)
    new_days[best_day]  = _recompute_day_times(worst_slots_stamped, start_hour)

    # Log to reassignment_log (visible in the weekly report)
    reassignment_log.append(
        f"Day swap: {best_day} sections moved to {worst_day} "
        f"(score {scored_days[worst_day]:.0f}%) and vice-versa "
        f"(score {scored_days[best_day]:.0f}%) — RL reallocation v{{}}"
    )

    return new_days


def _pair_days_for_swap(
    scored_days: dict[str, float],
    breadth: int,
) -> list[tuple[str, str]]:
    """
    Sort scored days ascending and pair from the outside in: (worst, best),
    (2nd-worst, 2nd-best), ... up to `breadth` pairs. Stops early once fewer
    than 2 unpaired days remain, or the next candidate pair is tied (no
    meaningful gradient left).

    For breadth=1 this always returns exactly one (min, max) pair — identical
    to the original single-pair selection.
    """
    ordered = sorted(scored_days.items(), key=lambda kv: kv[1])  # ascending by score
    lo, hi = 0, len(ordered) - 1
    pairs: list[tuple[str, str]] = []
    while lo < hi and len(pairs) < breadth:
        worst_day, worst_score = ordered[lo]
        best_day, best_score = ordered[hi]
        if worst_score == best_score:
            break
        pairs.append((worst_day, best_day))
        lo += 1
        hi -= 1
    return pairs


def _swap_days(
    days: dict[str, list],
    latest_progress: dict,
    reassignment_log: list[str],
    swap_breadth: int = 1,
    start_hour: int = START_HOUR,
) -> dict[str, list]:
    """
    D3 core: swap sections between the worst-performing and best-performing
    day(s). With swap_breadth=1 (default), swaps exactly the single worst/best
    pair — the original behavior. With swap_breadth=N>1, also swaps the 2nd
    worst/best pair, and so on, up to N pairs.

    Guard rails (no swap occurs when):
    - Fewer than two non-empty days exist (single-day timetable).
    - No day has any progress data at all (nothing to compare).
    - All days with progress share the identical score (no meaningful gradient).

    When a swap occurs, each moved slot gets a "moved_from" field so the
    frontend can display a "Moved from <day>" badge.  Times are recomputed
    via _recompute_day_times() for both affected days in each pair.
    """
    # Only consider days that actually contain slots
    active_days = {d: slots for d, slots in days.items() if slots}
    if len(active_days) < 2:
        logger.info("[Adapt-D3] Single-day or empty timetable — skipping swap")
        return days

    scored_days: dict[str, float] = {}
    for day_name, slots in active_days.items():
        avg = _day_average_score(day_name, slots, latest_progress)
        if avg is not None:
            scored_days[day_name] = avg

    if not scored_days:
        logger.info("[Adapt-D3] No progress data — skipping swap")
        return days

    scores_set = set(scored_days.values())
    if len(scores_set) == 1:
        logger.info("[Adapt-D3] All days tied at %.1f%% — skipping swap", scores_set.pop())
        return days

    pairs = _pair_days_for_swap(scored_days, max(1, swap_breadth))
    if not pairs:
        logger.info("[Adapt-D3] No valid day pairs to swap — skipping")
        return days

    new_days = dict(days)
    for worst_day, best_day in pairs:
        new_days = _swap_one_pair(new_days, worst_day, best_day, scored_days, reassignment_log, start_hour)

    return new_days


@router.post("/{timetable_id}/adapt", response_model=TimetableResponse)
async def adapt_timetable(
    timetable_id: str,
    swap_breadth: int = 1,
    current: dict = Depends(get_current_user),
):
    """
    RL-driven timetable adaptation — two layered steps:

    Step 1 (existing, unchanged): Hour rescaling per slot using Q-table actions.
      T1 FIX: $in operator corrected (was empty-string key).
      T5 FIX: start_time/end_time recomputed after hour changes.

    Step 2 (D3, additive): Day reallocation — swap sections between the
      worst-performing and best-performing days using per-day average scores
      from Day 2's daily_breakdown logic.  The existing hour-rescaling step
      runs first, then the swap runs on the already-rescaled slots.
      Degenerate cases (single day, no data, all tied) are no-ops.

    swap_breadth (optional query param, default 1): number of worst/best day
    pairs to swap in one call. Default 1 preserves the original single-pair
    behavior exactly; pass e.g. ?swap_breadth=2 to also swap the 2nd-worst/
    2nd-best pair. Clamped to [1, 3] since a 7-day week has at most 3 disjoint
    pairs.
    """
    swap_breadth = max(1, min(swap_breadth, 3))
    doc = await timetables_col().find_one({
        "_id": timetable_id,
        "user_id": current["user_id"],
    })

    if not doc:
        raise HTTPException(status_code=404, detail="Timetable not found")

    user_id = current["user_id"]
    all_section_ids = list({
        slot["section_id"]
        for slots in doc["days"].values()
        for slot in slots
    })

    # T1 FIX: correct $in operator
    all_progress_docs = await progress_col().find(
        {"user_id": user_id, "section_id": {"$in": all_section_ids}},
    ).sort("date", -1).to_list(500)

    latest_progress: dict = {}
    for p in all_progress_docs:
        sid = p["section_id"]
        if sid not in latest_progress:
            latest_progress[sid] = p

    # T1 FIX: same $in fix for Q-table
    q_docs = await q_table_col().find(
        {"user_id": user_id, "section_id": {"$in": all_section_ids}}
    ).to_list(len(all_section_ids) + 10)
    q_by_section: dict = {d["section_id"]: d["q_values"] for d in q_docs}
    default_q = {a: 0.0 for a in ["increase", "keep", "decrease"]}

    # D4 follow-up: keep the user's preferred start-of-day anchored across
    # adapts too, not just initial generation.
    from bson import ObjectId as _ObjId
    user_doc = await users_col().find_one({"_id": _ObjId(user_id)})
    start_hour = _resolve_start_hour(user_doc.get("preferred_study_times") if user_doc else None)

    # ── Step 1: Hour rescaling (existing logic, unchanged) ───────────────────
    new_days: dict[str, list] = {}

    for day, slots in doc["days"].items():
        new_slots = []
        day_offset = 0.0
        break_ratio = (10 / 60) / 0.75

        for slot in slots:
            sec_id = slot["section_id"]
            prog = latest_progress.get(sec_id)

            updated_slot = {**slot}
            # D3 FIX: clear any moved_from carried over from a previous version —
            # it must only reflect a swap that happened *this* Adapt call, not
            # linger on days that aren't part of this round's worst/best pair.
            updated_slot["moved_from"] = None
            if prog:
                q = q_by_section.get(sec_id, default_q)
                best_action = max(q, key=lambda a: q[a])
                new_hours = apply_action(slot["hours_allocated"], best_action)
                updated_slot["hours_allocated"] = new_hours
                updated_slot.setdefault("section_content", "")

            alloc = updated_slot["hours_allocated"]
            updated_slot["start_time"] = _time_str(day_offset, start_hour)
            updated_slot["end_time"]   = _time_str(day_offset + alloc, start_hour)
            day_offset += alloc + alloc * break_ratio

            new_slots.append(updated_slot)

        new_days[day] = new_slots

    # ── Step 2 (D3): Day reallocation — swap worst <-> best performing day ───
    reassignment_log: list[str] = []
    new_days = _swap_days(new_days, latest_progress, reassignment_log, swap_breadth=swap_breadth, start_hour=start_hour)

    # Stamp version into any reassignment_log entries that used a placeholder
    new_version = doc["version"] + 1
    reassignment_log = [e.format(new_version) for e in reassignment_log]

    await timetables_col().update_one(
        {"_id": timetable_id},
        {
            "$set": {"days": new_days, "version": new_version},
            "$push": {"reassignment_log_entries": {"$each": reassignment_log}},
        },
    )

    logger.info(
        "[Timetable] Adapted timetable %s -> v%d (swap=%s)",
        timetable_id, new_version, bool(reassignment_log),
    )

    days_response = {
        d: [
            TimetableSlot(**{
                **s,
                "section_content": s.get("section_content", ""),
                "moved_from": s.get("moved_from"),
            })
            for s in slots
        ]
        for d, slots in new_days.items()
    }

    return TimetableResponse(
        timetable_id=timetable_id,
        note_id=doc["note_id"],
        week_start=doc["week_start"],
        version=new_version,
        days=days_response,
    )
