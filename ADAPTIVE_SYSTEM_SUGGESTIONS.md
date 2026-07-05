# Making Cognitive Sanctuary More Adaptive — Findings & Recommendations

## Executive Summary

Cognitive Sanctuary already has real adaptive machinery — a banded Q-learning engine for per-section hour allocation (`backend/app/services/rl_engine.py`), a worst/best-day content swap (`backend/app/routers/timetable.py`), a 5-band mastery classifier, and a wide surface of user-configurable preferences (`onboarding.py`, `settings.py`). The gap isn't "no personalization exists" — it's that **several pieces of personalization infrastructure are built but not wired to the parts of the system that would make them feel adaptive**: MCQ difficulty never reads mastery or the user's own `default_mcq_difficulty` setting, the AI chat assistant knows the user's name and level but nothing about their actual weak topics, and onboarding schedule constraints are declared once and never adjusted from observed behavior. Live DB data confirms this is not theoretical: 0 of 4 real users have onboarding constraints set, only 6 of 58 timetables have ever been Adapted, and 130 cached MCQs across 26 sections were all generated at one fixed difficulty regardless of the scores those sections later received. The highest-leverage fixes below are mostly *wiring*, not new ML — connecting data the system already computes to decisions it already makes.

---

## 1. RL / Personalization Core

### 1.1 MCQ generation ignores mastery, difficulty settings, and the RL signal entirely
**What exists today:** `generate_mcqs()` in `backend/app/routers/mcq.py` builds one static Groq prompt (`temperature=0.4`, fixed instructions) regardless of who's asking or how they've done before. `StudyModal.tsx`/`TimetablePage.tsx` hardcode `mcqApi.generate(section_id, 5)` — always 5 questions. Meanwhile `settings.py` defines and persists `default_mcq_count` and `default_mcq_difficulty` per user (`StudyPrefs`, `SettingsPage.tsx` lines 963-980), and `_score_band()` in `rl_engine.py` already classifies every score into low/mid/high bands. **None of these connect.** Confirmed live: 1 of 4 users has `default_mcq_difficulty` set in Mongo, but it has zero effect on any generated quiz.
**Gap:** A student scoring 30% and a student scoring 95% on the same section get the identical question set, at the identical difficulty, forever (MCQs are cached indefinitely — `mcqs_col()` is only invalidated by the manual `DELETE /mcq/{id}/cache` endpoint).
**Proposal:** Pass the user's `default_mcq_difficulty` (or better, the section's current mastery classification from `section_mastery()`) into the Groq prompt as an explicit instruction ("target difficulty: hard — this student has 85%+ mastery, ask questions that probe edge cases and application, not recall"). Key the MCQ cache by `(section_id, difficulty_band)` instead of `section_id` alone, so difficulty can actually escalate/de-escalate as mastery changes instead of freezing at whatever was cached on first attempt.
**Effort/risk:** Small-medium. Prompt change + one extra cache-key dimension in `mcqs_col()`; no schema migration needed since it's a compound key, not a new field. Low risk — purely additive, existing cached MCQs keep working under the "unbanded" legacy key the same way `rl_engine.get_q_values()` already falls back to legacy section-only keys.

### 1.2 RL Adapt's state space is coarse: score_pct only, no timing/fatigue/recency signal
**What exists today:** `update_q_table()` derives reward purely from `score_pct` via `_reward()` (≥80 → +1, ≥60 → 0, else −1), and `_day_average_score()` averages only the single latest attempt per section. `StudyModal.tsx` already has a full per-question timer (`timerEnabled`, `timerSeconds`, `timeLeft`, auto-submit-as-wrong on timeout) — this data is captured in the UI but **never sent to the backend**; `progressApi.submit()` only carries `score_pct`, `questions_attempted`, `correct_answers`.
**Gap:** A student who answers correctly but takes 55 of 60 seconds every question (shaky recall) looks identical to one who answers in 5 seconds (genuine mastery) — the RL engine can't tell confident mastery from lucky/rushed guessing.
**Proposal:** Extend `ProgressSubmit` with an optional `avg_response_time_pct` (time used ÷ time allotted, when the timer is on) and fold it into `_reward()` as a secondary signal — e.g., a correct-but-slow pattern caps the reward at 0 instead of +1, preventing premature "increase" hour cuts on shaky content. This is additive to the existing schema (new optional field, defaults to None → falls back to current behavior when timer is off, which is most of the time today).
**Effort/risk:** Medium. Touches `schemas.ProgressSubmit`, `progress.py submit_progress`, `rl_engine._reward`, and `StudyModal`/`TimetablePage`'s submit call. No breaking changes since the field is optional throughout.

