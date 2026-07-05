import asyncio
import logging
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Response, Cookie, status, Depends, Request
from bson import ObjectId
from typing import Optional

from ..core.database import users_col, sessions_col
from ..core.config import settings
from ..core.security import (
    hash_password, verify_password,
    create_access_token, create_refresh_token, decode_token,
    get_current_user, get_current_user_from_refresh,
)
from ..schemas import SignupRequest, LoginRequest, AuthResponse
from ..services.notifications import notify_user
from ..services.rate_limit import check_rate_limit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

# F5 FIX: no rate limiting previously existed on login — a password could be
# brute-forced against a known email with no throttling at all.
LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_MINUTES = 15


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


def _set_cookies(response: Response, user_id: str, email: str, request: Request = None):
    return _set_cookies_helper(response, user_id, email, request)


def _set_cookies_helper(response: Response, user_id: str, email: str, request: Request = None):
    """
    Set httpOnly auth cookies.
    secure=True in production so tokens are never sent over plain HTTP.
    Creates a session document and includes session ID in the access token.
    """
    is_prod = settings.is_production
    
    # Create session document
    session_id = str(uuid.uuid4())
    user_agent = request.headers.get("user-agent", "Unknown") if request else "Unknown"
    ip_address = request.client.host if request else "Unknown"
    
    now = datetime.now(timezone.utc)
    session_doc = {
        "_id": session_id,
        "user_id": user_id,
        "user_agent": user_agent,
        "ip_address": ip_address,
        "created_at": now,
        "last_seen": now,
    }
    
    # Insert session asynchronously (fire and forget for login performance)
    async def insert_session():
        await sessions_col().insert_one(session_doc)
    asyncio.create_task(insert_session())
    
    # Include session ID in access token
    access  = create_access_token({"sub": user_id, "email": email, "sid": session_id})
    refresh = create_refresh_token({"sub": user_id, "email": email})
    response.set_cookie(
        "access_token", access,
        httponly=True, samesite="lax", secure=is_prod, max_age=1800,
    )
    response.set_cookie(
        "refresh_token", refresh,
        httponly=True, samesite="lax", secure=is_prod, max_age=604800,
    )
    return access


@router.post("/signup", response_model=AuthResponse)
async def signup(body: SignupRequest, response: Response, request: Request):
    col = users_col()

    # D1-2: Replace $regex lookup with exact match on already-normalised lowercase
    # email.  The previous $regex approach was a NoSQL injection risk — a '.' in
    # the user-supplied address is a regex wildcard, allowing "a.b@x.com" to
    # accidentally match "axb@x.com", and crafted patterns could enumerate users.
    normalised_email = body.email.lower()
    existing = await col.find_one({"email": normalised_email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    doc = {
        "name":          body.name.strip(),
        "email":         normalised_email,
        "password_hash": hash_password(body.password),
        "level":         body.level,
        "created_at":    datetime.now(timezone.utc),
    }
    result = await col.insert_one(doc)
    user_id = str(result.inserted_id)
    _set_cookies(response, user_id, normalised_email, request)

    # D5: Fire account_created notification (fire-and-forget — never blocks response)
    asyncio.create_task(notify_user(
        user_id=user_id,
        event="account_created",
        payload={"name": doc["name"], "email": normalised_email},
    ))

    return AuthResponse(
        user_id=user_id, name=doc["name"],
        email=normalised_email, level=doc["level"],
        avatar_b64=doc.get("avatar_b64"),
        message="Account created",
    )


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest, response: Response, request: Request):
    col = users_col()
    # D1-2: Direct exact-match lookup against the stored lowercase value.
    # All emails are normalised to lowercase at signup, so this is both correct
    # and safe — no regex metacharacter risk.
    normalised_email = body.email.lower()

    # F5 FIX: rate-limit by the target account (not just source IP) so a
    # single email address can't be password-brute-forced with no throttling.
    if not await check_rate_limit("login", normalised_email, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MINUTES):
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Try again in a few minutes.",
        )

    user = await col.find_one({"email": normalised_email})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user_id = str(user["_id"])

    # D7: If 2FA is enabled, do NOT set cookies yet — return an intermediate
    # response with a short-lived pending token.  The client must then call
    # POST /auth/2fa/verify-login with a valid TOTP code to get real cookies.
    if user.get("two_factor_enabled"):
        from .twofa import _create_pending_token
        pending_token = _create_pending_token(user_id, user["email"])
        logger.info("[Auth] 2FA challenge issued for user %s", user_id)
        # 202 Accepted signals "more steps needed" without being a 4xx error
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={
                "requires_2fa":  True,
                "pending_token": pending_token,
                "message":       "TOTP code required",
            },
        )

    _set_cookies(response, user_id, user["email"], request)
    
    # Log login activity
    asyncio.create_task(_log_activity(user_id, "login", user["email"]))
    
    return AuthResponse(
        user_id=user_id, name=user["name"],
        email=user["email"], level=user["level"],
        avatar_b64=user.get("avatar_b64"),
        message="Logged in",
    )


@router.post("/refresh")
async def refresh(
    response: Response,
    request: Request,
    current: dict = Depends(get_current_user_from_refresh),
):
    """
    A1: Uses the typed dependency instead of manual cookie decode + type check.
    """
    user = await users_col().find_one({"_id": ObjectId(current["user_id"])})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    _set_cookies(response, current["user_id"], user["email"], request)
    return {"message": "Token refreshed"}


@router.post("/logout")
async def logout(response: Response, request: Request):
    """
    A2: Delete cookies with matching attributes so browsers reliably clear them.
    Also deletes the session document if present.
    """
    from ..core.security import decode_token
    
    # Delete session if session ID is in token
    access_token = request.cookies.get("access_token")
    if access_token:
        try:
            payload = decode_token(access_token, expected_type="access")
            session_id = payload.get("sid")
            if session_id:
                asyncio.create_task(sessions_col().delete_one({"_id": session_id}))
        except Exception:
            pass  # Best effort - continue with cookie deletion
    
    is_prod = settings.is_production
    response.delete_cookie("access_token",  httponly=True, samesite="lax", secure=is_prod)
    response.delete_cookie("refresh_token", httponly=True, samesite="lax", secure=is_prod)
    return {"message": "Logged out"}


@router.get("/me", response_model=AuthResponse)
async def me(current: dict = Depends(get_current_user)):
    user = await users_col().find_one({"_id": ObjectId(current["user_id"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return AuthResponse(
        user_id=str(user["_id"]), name=user["name"],
        email=user["email"], level=user["level"],
        avatar_b64=user.get("avatar_b64"),
        message="ok",
    )
