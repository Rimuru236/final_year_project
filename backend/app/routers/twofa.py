"""
Two-Factor Authentication router — Day 7.

Implements TOTP-based 2FA using pyotp (RFC 6238 / Google Authenticator compatible).
Chosen over SMS (no provider in stack) and email-OTP (would create awkward dependency
loop with Day 5's fire-and-forget design).

Fields added to users document:
  two_factor_enabled: bool        — whether 2FA is active for this user
  two_factor_secret:  str | None  — base32 TOTP secret (stored only after verify/enable)
  two_factor_pending: str | None  — ephemeral secret during enrollment (pre-verify)

Login flow for 2FA-enabled users:
  1. POST /auth/login   →  {requires_2fa: true, pending_token: <short-lived JWT>}
  2. POST /auth/2fa/verify-login  (sends pending_token + totp_code) → sets cookies

Enrollment flow:
  1. POST /auth/2fa/enroll   →  {secret, qr_uri, qr_payload}
  2. POST /auth/2fa/enable   (sends totp_code to confirm)  → activates 2FA
  3. DELETE /auth/2fa/disable (sends totp_code to confirm) → deactivates 2FA

The enable/disable toggle on the Settings page (Day 6) calls enroll → enable
and disable respectively.  The toggle becomes interactive (non-disabled) in
SettingsPage.tsx once the Day 7 router is live.
"""

import logging
import asyncio
from datetime import datetime, timedelta, timezone

import pyotp
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from jose import JWTError, jwt
from pydantic import BaseModel

from ..core.config import settings
from ..core.database import users_col
from ..core.security import get_current_user
from ..services.rate_limit import check_rate_limit

logger = logging.getLogger(__name__)

# F5 FIX: no rate limiting previously existed on TOTP verification — a 6-digit
# code (±30s window) is brute-forceable in well under 1M attempts unthrottled.
TOTP_MAX_ATTEMPTS = 5
TOTP_WINDOW_MINUTES = 15

router = APIRouter(prefix="/auth/2fa", tags=["2fa"])


async def _log_activity(user_id: str, event: str, detail: str = "") -> None:
    """Log security-relevant events to the user's activity log."""
    from datetime import datetime, timezone
    
    entry = {
        "event":  event,
        "detail": detail,
        "at":     datetime.now(timezone.utc).isoformat(),
    }
    await users_col().update_one(
        {"_id": ObjectId(user_id)},
        {"$push": {"activity_log": {"$each": [entry], "$slice": -20}}},
    )

# Short-lived pending token lifetime (5 minutes) — only valid between
# password-check step and TOTP-code step.
PENDING_TOKEN_MINUTES = 5
PENDING_TOKEN_TYPE    = "2fa_pending"


# ── Schemas ───────────────────────────────────────────────────────────────────

class EnrollResponse(BaseModel):
    secret:     str    # base32 secret — user copies into authenticator app
    qr_uri:     str    # otpauth:// URI — encodes into a QR code client-side
    issuer:     str


class EnableRequest(BaseModel):
    totp_code: str     # 6-digit code from authenticator, confirms enrollment


class DisableRequest(BaseModel):
    totp_code: str     # must prove possession before disabling


class VerifyLoginRequest(BaseModel):
    pending_token: str  # short-lived JWT issued by POST /auth/login
    totp_code:     str  # 6-digit TOTP code


# ── Pending token helpers ─────────────────────────────────────────────────────