### 1.3 Single worst/best-day-pair swap per Adapt click
**What exists today:** `_swap_days()` (verified correct in this session, including the `moved_from`-staleness fix) computes `worst_day = min(...)`, `best_day = max(...)` and swaps exactly that one pair. Confirmed in this codebase already: this is a deliberate scope, not a bug (per prior investigation).
**Gap:** With 3+ active scored days, one Adapt click can't touch the middle-performing days at all — a user has to click Adapt repeatedly across sessions to see broader reshuffling, which can read as "nothing is happening" if they're only watching a day outside the current extreme pair.
**Proposal (product decision, not something to implement unilaterally):** A backward-compatible `swap_breadth` parameter on `POST /timetable/{id}/adapt` (default `1`, current behavior) that, when set to `N`, sorts all scored days by average score and pairs them off from the outside in (worst↔best, 2nd-worst↔2nd-best, …) up to `N` pairs. This keeps the existing single-pair behavior as the default and lets a future "reshuffle more aggressively" UI toggle opt in without changing what today's `RL Adapt` button does. Flagging explicitly per prior instruction: this changes what "Adapt" means and should be a conscious product choice, not a silent default change.
**Effort/risk:** Medium if implemented — the pairing logic itself is simple, but it changes an externally-observable contract (`reassignment_log` message format, how many `moved_from` tags appear per call), so it needs product sign-off and probably a frontend affordance (a slider or "aggressive reshuffle" toggle) rather than being invisible.

### 1.4 RL Q-table has an unused/underused band-key migration
**What exists today:** `get_q_values()` already supports a richer `{section_id}:{band}` state key with graceful fallback to the legacy `{section_id}`-only key. Confirmed in Mongo: 17 `q_table` docs, only 11 carry the new `state_key` field — 6 are still on the legacy key from before this migration.
**Gap:** Nothing currently backfills or reconciles the legacy rows, so a user with old legacy-keyed Q-values and new banded Q-values for the same section effectively has two independent, never-merged reward histories for that section — the RL signal is split.
**Proposal:** A one-time migration script that reads legacy `{user_id, section_id}` rows, seeds them as the `"mid"`-band entry for that section (the safest default assumption for unbanded historical data), and removes the legacy row. Low-risk, one-off, doesn't touch live request paths.
**Effort/risk:** Small. Pure data migration, no code path changes required after it runs once.

---

## 2. Content / Quiz Adaptivity

### 2.1 No spaced repetition — mastery is a flat last-5-scores average
**What exists today:** `section_mastery()` in `progress.py` takes the last 5 `score_pct` values, normalizes to a 0–2 scale, and averages — no time-decay, no forgetting curve. A 90% scored six months ago counts exactly as much as a 90% scored yesterday, and a section aced once and never revisited stays "solid" forever even if never reinforced.
**Gap:** No mechanism resurfaces "solid" content before it decays into "shaky." The lifecycle job (`lifecycle.py`) even actively *archives* content once it's scored ≥80% and 30+ days old — which is the opposite of spaced repetition (it removes the ability to re-quiz that content rather than scheduling a well-timed review).
**Proposal:** Weight the mastery average by recency (e.g., exponential decay per day since each attempt) so mastery reflects "how well do you know this *now*," not "how well did you ever do." Separately — and this is more valuable — use the existing RL day-swap machinery to occasionally schedule a *revision slot* for solid-but-aging sections instead of only reshuffling weak ones. This reuses `_swap_days`' infrastructure rather than building a new subsystem.
**Effort/risk:** Medium. The decay-weighted mastery is a pure function change in `section_mastery()`. The "revision slot" idea is a genuinely new scheduling behavior and should be scoped as its own feature, not bundled into a quick fix.

