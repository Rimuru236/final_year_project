"""
Settings / Account Control Center router — Day 6.

Implements ≥10 user-facing settings functions backed by new fields on the
`users` document.  All endpoints share the same ownership pattern:
Depends(get_current_user) ensures only the authenticated user's own data
is read/written.

Functions implemented (D6-1 through D6-11):
  GET/PATCH /settings          — read/update user profile fields
  POST /settings/avatar        — upload profile picture (base64 in Mongo)
  POST /settings/password      — change password (reuses Day 1 validator)
  GET/PUT  /settings/notifications  — notification preferences
  GET/POST /settings/theme     — persist light/dark theme choice
  GET      /settings/export    — download all user data as JSON
  DELETE   /settings/account   — cascade-delete all user data
  GET/PUT  /settings/study-prefs  — default session length + break ratio

The 2FA toggle placeholder (D6-7) lives on the user document as
`two_factor_enabled: bool` — it is read here and toggled by Day 7's
dedicated 2FA router.  The field is included in GET /settings response
so the Settings page can render the toggle state.
"""

import base64
import uuid
import logging
import re
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, EmailStr

from ..core.database import (
    users_col, notes_col, note_sections_col,
    timetables_col, mcqs_col, progress_col, q_table_col,
)
from ..core.security import get_current_user, hash_password, verify_password
from ..core.validators import validate_password_complexity
from ..schemas import AuthResponse
from ..services.notifications import notify_user
from ..services.streaks import compute_streak
from ..services.rate_limit import check_rate_limit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])

# ── Constants (reuse notes.py pattern) ───────────────────────────────────────
AVATAR_MAX_BYTES  = 2 * 1024 * 1024   # 2 MB — smaller than note uploads (10 MB)
AVATAR_ALLOWED    = {"png", "jpg", "jpeg", "webp", "gif"}
VALID_THEMES      = {"light", "dark"}
VALID_NOTIF_EVENTS = {
    "account_created", "password_changed", "email_changed",
    "day_sections_ready", "weekly_digest", "streak_reminder", "revision_due",
}


# ── Pydantic models ───────────────────────────────────────────────────────────

class ProfileUpdate(BaseModel):
    name:  Optional[str] = Field(None, min_length=1, max_length=100)
    level: Optional[str] = None   # "High School" | "Undergraduate" | "Postgraduate"
    timezone: Optional[str] = None    # e.g. "Africa/Douala", "Europe/London", "UTC"
    locale:   Optional[str] = None    # e.g. "en-GB", "en-US", "fr-FR"


class PasswordChange(BaseModel):
    current_password: str
    new_password: str

    def validate_new(self) -> str:
        return validate_password_complexity(self.new_password)


class NotificationPrefs(BaseModel):
    enabled_events: list[str]    # subset of VALID_NOTIF_EVENTS


class StudyPrefs(BaseModel):
    default_session_length: Optional[float] = Field(None, ge=0.25, le=4.0)
    default_break_ratio:    Optional[float] = Field(None, ge=0.1,  le=0.5)
    default_mcq_count:      Optional[int]  = Field(None, ge=1, le=20)
    default_mcq_difficulty: Optional[str]  = None   # "easy" | "medium" | "hard"
    archive_after_days:     Optional[int]  = Field(None, ge=14, le=365)


class EmailChangeRequest(BaseModel):
    new_email: EmailStr
    current_password: str


class StreakResponse(BaseModel):
    current_streak: int      # consecutive days up to and including today (or yesterday)
    longest_streak: int      # all-time best
    last_study_date: Optional[str]   # ISO date string of most recent activity
    studied_today: bool


class ActivityEntry(BaseModel):
    event:  str
    detail: str
    at:     str   # ISO string


class DisplayPrefs(BaseModel):
    week_start_day:     Optional[str]  = None   # "Monday" | "Sunday"
    time_format:        Optional[str]  = None   # "12h" | "24h"
    timetable_default_view: Optional[str] = None  # "current_day" | "full_week"


class SettingsResponse(BaseModel):
    user_id:         str
    name:            str
    email:           str
    level:           str
    theme:           str              # "light" | "dark"
    avatar_b64:      Optional[str]    # base64 data-URI prefix stripped; None if not set
    notification_prefs: list[str]
    two_factor_enabled: bool          # read-only here; written by Day 7 router
    default_session_length: Optional[float]
    default_break_ratio:    Optional[float]
    timezone: str = "UTC"
    locale:   str = "en-GB"