def _create_pending_token(user_id: str, email: str) -> str:
    """Issue a short-lived JWT that bridges the two login steps."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=PENDING_TOKEN_MINUTES)
    return jwt.encode(
        {"sub": user_id, "email": email, "type": PENDING_TOKEN_TYPE, "exp": expire},
        settings.secret_key,
        algorithm=settings.algorithm,
    )


def _decode_pending_token(token: str) -> dict:
    """Validate and decode a pending token; raises HTTPException on failure."""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired 2FA session")
    if payload.get("type") != PENDING_TOKEN_TYPE:
        raise HTTPException(status_code=401, detail="Invalid token type")
    return payload


# ── TOTP verification helper ──────────────────────────────────────────────────

def _verify_totp(secret: str, code: str) -> bool:
    """
    Verify a 6-digit TOTP code against a base32 secret.
    valid_window=1 allows ±30 seconds of clock drift.
    """
    try:
        totp = pyotp.TOTP(secret)
        return totp.verify(code, valid_window=1)
    except Exception:
        return False


# ── Enrollment ────────────────────────────────────────────────────────────────

@router.post("/enroll", response_model=EnrollResponse)
async def enroll(current: dict = Depends(get_current_user)):
    """
    D7-1 Enrollment step 1: generate a new TOTP secret and return the
    otpauth:// URI the frontend uses to render a QR code.

    The secret is stored as `two_factor_pending` (NOT `two_factor_secret`)
    until the user confirms with a valid code via POST /enable.  This ensures
    a misconfigured authenticator can never lock the user out.
    """
    user = await users_col().find_one({"_id": ObjectId(current["user_id"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    secret  = pyotp.random_base32()
    issuer  = "Cognitive Sanctuary"
    account = user.get("email", current["user_id"])
    qr_uri  = pyotp.totp.TOTP(secret).provisioning_uri(name=account, issuer_name=issuer)

    # Store as pending — NOT active until /enable confirms it
    await users_col().update_one(
        {"_id": ObjectId(current["user_id"])},
        {"$set": {"two_factor_pending": secret}},
    )

    logger.info("[2FA] Enrollment initiated for user %s", current["user_id"])
    return EnrollResponse(secret=secret, qr_uri=qr_uri, issuer=issuer)


@router.post("/enable")
async def enable_2fa(
    body: EnableRequest,
    current: dict = Depends(get_current_user),
):
    """
    D7-1 Enrollment step 2: verify the TOTP code against the pending secret,
    then promote it to the active secret and set two_factor_enabled=True.
    """
    user = await users_col().find_one({"_id": ObjectId(current["user_id"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    pending = user.get("two_factor_pending")
    if not pending:
        raise HTTPException(
            status_code=400,
            detail="No enrollment in progress. Call POST /auth/2fa/enroll first.",
        )

    # F5 FIX: rate-limit TOTP verification attempts per account.
    if not await check_rate_limit("2fa_enable", current["user_id"], TOTP_MAX_ATTEMPTS, TOTP_WINDOW_MINUTES):
        raise HTTPException(
            status_code=429,
            detail="Too many verification attempts. Try again in a few minutes.",
        )

    if not _verify_totp(pending, body.totp_code):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    await users_col().update_one(
        {"_id": ObjectId(current["user_id"])},
        {
            "$set":   {"two_factor_secret": pending, "two_factor_enabled": True},
            "$unset": {"two_factor_pending": ""},
        },
    )
    
    # Log activity
    asyncio.create_task(_log_activity(current["user_id"], "2fa_enabled"))
    
    logger.info("[2FA] Enabled for user %s", current["user_id"])
    return {"message": "Two-factor authentication enabled"}


# ── Disable ───────────────────────────────────────────────────────────────────

@router.delete("/disable")
async def disable_2fa(
    body: DisableRequest,
    current: dict = Depends(get_current_user),
):
    """
    D7-2 Disable: verify a live TOTP code to confirm possession, then clear
    the secret and set two_factor_enabled=False.
    Disabling via Settings immediately reverts to single-factor login.
    """
    user = await users_col().find_one({"_id": ObjectId(current["user_id"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if not user.get("two_factor_enabled"):
        raise HTTPException(status_code=400, detail="2FA is not enabled")

    # F5 FIX: rate-limit TOTP verification attempts per account.
    if not await check_rate_limit("2fa_disable", current["user_id"], TOTP_MAX_ATTEMPTS, TOTP_WINDOW_MINUTES):
        raise HTTPException(
            status_code=429,
            detail="Too many verification attempts. Try again in a few minutes.",
        )

    secret = user.get("two_factor_secret")
    if not secret or not _verify_totp(secret, body.totp_code):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    await users_col().update_one(
        {"_id": ObjectId(current["user_id"])},
        {
            "$set":   {"two_factor_enabled": False},
            "$unset": {"two_factor_secret": "", "two_factor_pending": ""},
        },
    )
    
    # Log activity
    asyncio.create_task(_log_activity(current["user_id"], "2fa_disabled"))
    
    logger.info("[2FA] Disabled for user %s", current["user_id"])
    return {"message": "Two-factor authentication disabled"}


# ── Login second-factor verification ─────────────────────────────────────────

@router.post("/verify-login")
async def verify_login(body: VerifyLoginRequest, response: Response, request: Request):
    """
    D7-3 Login step 2: called only when POST /auth/login returned
    {requires_2fa: true}.  Validates the pending_token (short-lived JWT)
    and the TOTP code, then issues the real httpOnly cookies.
    """
    from fastapi.responses import JSONResponse

    payload = _decode_pending_token(body.pending_token)
    user_id = payload["sub"]
    email   = payload["email"]

    # F5 FIX: rate-limit TOTP verification attempts per account.
    if not await check_rate_limit("2fa_verify", user_id, TOTP_MAX_ATTEMPTS, TOTP_WINDOW_MINUTES):
        raise HTTPException(
            status_code=429,
            detail="Too many verification attempts. Try again in a few minutes.",
        )

    user = await users_col().find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if not user.get("two_factor_enabled"):
        raise HTTPException(status_code=400, detail="2FA is not enabled for this account")

    secret = user.get("two_factor_secret")
    if not secret or not _verify_totp(secret, body.totp_code):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    from .auth import _set_cookies_helper
    _set_cookies_helper(response, user_id, email, request)
    logger.info("[2FA] Login verified for user %s", user_id)
    return {
        "user_id": user_id,
        "name":    user.get("name", ""),
        "email":   email,
        "level":   user.get("level", ""),
        "message": "Logged in with 2FA",
    }
