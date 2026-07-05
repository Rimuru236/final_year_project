# import hashlib
# from datetime import datetime, timedelta, timezone
# from typing import Optional
# from fastapi import Cookie, HTTPException, status
# from jose import JWTError, jwt
# from passlib.context import CryptContext
# from .config import settings

# pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")



# def hash_password(password: str) -> str:
#     prehashed = hashlib.sha256(password.encode()).hexdigest()
#     return pwd_context.hash(prehashed)


# def verify_password(plain: str, hashed: str) -> bool:
#     prehashed = hashlib.sha256(plain.encode()).hexdigest()  # ✅ FIXED
#     return pwd_context.verify(prehashed, hashed)

# def create_access_token(data: dict) -> str:
#     to_encode = data.copy()
#     expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
#     to_encode.update({"exp": expire, "type": "access"})
#     return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


# def create_refresh_token(data: dict) -> str:
#     to_encode = data.copy()
#     expire = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
#     to_encode.update({"exp": expire, "type": "refresh"})
#     return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


# def decode_token(token: str) -> dict:
#     try:
#         return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
#     except JWTError:
#         raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


# async def get_current_user(access_token: Optional[str] = Cookie(default=None)) -> dict:
#     if not access_token:
#         raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
#     payload = decode_token(access_token)
#     if payload.get("type") != "access":
#         raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
#     return {"user_id": payload.get("sub"), "email": payload.get("email")}

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from fastapi import Cookie, HTTPException, status
from jose import ExpiredSignatureError, JWTError, jwt

from .config import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------

def _prehash(password: str) -> bytes:
    """SHA-256 binary digest (32 bytes) — safely under bcrypt's 72-byte limit."""
    return hashlib.sha256(password.encode("utf-8")).digest()


def hash_password(password: str) -> str:
    """Hash a plaintext password. Returns a bcrypt hash string."""
    hashed = bcrypt.hashpw(_prehash(password), bcrypt.gensalt())
    return hashed.decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a stored bcrypt hash."""
    try:
        return bcrypt.checkpw(_prehash(plain), hashed.encode("utf-8"))
    except Exception:
        logger.warning("bcrypt.checkpw raised an unexpected error", exc_info=True)
        return False


# ---------------------------------------------------------------------------
# Token creation
# ---------------------------------------------------------------------------

def create_access_token(data: dict) -> str:
    """Create a short-lived access token."""
    to_encode = data.copy()
    to_encode.update({
        "type": "access",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes),
        "iat": datetime.now(timezone.utc),
    })
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


def create_refresh_token(data: dict) -> str:
    """Create a long-lived refresh token."""
    to_encode = data.copy()
    to_encode.update({
        "type": "refresh",
        "exp": datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days),
        "iat": datetime.now(timezone.utc),
    })
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


# ---------------------------------------------------------------------------
# Token decoding & validation
# ---------------------------------------------------------------------------

def decode_token(token: str, expected_type: str = "access") -> dict:
    """
    Decode and validate a JWT.
    Raises a specific 401 HTTPException for expired, invalid, or wrong-type tokens.
    """
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
        )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )

    if payload.get("type") != expected_type:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token type: expected '{expected_type}'",
        )

    return payload


# ---------------------------------------------------------------------------
# Current user dependencies
# ---------------------------------------------------------------------------

async def get_current_user(access_token: Optional[str] = Cookie(default=None)) -> dict:
    """FastAPI dependency — extracts and validates the current user from cookie."""
    if not access_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    payload = decode_token(access_token, expected_type="access")

    user_id = payload.get("sub")
    email = payload.get("email")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload: missing subject",
        )

    return {"user_id": user_id, "email": email}


async def get_current_user_from_refresh(refresh_token: Optional[str] = Cookie(default=None)) -> dict:
    """FastAPI dependency — validates a refresh token and returns the user_id."""
    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No refresh token provided",
        )

    payload = decode_token(refresh_token, expected_type="refresh")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload: missing subject",
        )

    return {"user_id": user_id}