# ── Helper ────────────────────────────────────────────────────────────────────

async def _get_user(user_id: str) -> dict:
    user = await users_col().find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


async def _log_activity(user_id: str, event: str, detail: str = "") -> None:
    """Log security-relevant events to the user's activity log."""
    entry = {
        "event":  event,
        "detail": detail,
        "at":     datetime.now(timezone.utc).isoformat(),
    }
    await users_col().update_one(
        {"_id": ObjectId(user_id)},
        {"$push": {"activity_log": {"$each": [entry], "$slice": -20}}},
    )


def _settings_response(user: dict) -> SettingsResponse:
    return SettingsResponse(
        user_id=str(user["_id"]),
        name=user.get("name", ""),
        email=user.get("email", ""),
        level=user.get("level", "Undergraduate"),
        theme=user.get("theme", "light"),
        avatar_b64=user.get("avatar_b64"),
        notification_prefs=user.get("notification_prefs", list(VALID_NOTIF_EVENTS)),
        two_factor_enabled=user.get("two_factor_enabled", False),
        default_session_length=user.get("preferred_session_length"),
        default_break_ratio=user.get("default_break_ratio"),
        timezone=user.get("timezone", "UTC"),
        locale=user.get("locale", "en-GB"),
    )


# ── D6-1 / D6-3: Read + update profile ───────────────────────────────────────

@router.get("", response_model=SettingsResponse)
async def get_settings(current: dict = Depends(get_current_user)):
    user = await _get_user(current["user_id"])
    return _settings_response(user)


@router.patch("", response_model=SettingsResponse)
async def update_profile(
    body: ProfileUpdate,
    current: dict = Depends(get_current_user),
):
    """D6-1: Update display name and/or student level."""
    update: dict = {}
    if body.name  is not None: update["name"]  = body.name.strip()
    if body.level is not None: update["level"] = body.level
    if body.timezone is not None:
        if not re.match(r'^[A-Za-z/_\-+0-9]{1,60}$', body.timezone):
            raise HTTPException(status_code=422, detail="Invalid timezone format")
        update["timezone"] = body.timezone
    if body.locale is not None: update["locale"] = body.locale
    if update:
        await users_col().update_one({"_id": ObjectId(current["user_id"])}, {"$set": update})
    user = await _get_user(current["user_id"])
    return _settings_response(user)


# ── D6-2: Profile picture ─────────────────────────────────────────────────────

@router.post("/avatar", response_model=SettingsResponse)
async def upload_avatar(
    file: UploadFile = File(...),
    current: dict = Depends(get_current_user),
):
    """
    D6-2: Upload a profile picture.
    Reuses the same size-limit + extension allow-list pattern from notes.py.
    Stored as a base64-encoded string in the users document — consistent
    with the 'everything in Mongo' pattern; no new infrastructure needed.
    """
    data = await file.read()
    fname = file.filename or "avatar"
    ext   = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""

    if len(data) > AVATAR_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Image too large ({len(data)//1024} KB). Max 2 MB.",
        )
    if ext not in AVATAR_ALLOWED:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported type '.{ext}'. Allowed: {', '.join(sorted(AVATAR_ALLOWED))}",
        )

    b64 = base64.b64encode(data).decode()
    mime = "image/jpeg" if ext in {"jpg", "jpeg"} else f"image/{ext}"
    data_uri = f"data:{mime};base64,{b64}"

    await users_col().update_one(
        {"_id": ObjectId(current["user_id"])},
        {"$set": {"avatar_b64": data_uri}},
    )
    user = await _get_user(current["user_id"])
    return _settings_response(user)


# ── D6-4: Light/dark theme ────────────────────────────────────────────────────

@router.post("/theme/{theme}", response_model=SettingsResponse)
async def set_theme(theme: str, current: dict = Depends(get_current_user)):
    """D6-4: Persist theme choice on the server so it survives browser clears."""
    if theme not in VALID_THEMES:
        raise HTTPException(status_code=422, detail=f"Theme must be 'light' or 'dark'")
    await users_col().update_one(
        {"_id": ObjectId(current["user_id"])},
        {"$set": {"theme": theme}},
    )
    user = await _get_user(current["user_id"])
    return _settings_response(user)


# ── D6-5: Change password ─────────────────────────────────────────────────────

