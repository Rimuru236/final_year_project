# Cognitive Sanctuary — Diagnose & Fix RL Adapt Day Reshuffling

## Problem Report

Clicking "RL Adapt" on the Timetable page is not reshuffling note sections across days. The user expects sections to move between days based on quiz performance (poor-performing days should get content from well-performing days and vice versa), but after clicking Adapt, the same sections stay on the same days — only `moved_from` badges and day reordering are missing or never appear.

Your job is to **investigate this end-to-end, find the actual root cause(s), and fix them** — not to assume a single cause and patch blindly. Several plausible failure points exist in the current code and you must check each one against real data before concluding which is the actual bug. Read every file listed below in full before changing anything.

---

## Stack context (do not assume anything different)

- FastAPI (Python 3.11), fully async, MongoDB via Motor
- The swap logic lives in `backend/app/routers/timetable.py`, specifically the functions `_swap_days()`, `_day_average_score()`, and the `adapt_timetable()` endpoint handler (`POST /timetable/{id}/adapt`)
- Progress records are written by `POST /progress/submit` in `backend/app/routers/progress.py`
- Frontend: `frontend/src/pages/TimetablePage.tsx` calls `timetableApi.adapt(selected.timetable_id)` and replaces `selected` with the response

---

## Investigation checklist — work through each of these in order

Do not skip steps even if an earlier one looks like "the bug." Multiple issues may be compounding. Document what you find at each step (as code comments or a short summary in your final report) before moving to the fix.

### Step 1 — Confirm progress records actually exist and use the correct `section_id` format

Read `backend/app/routers/timetable.py`'s `_split_large_sections()` function. Note that when a note section exceeds `MAX_SECTION_WORDS`, it is split into chunks with IDs like `{original_id}_0`, `{original_id}_1`, etc. — these split-chunk IDs are what actually appear in `timetable["days"][day][i]["section_id"]`.

Read `backend/app/routers/progress.py`'s `submit_progress()` function. Confirm that `body.section_id` (the value the **frontend** sends when submitting a quiz score) matches the exact chunked ID format (`{original_id}_0`) and not the original unchunked section ID. Check `frontend/src/pages/StudyModal.tsx` and `frontend/src/pages/TimetablePage.tsx` to see what `section_id` value is actually passed to `progressApi.submit(...)` when a quiz is completed — trace it back to `slot.section_id` from the rendered timetable slot.

**If there is a mismatch** between the section_id stored in `progress_col()` and the section_id used as the dictionary key in `_day_average_score()`'s lookup (`latest_progress[s["section_id"]]`), this is a primary bug: `_day_average_score()` would silently return `None` for every day (because no section_id in the slot ever matches a key in `latest_progress`), causing `_swap_days()` to hit its "No progress data — skipping swap" guard on every single call, even when the user has genuinely submitted dozens of quiz attempts.

**Action:** Add a temporary debug log (or use the MongoDB shell / a script) to print the actual `section_id` values stored in a few `progress_col()` documents for a real user, side-by-side with the `section_id` values in that user's timetable's `days` dict. Confirm whether they match exactly, character-for-character. Remove any temporary debug code once the investigation is complete — do not leave debug print statements in the final code.

### Step 2 — Confirm `_swap_days` is actually being reached and not silently no-op'ing

Read the full body of `_swap_days()` in `timetable.py`. It has four early-return guard conditions:

1. `len(active_days) < 2` — fewer than two non-empty days
2. `not scored_days` — no day has any progress data
3. `len(scores_set) == 1` — all scored days have the identical average score
4. `worst_day == best_day` — degenerate tie (this is actually unreachable given guard 3 already filters identical scores, but confirm)