### 2.2 AI Assistant doesn't know the student's actual weak topics
**What exists today:** `buildSystemPrompt()` in `AIAssistantPage.tsx` injects only `user_name` and `level` into the Groq system prompt. The app already computes exactly what the assistant would need — `masteryReport.revise`/`.shaky` (weak topics by name) and `report.daily_breakdown` — but neither is fetched by `AIAssistantPage.tsx` nor passed to `/chat`.
**Gap:** A student asking "how should I prioritize my weak topics?" (this is literally one of the four suggested prompts in the UI, `SUGGESTIONS[0]`) gets a generic answer, because the assistant has no idea what those weak topics actually are — despite that data existing one API call away (`progressApi.mastery(timetableId)`, already used elsewhere in the same codebase).
**Proposal:** Have `AIAssistantPage` fetch the active timetable's mastery report on mount (same call `TimetablePage` and `ReportPage` already make) and include the `revise`/`shaky` section titles in the system prompt. This is the single highest-value, lowest-effort change in this report — it's plumbing an existing endpoint into an existing prompt template, no new backend work at all.
**Effort/risk:** Small. Frontend-only change; `chat.py`'s `ChatRequest.system_prompt` already accepts an arbitrary string, so no backend schema change needed.

---

## 3. Scheduling Adaptivity