@router.post("/password")
async def change_password(
    body: PasswordChange,
    current: dict = Depends(get_current_user),
):
    """
    D6-5: Change password — verifies current password, enforces Day 1
    complexity policy on the new password, then re-hashes with bcrypt.
    """
    # Reuse Day 1 validator
    try:
        body.validate_new()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # F5 FIX: rate-limit current-password verification attempts. A stolen
    # session (JWT cookie) without the actual password could otherwise be
    # used to brute-force it here with no throttling.
    if not await check_rate_limit("password_change", current["user_id"], 5, 15):
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Try again in a few minutes.",
        )

    user = await _get_user(current["user_id"])
    if not await run_in_threadpool(verify_password, body.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    new_hash = await run_in_threadpool(hash_password, body.new_password)
    await users_col().update_one(
        {"_id": ObjectId(current["user_id"])},
        {"$set": {"password_hash": new_hash}},
    )

    # D5: fire password_changed notification (wired here as promised in Day 5)
    import asyncio
    asyncio.create_task(notify_user(
        user_id=current["user_id"],
        event="password_changed",
        payload={"email": user["email"]},
    ))
    
    # Log activity
    asyncio.create_task(_log_activity(current["user_id"], "password_changed"))

    return {"message": "Password changed successfully"}


# ── D6-6: Notification preferences ───────────────────────────────────────────

@router.get("/notifications", response_model=NotificationPrefs)
async def get_notification_prefs(current: dict = Depends(get_current_user)):
    user = await _get_user(current["user_id"])
    return NotificationPrefs(
        enabled_events=user.get("notification_prefs", list(VALID_NOTIF_EVENTS))
    )


@router.put("/notifications", response_model=NotificationPrefs)
async def set_notification_prefs(
    body: NotificationPrefs,
    current: dict = Depends(get_current_user),
):
    """D6-6: Store which notification event types the user opts into."""
    invalid = [e for e in body.enabled_events if e not in VALID_NOTIF_EVENTS]
    if invalid:
        raise HTTPException(status_code=422, detail=f"Unknown events: {invalid}")
    await users_col().update_one(
        {"_id": ObjectId(current["user_id"])},
        {"$set": {"notification_prefs": body.enabled_events}},
    )
    return body


# ── D6-8: Study preferences (session length + break ratio) ────────────────────

@router.get("/study-prefs", response_model=StudyPrefs)
async def get_study_prefs(current: dict = Depends(get_current_user)):
    user = await _get_user(current["user_id"])
    return StudyPrefs(
        default_session_length=user.get("preferred_session_length"),
        default_break_ratio=user.get("default_break_ratio"),
        default_mcq_count=user.get("default_mcq_count"),
        default_mcq_difficulty=user.get("default_mcq_difficulty"),
        archive_after_days=user.get("archive_after_days"),
    )


@router.put("/study-prefs", response_model=StudyPrefs)
async def set_study_prefs(
    body: StudyPrefs,
    current: dict = Depends(get_current_user),
):
    """
    D6-8: Per-user study session defaults.
    These same fields are read by timetable.py's _distribute_sections (D4),
    so changing them here immediately affects the next timetable generation.
    """
    update: dict = {}
    if body.default_session_length is not None:
        update["preferred_session_length"] = body.default_session_length
    if body.default_break_ratio is not None:
        update["default_break_ratio"] = body.default_break_ratio
    if body.default_mcq_count is not None:
        update["default_mcq_count"] = body.default_mcq_count
    if body.default_mcq_difficulty is not None:
        update["default_mcq_difficulty"] = body.default_mcq_difficulty
    if body.archive_after_days is not None:
        update["archive_after_days"] = body.archive_after_days
    if update:
        await users_col().update_one({"_id": ObjectId(current["user_id"])}, {"$set": update})
    user = await _get_user(current["user_id"])
    return StudyPrefs(
        default_session_length=user.get("preferred_session_length"),
        default_break_ratio=user.get("default_break_ratio"),
        default_mcq_count=user.get("default_mcq_count"),
        default_mcq_difficulty=user.get("default_mcq_difficulty"),
        archive_after_days=user.get("archive_after_days"),
    )


# ── D6-9: Export user data ────────────────────────────────────────────────────

@router.get("/export")
async def export_data(current: dict = Depends(get_current_user)):
    """
    D6-9: Download all the requesting user's own data as a JSON bundle.
    Scoped strictly to user_id — cannot access another user's data.
    """
    uid = current["user_id"]

    user = await _get_user(uid)
    user.pop("password_hash", None)       # Never export password hash
    user.pop("two_factor_secret", None)   # Never export TOTP secret
    user["_id"] = str(user["_id"])

    notes = await notes_col().find({"user_id": uid}).to_list(500)
    for n in notes:
        n["_id"] = str(n["_id"])

    sections = await note_sections_col().find({"note_id": {"$in": [n["_id"] for n in notes]}}).to_list(2000)
    for s in sections:
        s["_id"] = str(s.get("_id", ""))

    timetables = await timetables_col().find({"user_id": uid}).to_list(100)
    for t in timetables:
        t["_id"] = str(t["_id"])

    progress = await progress_col().find({"user_id": uid}).to_list(2000)
    for p in progress:
        p["_id"] = str(p.get("_id", ""))
        if hasattr(p.get("date"), "isoformat"):
            p["date"] = p["date"].isoformat()

    # F4 FIX: mcqs_col() documents have no user_id field (see mcq.py's insert) —
    # they're keyed only by section_id. A user_id filter here can never match
    # anything. Scope via this user's own section_ids instead.
    section_ids = [s["_id"] for s in sections]
    mcqs = await mcqs_col().find({"section_id": {"$in": section_ids}}).to_list(1000) if section_ids else []
    for m in mcqs:
        m["_id"] = str(m.get("_id", ""))

    # Log activity
    import asyncio
    asyncio.create_task(_log_activity(uid, "data_exported"))

    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "user": user,
        "notes": notes,
        "note_sections": sections,
        "timetables": timetables,
        "progress": progress,
        "mcqs": mcqs,
    }


