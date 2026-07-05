# Cognitive Sanctuary — Implementation Changelog

Tracking every change made during the 9-day phased implementation plan.
Finding IDs follow the pattern `DX-N` (Day number, sequential finding).

---

## Day 1 — Authentication Security Hardening

### D1-1 — Password Complexity Policy

**Files changed:** `app/core/validators.py` (new), `app/schemas.py`, `src/pages/AuthPages.tsx`

Added a reusable `validate_password_complexity()` function in `app/core/validators.py`
enforcing the 8–12 character rule plus at least one lowercase, one uppercase, one digit,
and one special character. Applied via a Pydantic `@field_validator` on `SignupRequest.password`
only — `LoginRequest` is intentionally unconstrained so existing stored hashes continue
to authenticate. The frontend `SignupPage` mirrors the same rules with a live four-segment
strength bar using existing design tokens (primary / tertiary / red tones), live per-requirement
checklist, and the submit button is disabled until all requirements pass. Helper text updated
from "min 8 characters" to the full policy description. Day 6 change-password feature will
import `validate_password_complexity` directly from `validators.py`.

### D1-2 — NoSQL Injection Fix (Email Regex)

**Files changed:** `app/routers/auth.py`

Both `signup()` and `login()` previously used `{"email": {"$regex": f"^{body.email}$", "$options": "i"}}`
to perform a case-insensitive lookup. The raw user-supplied email was interpolated directly into
the regex, meaning a `.` in an address was a wildcard (e.g. `a.b@x.com` matched `axb@x.com`) and
crafted patterns could enable enumeration attacks. Fix: emails are normalised to lowercase at
signup (`body.email.lower()`) and stored that way, so login lookups use a direct exact-match
`{"email": normalised_email}` — no regex needed. Audited all other routers; confirmed no other
`$regex` interpolation exists (Motor's dict-based query API is used correctly elsewhere).

### D1-3 — DayProgress Schema (Forward-compat for Day 2)

**Files changed:** `app/schemas.py`

Added `DayProgress` model and `daily_breakdown: dict[str, DayProgress] = {}` field to
`WeeklyReport` as an additive, defaulted field. Existing callers receive an empty dict until
Day 2 populates it. This ensures Day 2's progress tracking work is a pure extension with no
schema breakage.

---

## Day 2 — Per-Day & Weekly Progress Tracking

### D2-1 — Daily Breakdown Aggregation

**Files changed:** `app/schemas.py` (already prepped D1-3), `app/routers/progress.py`, `src/types.ts`, `src/pages/ReportPage.tsx`

Extended `GET /progress/report/{timetable_id}` to compute a `daily_breakdown` field on top
of the existing `sections` list. For each weekday in the timetable's `days` dict, the latest
progress score for each of that day's sections is averaged into a `DayProgress` object
(`day_name`, `average_score`, `section_count`, `attempted_count`). Days with no progress
attempts are included with `attempted_count=0` and `average_score=0.0` so the frontend can
distinguish "no data yet" from a genuine 0% score. The existing `sections` list is completely
unchanged — this is a purely additive field with a default of `{}` so all existing callers
continue to work without modification.

Frontend `ReportPage.tsx`: added a "Daily Breakdown" card above the RL Adaptation Log,
rendering a coloured grid of day tiles (green ≥80%, amber ≥60%, red <60%, grey = no attempts)
using existing `Card`/`Badge` component conventions, existing colour tokens, and existing
responsive grid classes.

`types.ts`: added `DayProgress` interface and `daily_breakdown: Record<string, DayProgress>`
to `ProgressReport`, mirroring the backend schema exactly.

### D2-2 — Notification Seam (stub)

**Files changed:** `app/services/notifications.py` (new), `app/routers/progress.py`

Created `app/services/notifications.py` with `notify_user(user_id, event, payload)` — an
async fire-and-forget function that currently logs at INFO level only. The `weekly_report()`
endpoint calls it at the first report visit for a freshly-generated timetable (no progress
yet, version=1) with `event="day_sections_ready"` and `payload={"timetable_id": ..., "day_name": ...}`.
This is the explicit forward-compatible seam Day 5 will replace with real SMTP delivery.
The call is inside a try/except inside `notify_user()` itself so it can never block or error
the HTTP response.

---

## Day 3 — RL-Driven Adaptive Day Reallocation

### D3-1 — Day-Swap Step in adapt_timetable

**Files changed:** `app/routers/timetable.py`, `app/schemas.py`, `app/routers/progress.py`, `src/types.ts`, `src/pages/TimetablePage.tsx`

Added a second step to `POST /timetable/{id}/adapt` that runs **after** the existing
hour-rescaling step (which is completely unchanged). Using the latest per-section progress
scores, the algorithm computes an average score for each day (matching the logic from D2-1's
`daily_breakdown`), then swaps all sections between the lowest-scoring and highest-scoring days.
The intent: move content from a day the student struggled with into an earlier/different slot,
replacing it with material they've already mastered.

**Guard rails — no swap occurs when:**
- Fewer than two non-empty days exist (single-day timetable)
- No section has any progress data yet
- All scored days share the identical average score (nothing to rank)
- (Inherently handled) worst day == best day (tied top)

**Time recomputation:** after the swap, `_recompute_day_times()` is called on both affected
days to recompute `start_time`/`end_time` from scratch, using the same break-ratio formula
as the existing T5 fix. No stale times are left after a reorder.

**moved_from field:** each slot that was relocated receives a `moved_from: str` field (set to
its origin day name). Slots that did not move have `moved_from: null`. This is stored in
MongoDB and returned in the API response.

**Reassignment log:** swap events are pushed to a `reassignment_log_entries` array on the
timetable document (separate from per-section hour events) and merged into the `WeeklyReport`
`reassignment_log` list at report time, so the frontend shows both hour-change and day-swap
events together.

### D3-2 — Frontend "Moved from" Badge

**Files changed:** `src/pages/TimetablePage.tsx`, `src/types.ts`

`TimetableSlot` in `types.ts` gains an optional `moved_from?: string | null` field.
`TimetablePage.tsx` renders a `Badge variant="error"` with a `swap_horiz` icon and
"Moved from {day}" label on any slot that carries a non-null `moved_from` value.
The badge only appears after an adapt() call that triggered a swap — untouched slots
show nothing.

---

## Day 4 — Student Schedule & Constraints Intake Page

### D4-1 — Schedule Constraints Backend

**Files changed:** `app/routers/onboarding.py` (new), `main.py`, `app/routers/timetable.py`, `app/core/database.py` (users_col already present)

New router `GET /onboarding/schedule` / `PUT /onboarding/schedule` stores five constraint
fields on the `users` document: `weekday_free_hours` (dict of day→hours cap), `blocked_days`
(list of days to skip), `preferred_study_times` (informational, list of time-of-day labels),
`default_break_ratio` (float, overrides global 10/45 min default), `preferred_session_length`
(float, stored for future slot-splitting logic). All fields are optional; partial updates are
supported. Validation: day names checked against VALID_DAYS list, hours clamped 0–24,
study times checked against VALID_TIMES list. Full ownership via `Depends(get_current_user)`.

### D4-2 — Constraints Wired into Timetable Generation

**Files changed:** `app/routers/timetable.py`

`_distribute_sections()` signature extended with three new optional params
(`weekday_free_hours`, `blocked_days`, `break_ratio_override`) — all default to None so
existing callers get unchanged behavior. When constraints are present:
- `blocked_days`: filtered out of the active day list before any distribution; if all days
  are blocked a defensive fallback restores them with a warning log.
- `weekday_free_hours`: per-day hour cap applied alongside the existing 1.1x budget cap;
  the tighter of the two limits governs.
- `break_ratio_override`: replaces the global (10/60)/0.75 constant.
`generate_timetable` loads the user's constraints from MongoDB before calling
`_distribute_sections`, and passes None for any field not yet saved.

Design choice (documented here per §0.2 ambiguity policy): constraints page is
always-editable (nav item visible immediately after login), not a required first-time step.
Users who never visit it get exactly today's generation behavior.

### D4-3 — OnboardingPage Frontend

**Files changed:** `src/pages/OnboardingPage.tsx` (new), `src/types.ts`, `src/lib/api.ts`, `src/components/UI.tsx`, `src/App.tsx`

New page at the "schedule" route, accessible from the sidebar nav ("My Schedule" /
edit_calendar icon). UI sections: unavailable-day pill toggles, per-day numeric hour inputs
(disabled when day is blocked), preferred study time multi-select buttons, break-ratio range
slider, preferred session-length range slider. All styled with existing Card/Badge/Spinner
primitives, existing CSS custom properties, and existing responsive grid classes.

`types.ts`: added `ScheduleConstraints` interface, `Weekday`/`StudyTime` union types,
`VALID_DAYS`/`VALID_STUDY_TIMES` const arrays, and "schedule" to the `Page` union.
`api.ts`: added `onboardingApi.getSchedule()` / `onboardingApi.saveSchedule()`.
`UI.tsx`: added "schedule" to `NAV_ITEMS` and `PAGE_TITLES`.
`App.tsx`: imported `OnboardingPage` and added `case "schedule"` to the AppShell switch.

---

## Day 5 — Email Notification System

### D5-1 — SMTP Configuration

**Files changed:** `app/core/config.py`, `.env.example`, `requirements.txt`

Added seven SMTP settings to `Settings`: `smtp_host`, `smtp_port`, `smtp_username`,
`smtp_password`, `smtp_from`, `smtp_from_name`, `smtp_use_tls`. All default to empty/safe
values — leaving `smtp_host` blank activates log-only fallback mode. Added `aiosmtplib==3.0.1`
to `requirements.txt` for async SMTP delivery. `.env.example` extended with provider-specific
examples for Gmail, SendGrid, Mailgun, and local MailHog.

Design choice: chose `aiosmtplib` over `run_in_threadpool(smtplib.send)` because it is
natively async — no thread pool overhead, no blocking I/O on FastAPI workers.

### D5-2 — Notifications Service (full implementation)

**Files changed:** `app/services/notifications.py`

Replaced the Day 2 log-only stub with a production-ready async notification service.
Key properties:
- **Fire-and-forget**: outer `notify_user()` wraps everything in try/except — can never raise.
- **Safe fallback**: when `SMTP_HOST` is blank OR delivery fails, the message is logged at
  INFO level (same as Day 2 stub) — app works fully without email configuration.
- **Opt-in filtering**: reads `notification_prefs: list[str]` from the user document
  (written by Day 6 settings); events not in the list are suppressed. Users with no prefs
  receive all events.
- **HTML templates**: four event templates (`account_created`, `password_changed`,
  `day_sections_ready`, `weekly_digest`) with inline-styled responsive HTML and matching
  plain-text fallbacks. Template dispatch via `_build_message()` returns None for unknown
  events.
- **`_send_email()`**: async SMTP send via `aiosmtplib.send()`; catches ImportError (if
  library not installed in older envs) and all SMTP exceptions, returning bool success.

### D5-3 — Signup Email Trigger

**Files changed:** `app/routers/auth.py`, `src/pages/AuthPages.tsx`

`signup()` now fires `notify_user(event="account_created", ...)` via
`asyncio.create_task()` after successfully inserting the user — truly non-blocking
(task runs after response is sent). Frontend signup toast updated to mention
"check your email for a confirmation" — subtle copy change, no new UI surface.

Day 6 settings page will add the `password_changed` trigger when the change-password
endpoint is implemented there.

Required env var for full email functionality: **`SMTP_HOST`** (see `.env.example`).

---

## Day 6 — Settings / Account Control Center

### D6-1 — Profile Update (name, level)
**Files:** `app/routers/settings.py`, `src/pages/SettingsPage.tsx`
`PATCH /settings` writes name and/or level to the users document. Frontend profile form with avatar preview, name input, level select.

### D6-2 — Profile Picture Upload
**Files:** `app/routers/settings.py`
`POST /settings/avatar` accepts PNG/JPG/WEBP/GIF up to 2 MB — reuses the same size-limit and extension allow-list guard pattern from `notes.py` (audit H3). Stored as a base64 data-URI in the users document; consistent with the "everything in Mongo" pattern; no new infrastructure.

### D6-3 — Read Settings
**Files:** `app/routers/settings.py`
`GET /settings` returns a `SettingsResponse` combining all user fields: profile, theme, avatar, notification_prefs, two_factor_enabled, study prefs.

### D6-4 — Light/Dark Theme Toggle
**Files:** `src/index.css`, `src/lib/useTheme.ts`, `src/pages/SettingsPage.tsx`
Added a full `.dark {}` block to `index.css` with dark-surface-tuned HSL values for every token defined under `:root` — same token names, no new names. `useTheme` hook toggles `class="dark"` on `<html>` and persists to `localStorage` (appropriate for a real browser app per §0.1). `POST /settings/theme/{light|dark}` persists the preference server-side so it survives browser clears. Theme is loaded from the server and applied on SettingsPage mount.

### D6-5 — Change Password
**Files:** `app/routers/settings.py`, `app/routers/auth.py` (D5 password_changed trigger completed)
`POST /settings/password` verifies current hash, enforces Day 1 `validate_password_complexity` on the new value, re-hashes with bcrypt, fires `password_changed` notification via Day 5 service.

### D6-6 — Notification Preferences
**Files:** `app/routers/settings.py`, `src/pages/SettingsPage.tsx`
`GET/PUT /settings/notifications` stores `enabled_events: list[str]` on users document. Day 5's `_notify_user_inner()` already reads this field and suppresses events not in the list.

### D6-7 — 2FA Toggle Placeholder
**Files:** `src/pages/SettingsPage.tsx`
`two_factor_enabled` is read from `GET /settings` and rendered as a disabled Toggle with a "full setup in next release" note. Day 7 will enable it.

### D6-8 — Study Session Defaults
**Files:** `app/routers/settings.py`, `src/pages/SettingsPage.tsx`
`GET/PUT /settings/study-prefs` reads and writes `preferred_session_length` and `default_break_ratio` — the same fields Day 4's `_distribute_sections` already reads. Changing them here immediately affects the next timetable generation.

### D6-9 — Data Export
**Files:** `app/routers/settings.py`
`GET /settings/export` returns a JSON bundle of all the user's data (user doc minus password_hash and 2FA secret, notes, note_sections, timetables, progress, MCQs). Frontend triggers a browser download.

### D6-10 — Delete Account
**Files:** `app/routers/settings.py`
`DELETE /settings/account` cascade-deletes note_sections → notes → timetables → mcqs → progress → q_table → users, all filtered by user_id. Ownership filter pattern identical to all other delete-adjacent operations. Two-click confirm UI prevents accidental deletion.

### D6-11 — Toggle Primitive + Shared Infrastructure
**Files:** `src/components/UI.tsx`, `src/types.ts`, `src/lib/api.ts`, `src/App.tsx`
Added `Toggle` (switch) component to `UI.tsx` following existing Spinner/Badge/Card conventions exactly. `SettingsData` interface, `"settings"` Page variant, `settingsApi` helper, nav item + page title all wired using the existing six-page pattern.

---

## Day 7 — Two-Factor Authentication (TOTP)

### D7-1 — 2FA Backend Router

**Files changed:** `app/routers/twofa.py` (new), `main.py`, `requirements.txt`

New router mounted at `/auth/2fa` with four endpoints:

- `POST /auth/2fa/enroll` — generates a `pyotp.random_base32()` secret, stores it as
  `two_factor_pending` on the user document (NOT the active secret until confirmed),
  and returns the secret plus an `otpauth://` provisioning URI for QR rendering.
  Using a pending field prevents a misconfigured authenticator from locking the user out.

- `POST /auth/2fa/enable` — verifies the TOTP code against the pending secret
  (`valid_window=1` allows ±30 sec clock drift), then promotes `two_factor_pending`
  to `two_factor_secret` and sets `two_factor_enabled=True`. Unsets the pending field.

- `DELETE /auth/2fa/disable` — requires a live TOTP code to confirm possession before
  clearing `two_factor_secret` and setting `two_factor_enabled=False`. Disabling from
  Settings immediately reverts to single-factor login on next request.

- `POST /auth/2fa/verify-login` — validates the short-lived `pending_token` (5-min JWT)
  issued by the modified `login()`, verifies the TOTP code, then calls
  `_set_cookies_helper()` to set the real httpOnly auth cookies. Import is deferred
  (`from .auth import _set_cookies_helper`) to avoid circular imports.

Chose TOTP over SMS (no provider in stack) and email-OTP (conflicts with Day 5's
fire-and-forget design — email delivery lag could be 10–30 seconds, unacceptable for
a login gate). Added `pyotp==2.9.0` to `requirements.txt`.

### D7-2 — Modified Login Flow

**Files changed:** `app/routers/auth.py`

`_set_cookies` refactored to delegate to `_set_cookies_helper` (same logic, renamed so
`twofa.py` can import it without going through `security.py`). `login()` now checks
`two_factor_enabled` on the user document before setting cookies:
- If False (default): sets cookies immediately — exact existing behaviour.
- If True: creates a `pending_token` (5-min JWT with `type="2fa_pending"`) and returns
  HTTP 202 with `{requires_2fa: true, pending_token: ...}` — no cookies set yet.

### D7-3 — Frontend 2FA Login Step

**Files changed:** `src/pages/AuthPages.tsx`, `src/lib/api.ts`

`authApi.login` patched to use raw `fetch` (instead of the `api()` helper that throws
on non-2xx) so it can intercept the 202 response. When `data.requires_2fa` is true it
returns the challenge data instead of throwing.

`LoginPage` gains `pendingToken` + `totpCode` state. On a 202 response the form shifts
into a second step: TOTP input field (numeric, 6-char, monospace tracking) with a
"Back to password" escape hatch. Submit in step-2 mode calls
`twofaApi.verifyLogin(pendingToken, totpCode)` which exchanges the pending JWT + code
for real auth cookies. Users without 2FA see no UI change whatsoever.

### D7-4 — Settings Page 2FA UI (activated from D6 placeholder)

**Files changed:** `src/pages/SettingsPage.tsx`, `src/lib/api.ts`

`twofaApi` added to `api.ts` (enroll, enable, disable, verifyLogin). The disabled
placeholder Toggle from Day 6 is replaced with a three-state UI:
1. Not enrolled: Toggle + "Set up 2FA" button → triggers enroll flow.
2. Enrollment in progress: QR code (rendered via api.qrserver.com), manual key display,
   6-digit confirmation input, Enable/Cancel buttons.
3. Enrolled: "2FA is active" badge + "Disable 2FA" button requiring TOTP confirmation.

---

## Day 8 — Note & Storage Lifecycle Management

### D8-1 — Lifecycle Policy & Archive Service

**Files changed:** `app/services/lifecycle.py` (new), `requirements.txt`

Implemented `run_lifecycle_job()` — an async function that scans all non-archived notes
and applies two tiered policies:

**Scored archive (30 days + score ≥ 80%):** Clears content when the note is at least 30
days old AND the student has achieved ≥80% on any quiz from that note. Rationale: if a
student has mastered the material, the raw text has served its purpose and can be cleared.

**Hard archive (90 days unconditional):** Clears content regardless of score. Prevents
indefinite storage growth for notes a user never gets around to studying, or where they
repeatedly scored below 80%.

"Archive" is intentionally non-destructive: `notes.raw_text` → `""` and
`note_sections.content` → `""` per-section are cleared (the actual storage cost), but
all small metadata fields (`filename`, `subject`, `topic`, `title`, `section_index`,
`note_id`, `created_at`, `word_count`) are preserved. This means: progress reports keep
their section titles and scores; the notes list still shows the note; timetable slot
labels remain readable.

**MCQ fallback decision (§0.3 ambiguity policy):** Rather than pre-generating MCQs before
archival (surprise Groq API cost, uncertain timing), archived sections degrade to a clear
HTTP 410 response: "MCQs unavailable — content has been archived." This is simpler,
cheaper, and the existing frontend already handles non-200 responses gracefully.

Added `APScheduler==3.10.4` to `requirements.txt`.

### D8-2 — APScheduler Integration

**Files changed:** `main.py`

`AsyncIOScheduler` started inside the FastAPI lifespan context manager — no new process
or external queue needed. The job is registered as a `cron` trigger at `hour=2, minute=0`
UTC (low-traffic window). `scheduler.shutdown(wait=False)` is called on app teardown.
Import of `run_lifecycle_job` from `app/services/lifecycle` is at the top of `main.py`.

### D8-3 — Schema & Endpoint Updates

**Files changed:** `app/schemas.py`, `app/routers/notes.py`, `app/routers/mcq.py`

`NoteListItem`: added `content_archived: bool = False` and `archived_at: Optional[datetime] = None`
with defaults so all existing callers are unaffected. `list_notes()` now populates these
from the document.

`segment_note()`: returns HTTP 410 Gone if `content_archived` is True — the content field
was cleared and re-segmenting would produce empty sections. Error message instructs the
user to re-upload.

`generate_mcqs()`: checks for empty section content and cross-references the parent note's
`content_archived` flag; returns HTTP 410 with a human-readable message if archived.

### D8-4 — Frontend Archive Badge

**Files changed:** `src/pages/UploadPage.tsx`, `src/types.ts`

`Note` interface in `types.ts` gains `content_archived: boolean` and `archived_at: string | null`.

`UploadPage` now loads `notesApi.list()` on mount and renders a "Your Uploaded Notes" panel
below the upload form. Each note shows filename, subject/topic, and either a `Badge variant="success"`
("Active") or `Badge variant="neutral"` with an archive icon ("Archived"). Archived notes also
display their archive date and a "re-upload to restore quiz access" message. The list refreshes
after each successful upload.

---

## Day 9 — Full Responsive Design Audit

Scope: every page including the two added on Days 4 and 6 (OnboardingPage, SettingsPage),
audited against the full viewport range from 360px (Galaxy S8) to 1536px+ (large desktop).

### D9-1 — Global Overflow Guards

**Files:** `src/index.css`, `src/App.tsx`

Added `overflow-x: hidden` + `word-break: break-word` to `body` and `html` in `index.css`
to prevent any overflowing child element from creating a horizontal scrollbar on the page.
Applied `overflow-x-hidden min-w-0` to the AppShell content wrapper (`<div lg:ml-64>`) and
`overflow-x-hidden` to the `<main>` element in `App.tsx` — belt-and-suspenders approach that
ensures even deeply nested fixed-width elements can't bleed out.

### D9-2 — Page-by-Page Fixes

**DashboardPage:** Stats grid changed from `grid-cols-2 lg:grid-cols-4` to
`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` — on 360px a 2-col grid of metric cards
produces 160px-wide cards which clip numbers. Quick actions similarly `grid-cols-1 sm:grid-cols-2
md:grid-cols-3`. Outer padding ratcheted down to `p-4 sm:p-6 lg:p-10`.

**UploadPage:** Changed `grid lg:grid-cols-2` to `grid grid-cols-1 lg:grid-cols-2` (explicit
base). Outer padding `p-4 sm:p-6 lg:p-10`. Badge rows in section list get `flex-wrap`.

**AnalysisPage:** Difficulty picker changed from bare `grid-cols-3` to `grid-cols-1 sm:grid-cols-3`
— three buttons at 360px in a 3-col grid produce ~110px-wide tap targets. Outer padding fix.

**TimetablePage:** Outer padding `p-4 sm:p-6 lg:p-10`. Header row gap tightened on mobile.
Day tab bar gets `-mx-4 px-4 sm:mx-0 sm:px-0` so it bleeds to screen edges on mobile
(common pattern for horizontal-scroll chip bars). Slot card title gets `min-w-0` to prevent
long section titles from pushing the play icon off-screen.

**ReportPage:** Timetable selector `<select>` changed from `min-w-[260px]` (which at 360px
forces horizontal scroll since it's inside a padded container) to `w-full max-w-sm`. Section
list flex-row header gets `min-w-0`. Daily breakdown grid already `grid-cols-2 sm:grid-cols-3
lg:grid-cols-4` — no change needed.

**AIAssistantPage:** Height changed from `calc(100vh - 4rem)` to `calc(100dvh - 4rem)` — 
`100dvh` accounts for the dynamic viewport height on iOS Safari (address bar retracts, 
`100vh` is fixed and causes content to be cut off). Chat bubble `max-w-[80%]` widened to 
`max-w-[90%] sm:max-w-[80%]` — at 360px, 80% of the content area after avatar is ~250px 
which clips long words. Input row gap tightened on xs. Outer padding fix.

**SettingsPage:** Primary-action buttons changed to `w-full sm:w-auto justify-center 
sm:justify-start` — on 360px, `px-6` buttons can overflow their card on long label text. 
Delete button already fixed in Day 9 Phase 1. ToggleRow flex changed to 
`items-start sm:items-center` so description text can wrap on narrow without misaligning 
the toggle. Outer padding fix.

**OnboardingPage:** Study times grid changed from `grid-cols-2 sm:grid-cols-3` to 
`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` — the time-of-day labels ("Early Morning 
(5–8 am)") are too long for a 2-col grid at 360px. Save button gets `w-full sm:w-auto`. 
Outer padding fix.

### D9-3 — Sidebar / Navigation Verified

The existing `hidden lg:flex` / mobile-drawer pattern at the `lg` (1024px) breakpoint is
correct and covers the full device range: sidebar is never visible below 1024px, the 
drawer overlay (`fixed inset-0 z-50`) fills the viewport correctly and has a `backdrop-blur`
backdrop, nav items have `py-3` touch targets (≥44px effective height). No second nav 
paradigm introduced.