Each guard has a `logger.info(...)` call before returning unchanged. **Check the backend server logs** (or add temporary logging if logs aren't visible) after a real Adapt click to see which guard — if any — is being hit. This tells you definitively whether the swap logic is even attempting a swap, versus succeeding at swapping but the result not reaching the user.

If Step 1 found a section_id mismatch, guard #2 (`not scored_days`) is almost certainly the one firing on every call — confirm this in the logs before assuming it.

### Step 3 — Confirm the swap, when it does run, only ever touches exactly 2 days

Read `_swap_days()` again, specifically:

```python
worst_day = min(scored_days, key=lambda d: scored_days[d])
best_day  = max(scored_days, key=lambda d: scored_days[d])
```

This selects **only the single worst day and single best day** and swaps sections between just those two. With a 5-day or 7-day timetable, this means 3-5 days are *never* touched by any single Adapt call, even when the swap logic is working correctly. A user who studies all week and expects to see broad reshuffling across multiple days will only ever see one pair of days change.

This is not necessarily a bug — it may be intentional incremental adaptation — but it is very likely contributing to the perception that "reshuffling doesn't work," especially if the user is testing with more than 2 active days and only checking days other than the specific worst/best pair.

**Do not silently change this behavior without flagging it** — see "Decision point" below.

### Step 4 — Confirm the updated `days` document is actually persisted and returned correctly

Read the end of `adapt_timetable()`:

```python
await timetables_col().update_one(
    {"_id": timetable_id},
    {
        "$set": {"days": new_days, "version": new_version},
        "$push": {"reassignment_log_entries": {"$each": reassignment_log}},
    },
)
```

Confirm that `new_days` (the result of `_swap_days(new_days, latest_progress, reassignment_log)`) is the variable actually written to `$set: {"days": ...}` — re-read the variable assignment chain from `new_days = {}` (Step 1 hour-rescaling loop) through `new_days = _swap_days(new_days, ...)` (Step 2 reassignment) to confirm there is no accidental shadowing, reassignment, or use of the wrong variable name before the database write.

Also confirm the `days_response` dict built for the `TimetableResponse` return value is built from the same final `new_days`, not from `doc["days"]` (the original, pre-adapt document) by mistake.

### Step 5 — Confirm the frontend actually displays the response it receives

Read `frontend/src/pages/TimetablePage.tsx`'s `handleAdapt` (or equivalently named) function. Confirm:

```typescript
const updated: Timetable = await timetableApi.adapt(selected.timetable_id);
setSelected(updated);
```

— that `setSelected(updated)` is called with the actual API response, and that nothing downstream (memoization, a stale closure, a `key` prop issue causing React not to re-render the day grid) prevents the UI from reflecting the new `selected.days` object. Check whether the day-grid rendering block keys its mapped elements by something static (e.g., array index) versus something that would force a re-render when section content changes (e.go., `slot.section_id` combined with day name). If list items are keyed purely by array index and a swap changes which section occupies which index without changing the *order* of indices within a day, React may not visually update even though the underlying data changed — though since slots also change `start_time`/`moved_from`/`section_title`, this is a secondary concern, not the primary suspect, but worth confirming.

---

## What to fix based on findings

You will likely find one or both of these are real:

### If Step 1 confirms a section_id mismatch

This is the most likely root cause. The fix must ensure that whatever `section_id` value is sent by the frontend in `POST /progress/submit` is the exact same value used as the dictionary key when building `latest_progress` in `adapt_timetable()`, and the exact same value present in `slot["section_id"]` for matching in `_day_average_score()`.

Do **not** patch this by adding fuzzy/prefix matching logic on the backend (e.g., reproducing the `if "_" in section_id: base_id = ...` truncation pattern already present in `progress.py`'s `submit_progress()` and `section_history()` endpoints) unless you first confirm that pattern is the deliberate, correct contract for this codebase. Read all three places that pattern appears (`submit_progress`, `section_history` in `progress.py`) to understand whether progress is meant to be tracked per-chunk or per-original-section, then make `adapt_timetable()`'s lookup consistent with that same contract. If progress is tracked per-chunk (likely, since `body.section_id` is what `StudyModal` sends and that's the chunked slot ID), then `adapt_timetable()`'s current exact-match lookup is actually already correct — and the bug must be elsewhere. If progress is tracked per-base-section, `adapt_timetable()` needs the same truncation logic applied before building `latest_progress`'s keys, or before matching in `_day_average_score()`.

### If Step 3 confirms only one day-pair swaps per Adapt call

This is a design limitation, not necessarily a bug. **Do not unilaterally rewrite the swap algorithm to be more aggressive.** Instead:

1. Add a clear log line confirming exactly which two days were swapped on each Adapt call (if not already sufficiently logged).
2. In your final summary, explicitly flag this to the user as a possible explanation: "RL Adapt swaps exactly one pair of days (worst-performing ↔ best-performing) per click. If you have more than 2 active days, repeated Adapt clicks across multiple sessions are needed to see broader reshuffling, since each call only touches the current single worst/best pair." Do not silently expand this to a multi-day round-robin swap unless explicitly asked to — that is a behavior change, not a bug fix, and changes what "RL Adapt" means to the user.

### If Step 2 or Step 4 reveals a genuine logic bug (variable shadowing, wrong dict used, persisted data not matching returned data)

Fix the specific line(s) causing the mismatch. Keep the fix minimal — do not restructure `adapt_timetable()` beyond what's needed to correct the actual defect found.

### If Step 5 reveals a frontend rendering issue

Fix the `key` prop or state update pattern so that day-grid slots re-render correctly when their underlying section assignment changes after an Adapt call.

---

## Non-negotiable constraints

1. **Investigate before fixing.** Do not guess. Use the five-step checklist above, in order, and confirm or rule out each one with actual evidence (logs, a debug script, or careful code tracing) before writing any fix.
2. **Do not change the swap algorithm's scope** (single worst/best day pair) unless Step 3's investigation reveals this is explicitly *not* what the user wants — in which case, stop and note this in your summary rather than changing it unilaterally, since this is a product decision, not a bug.
3. **Do not break any other part of `adapt_timetable()`** — the existing Step 1 hour-rescaling logic (`apply_action`, Q-table lookups) must continue to work exactly as it does today. Your fix is scoped to the day-swap mechanism only.
4. **Do not modify `progress.py`'s existing section_id truncation pattern** (`if "_" in body.section_id: base_id = ...`) unless your investigation in Step 1 specifically shows this pattern is the source of the mismatch and that changing it is the correct fix, not just a convenient one.
5. **Remove all temporary debug logging** added during investigation before considering the task complete. Permanent logging is fine if it follows the existing `logger.info(...)` style already used throughout `_swap_days()` and `adapt_timetable()`.
6. **Test with realistic data** before declaring the fix complete: create or use a timetable with at least 3 active days, submit varied quiz scores across at least 2 different days' sections (some high, some low), click Adapt, and confirm the `moved_from` field appears correctly on the swapped sections in the actual API response — not just in theory.

---

## Files to read in full before starting

```
backend/app/routers/timetable.py         # _swap_days, _day_average_score, adapt_timetable, _split_large_sections
backend/app/routers/progress.py          # submit_progress, section_history — section_id handling patterns
frontend/src/pages/TimetablePage.tsx     # how adapt is triggered and how the response updates UI state
frontend/src/pages/StudyModal.tsx        # how section_id is determined when a quiz is submitted
backend/app/schemas.py                   # TimetableSlot.moved_from, ProgressSubmit.section_id
```

---

## Verification checklist

Before declaring this fixed, confirm:

- [ ] You have identified and documented (in code comments or a summary) the actual root cause(s) found via the 5-step investigation — not just applied a speculative fix
- [ ] A real test scenario (3+ active days, varied real quiz scores submitted across at least 2 different days) produces a non-empty `reassignment_log` entry after calling `POST /timetable/{id}/adapt`
- [ ] At least one slot in the API response has a non-null `moved_from` field after this test
- [ ] The day that had the lowest average score before Adapt now contains sections that were previously on the highest-scoring day (confirm this by comparing `section_id` lists before and after the Adapt call, not just by checking that `moved_from` is non-null)
- [ ] The existing hour-rescaling logic (Step 1 of `adapt_timetable`) still produces correct `hours_allocated` and recomputed `start_time`/`end_time` values — unaffected by your fix
- [ ] All temporary debug logging/print statements added during investigation have been removed
- [ ] If the root cause was a section_id mismatch, confirm the fix is applied consistently everywhere `section_id` is used to look up progress (not just in `_day_average_score`, but anywhere else in `adapt_timetable` that reads from `latest_progress`)
- [ ] Your final summary explicitly states which of the 5 investigation steps revealed the actual bug(s), and what was changed to fix it/them