# ── Feature 2: Study Streak Tracking ───────────────────────────────────────────

@router.get("/streak", response_model=StreakResponse)
async def get_streak(current: dict = Depends(get_current_user)):
    """
    Feature 2: Compute the user's current consecutive-day study streak.
    Delegates to services/streaks.py, which is also used by the daily
    streak-nudge job so both share one (correctly-dated) implementation.
    """
    result = await compute_streak(current["user_id"])
    return StreakResponse(
        current_streak=result.current_streak,
        longest_streak=result.longest_streak,
        last_study_date=result.last_study_date,
        studied_today=result.studied_today,
    )


# ── Feature 3: Email Address Change ───────────────────────────────────────────

@router.post("/email")
async def change_email(
    body: EmailChangeRequest,
    current: dict = Depends(get_current_user),
):
    """
    Feature 3: Let users change their email address.
    Requires current password confirmation.
    """
    uid = current["user_id"]
    
    # Verify current password
    user = await _get_user(uid)
    if not await run_in_threadpool(verify_password, body.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    
    # Normalize new email
    new_email = body.new_email.lower()
    
    # Check if new email is already registered
    existing = await users_col().find_one({"email": new_email})
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    
    # Update user document
    old_email = user["email"]
    await users_col().update_one(
        {"_id": ObjectId(uid)},
        {"$set": {"email": new_email}}
    )
    
    # Fire notification — F3 FIX: explicitly target the OLD address via
    # payload["email"]. Without this, notify_user()'s DB-lookup fallback would
    # resolve to the user's *current* (new) email, since the update above has
    # already committed — silently alerting the wrong address about a change
    # to itself instead of warning the address being replaced.
    import asyncio
    asyncio.create_task(notify_user(
        user_id=uid,
        event="email_changed",
        payload={"old_email": old_email, "new_email": new_email, "email": old_email}
    ))
    
    # Log activity
    asyncio.create_task(_log_activity(uid, "email_changed", new_email))
    
    return {"message": "Email updated", "new_email": new_email}


# ── Feature 4: Account Activity Log ────────────────────────────────────────────

@router.get("/activity", response_model=list[ActivityEntry])
async def get_activity(current: dict = Depends(get_current_user)):
    """
    Feature 4: Return the last 20 security-relevant events.
    """
    user = await _get_user(current["user_id"])
    raw = user.get("activity_log", [])
    return list(reversed(raw))  # most recent first


# ── Feature 6: Timetable Display Preferences ───────────────────────────────────

@router.get("/display-prefs", response_model=DisplayPrefs)
async def get_display_prefs(current: dict = Depends(get_current_user)):
    """Feature 6: Get timetable display preferences."""
    user = await _get_user(current["user_id"])
    return DisplayPrefs(
        week_start_day=user.get("week_start_day"),
        time_format=user.get("time_format"),
        timetable_default_view=user.get("timetable_default_view"),
    )


@router.put("/display-prefs", response_model=DisplayPrefs)
async def set_display_prefs(
    body: DisplayPrefs,
    current: dict = Depends(get_current_user),
):
    """Feature 6: Update timetable display preferences."""
    update: dict = {}
    
    if body.week_start_day is not None:
        if body.week_start_day not in ["Monday", "Sunday"]:
            raise HTTPException(status_code=422, detail="week_start_day must be 'Monday' or 'Sunday'")
        update["week_start_day"] = body.week_start_day
    
    if body.time_format is not None:
        if body.time_format not in ["12h", "24h"]:
            raise HTTPException(status_code=422, detail="time_format must be '12h' or '24h'")
        update["time_format"] = body.time_format
    
    if body.timetable_default_view is not None:
        if body.timetable_default_view not in ["current_day", "full_week"]:
            raise HTTPException(status_code=422, detail="timetable_default_view must be 'current_day' or 'full_week'")
        update["timetable_default_view"] = body.timetable_default_view
    
    if update:
        await users_col().update_one(
            {"_id": ObjectId(current["user_id"])},
            {"$set": update}
        )
    
    user = await _get_user(current["user_id"])
    return DisplayPrefs(
        week_start_day=user.get("week_start_day"),
        time_format=user.get("time_format"),
        timetable_default_view=user.get("timetable_default_view"),
    )


# ── Feature 9: Remove Avatar ─────────────────────────────────────────────────

@router.delete("/avatar", response_model=SettingsResponse)
async def delete_avatar(current: dict = Depends(get_current_user)):
    """Feature 9: Delete profile picture and revert to initial-letter placeholder."""
    await users_col().update_one(
        {"_id": ObjectId(current["user_id"])},
        {"$unset": {"avatar_b64": ""}},
    )
    user = await _get_user(current["user_id"])
    return _settings_response(user)


# ── D6-10: Delete account ─────────────────────────────────────────────────────

@router.delete("/account")
async def delete_account(
    current: dict = Depends(get_current_user),
):
    """
    D6-10: Cascade-delete all data owned by the authenticated user.

    Deletes from: notes, note_sections, timetables, mcqs, progress, q_table,
    and finally the users document itself.  Ownership filters mirror the same
    pattern used throughout the codebase (never touches other users' data).
    """
    uid = current["user_id"]
    oid = ObjectId(uid)

    # Gather note IDs first (needed to delete note_sections)
    note_docs = await notes_col().find({"user_id": uid}, {"_id": 1}).to_list(500)
    note_ids  = [str(n["_id"]) for n in note_docs]

    results = {}

    # F4 FIX: fetch this user's section_ids BEFORE deleting note_sections, so
    # mcqs_col() (which has no user_id field — see mcq.py's insert) can be
    # scoped by section_id instead of a user_id filter that never matches.
    section_ids: list[str] = []
    if note_ids:
        section_docs = await note_sections_col().find({"note_id": {"$in": note_ids}}, {"_id": 1}).to_list(2000)
        section_ids = [s["_id"] for s in section_docs]
        r = await note_sections_col().delete_many({"note_id": {"$in": note_ids}})
        results["note_sections_deleted"] = r.deleted_count

    r = await notes_col().delete_many({"user_id": uid})
    results["notes_deleted"] = r.deleted_count

    r = await timetables_col().delete_many({"user_id": uid})
    results["timetables_deleted"] = r.deleted_count

    if section_ids:
        r = await mcqs_col().delete_many({"section_id": {"$in": section_ids}})
        results["mcqs_deleted"] = r.deleted_count
    else:
        results["mcqs_deleted"] = 0

    r = await progress_col().delete_many({"user_id": uid})
    results["progress_deleted"] = r.deleted_count

    r = await q_table_col().delete_many({"user_id": uid})
    results["q_table_deleted"] = r.deleted_count

    r = await users_col().delete_one({"_id": oid})
    results["user_deleted"] = r.deleted_count

    logger.info("[Settings] Account deleted: user_id=%s results=%s", uid, results)
    return {"message": "Account and all associated data deleted", **results}
