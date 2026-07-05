"""
Session Management Router — Settings Improvement Feature 1.

Manages user login sessions including device tracking, session listing,
and individual/bulk session revocation.
"""

import logging
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from ..core.database import sessions_col
from ..core.security import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings/sessions", tags=["settings"])


# ── Pydantic models ───────────────────────────────────────────────────────────

class SessionItem(BaseModel):
    session_id: str
    user_agent: str
    ip_address: str
    created_at: datetime
    last_seen: datetime
    is_current: bool


# ── Helper functions ─────────────────────────────────────────────────────────

async def _get_current_session_id(request: Request, current: dict) -> Optional[str]:
    """
    Extract the session ID from the current access token's 'sid' claim.
    Returns None if not present (backwards compatibility).
    """
    from ..core.security import decode_token
    
    access_token = request.cookies.get("access_token")
    if not access_token:
        return None
    
    try:
        payload = decode_token(access_token, expected_type="access")
        return payload.get("sid")
    except Exception:
        return None


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("", response_model=list[SessionItem])
async def get_sessions(
    request: Request,
    current: dict = Depends(get_current_user)
):
    """
    List all sessions for the current user, ordered by last_seen descending.
    The calling session is marked with is_current: True.
    """
    user_id = current["user_id"]
    current_session_id = await _get_current_session_id(request, current)
    
    sessions = await sessions_col().find(
        {"user_id": user_id}
    ).sort("last_seen", -1).to_list(100)
    
    result = []
    for session in sessions:
        result.append(SessionItem(
            session_id=str(session["_id"]),
            user_agent=session.get("user_agent", "Unknown"),
            ip_address=session.get("ip_address", "Unknown"),
            created_at=session.get("created_at"),
            last_seen=session.get("last_seen"),
            is_current=(str(session["_id"]) == current_session_id) if current_session_id else False
        ))
    
    return result


@router.delete("/{session_id}")
async def revoke_session(
    session_id: str,
    current: dict = Depends(get_current_user)
):
    """
    Revoke a specific session by deleting the document.
    Ownership check ensures users can only revoke their own sessions.

    F1 FIX: session `_id`s are UUID4 strings (see auth.py's _set_cookies_helper),
    not ObjectIds — the previous ObjectId(session_id) conversion always raised,
    so this endpoint 400'd for every real session. Query by the raw string ID.
    """
    user_id = current["user_id"]

    result = await sessions_col().delete_one({
        "_id": session_id,
        "user_id": user_id
    })

    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Session not found or not owned by you")

    return {"message": "Session revoked"}


@router.delete("")
async def revoke_other_sessions(
    request: Request,
    current: dict = Depends(get_current_user)
):
    """
    Revoke all sessions for this user except the current one.

    F2 FIX: same root cause as F1 — converting the current session's UUID
    string to ObjectId always raised, which fell into the "delete everything"
    fallback on every call, including the caller's own session. Now compares
    the raw string ID directly, so the current session is correctly preserved.
    """
    user_id = current["user_id"]
    current_session_id = await _get_current_session_id(request, current)

    if current_session_id:
        result = await sessions_col().delete_many({
            "user_id": user_id,
            "_id": {"$ne": current_session_id}
        })
    else:
        # No session ID in token (e.g. a token issued before session tracking
        # existed) — there's nothing to identify as "current", so nothing can
        # be preserved: delete all.
        result = await sessions_col().delete_many({"user_id": user_id})

    return {
        "message": f"Revoked {result.deleted_count} other session(s)",
        "revoked_count": result.deleted_count
    }