### 3.1 Onboarding constraints are declared once, never learned from behavior
**What exists today:** `weekday_free_hours`, `blocked_days`, `default_break_ratio`, `preferred_session_length` (`onboarding.py`) are pure user-declared, one-time-set values, read only at `generate_timetable()` time (`_distribute_sections`' D4 parameters in `timetable.py`). `preferred_study_times` is explicitly documented as informational-only (`OnboardingPage.tsx` line 238: "Currently informational — used in future scheduling features") — it is read and saved but never consumed by any scheduling logic anywhere in the backend.
**Gap:** Confirmed live: **0 of 4 real users have ever set onboarding constraints.** Whether that's a discoverability problem (nothing prompts a new user to visit `/onboarding`) or the feature isn't compelling enough to bother with, the result is the same — the personalization this router exists to enable isn't happening in practice, and even for users who do set it, the system never checks whether their *actual* study behavior (which days they open sections on, which days they skip) matches what they declared.
**Proposal:** Two independent, additive changes: (a) surface an onboarding prompt/banner on `DashboardPage` for users with no constraints set yet (cheap, addresses the 0% adoption directly); (b) derive `blocked_days` suggestions from observed behavior — if `progress_col()` shows a user has never once studied on a day they marked as "available" over several weeks, surface a one-tap "mark this day as unavailable?" suggestion rather than requiring them to remember to update `/onboarding` manually. Also: either wire `preferred_study_times` into `_distribute_sections` (bias section placement toward the user's stated preferred time-of-day blocks) or remove the "informational only" caveat from the UI so it stops promising something it doesn't do.
**Effort/risk:** (a) is trivial (frontend banner + one existing `has_constraints` check already returned by `GET /onboarding/schedule`). (b) is medium — needs a lightweight "day-skip" detector over `progress_col()` timestamps grouped by weekday, which doesn't exist yet.

### 3.2 Notifications are generic, not behavior-timed
**What exists today:** `notify_user()` (`services/notifications.py`) fires templated emails for four fixed events; `day_sections_ready` fires once per timetable (`progress.py weekly_report`, guarded by `version==1 and not all_progress`) regardless of when in the day the user typically studies. `weekly_digest` exists as a template but nothing in the codebase currently schedules/triggers it — it's dead code reachable only if some future caller invokes `notify_user(event="weekly_digest", ...)`.
**Gap:** No signal from `get_streak()` (already computed in `settings.py`, tracks `current_streak`/`studied_today`) or from historical time-of-day patterns feeds into *when* a reminder fires. A user who reliably studies at 8pm gets the same generic "sections ready" email as one who studies at 6am, and there's no "you're about to break your streak" nudge despite the streak data already existing.
**Proposal:** Wire `run_lifecycle_job`'s existing daily scheduler (it already runs once a day at 02:00 UTC via APScheduler in `main.py`) to also check, per user, whether `studied_today` is false and their streak is ≥3 — fire a lightweight streak-preservation nudge in the evening rather than nothing. This reuses `get_streak()`'s logic (which would need extracting into a shared helper callable from both `settings.py` and a new lifecycle check) and the existing notification pipeline — no new infrastructure.
**Effort/risk:** Medium. Requires extracting the streak calculation out of the `settings.py` router into a reusable service function, plus one new APScheduler job. Send-time personalization (learning each user's typical study hour) is a larger effort and should be a separate, later phase.

---

## 4. ML Model Freshness

### 4.1 `predict.py`'s sklearn models are static, never retrained on this user's data
**What exists today:** `core/models.py` loads `clf.pkl` / `reg.pkl` / label encoders once at startup via `joblib.load` and never touches them again. `predict.py`'s `/predict/` endpoint runs inference only — `is_weak` and `recommended_hours` come from a model trained once, offline, on presumably generic data, with `safe_encode()` silently falling back to index 0 for any subject/topic the model has never seen. Every user's exam score, study time, and eventual real quiz performance (which the app *does* collect via `progress_col()`) has zero feedback path back into these models.
**Gap:** The initial "is this topic weak, how many hours do you need" prediction never improves for a specific user even after weeks of quiz data proving the original prediction right or wrong. This is the one part of the pipeline with a real precedent for online learning already in the same codebase (`rl_engine.py`'s Q-table shows the pattern), but `predict.py` doesn't follow it.
**Gap, secondary:** `models.py` startup logs (seen in this session) already show `InconsistentVersionWarning` — the pickled models were trained on an older scikit-learn version than what's currently installed, which is itself a freshness/maintenance smell independent of adaptivity.
**Proposal:** Don't retrain the sklearn classifier/regressor per-request (too heavy, and a full retrain pipeline is a bigger project). Instead, apply the same pattern already proven in `rl_engine.py`: use the static model's prediction as a *prior*, and nudge `recommended_hours` up/down for a specific user based on their own `q_table`/`progress_col()` history for that subject — e.g., if a user has consistently needed more hours than predicted to hit ≥80% on similar-difficulty topics, bias the next prediction accordingly. This keeps the ML model as-is (avoiding a retraining pipeline) while still making the *output the user sees* adaptive.
**Effort/risk:** Medium — the "prior + per-user bias" adjustment is a moderate addition to `predict.py`; a genuine retraining pipeline (collecting labeled outcomes, periodic model refresh, versioning `.pkl` files) is a much larger, separate initiative and shouldn't be scoped into the same change.

---

## Priority Ranking (highest impact-to-effort first)

1. **AI Assistant weak-topic context (2.2)** — smallest effort, directly answers the exact question the UI already suggests asking.
2. **MCQ difficulty/settings wiring (1.1)** — settings already exist and are saved by users; connecting them is mostly plumbing.
3. **Onboarding adoption banner (3.1a)** — trivial UI addition, directly targets the observed 0% adoption.
4. **Q-table legacy-key migration (1.4)** — small, one-off, prevents split reward histories from silently degrading RL quality further.
5. **Response-time signal into RL reward (1.2)** — medium effort, meaningfully richer state without a schema break.
6. **Streak-based nudges (3.2)** — medium effort, reuses existing streak logic.
7. **Swap breadth (1.3)** and **spaced repetition (2.1)** — valuable but larger scope; both need explicit product sign-off since they change user-visible behavior contracts.
8. **Predict model per-user bias (4.1)** — worthwhile but the largest lift; treat as its own initiative.
