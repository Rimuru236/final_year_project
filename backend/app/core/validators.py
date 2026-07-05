"""
Shared field validators for Pydantic schemas.
Centralised here so both signup (auth.py) and change-password (settings.py Day 6)
reuse the exact same rules without duplicating logic.
"""
import re


# Password policy: 8–12 chars, at least one of each character class.
_PW_MIN = 8
_PW_MAX = 12
_RE_LOWER   = re.compile(r"[a-z]")
_RE_UPPER   = re.compile(r"[A-Z]")
_RE_DIGIT   = re.compile(r"\d")
_RE_SPECIAL = re.compile(r"[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>\/?`~]")


def validate_password_complexity(value: str) -> str:
    """
    Enforce the application password policy on creation / change.

    Rules (applied server-side; frontend mirrors them with the live strength bar):
    - 8–12 characters
    - At least one lowercase letter
    - At least one uppercase letter
    - At least one digit
    - At least one special character

    NOT applied to LoginRequest — existing hashes must continue to authenticate.
    """
    if len(value) < _PW_MIN:
        raise ValueError(f"Password must be at least {_PW_MIN} characters.")
    if len(value) > _PW_MAX:
        raise ValueError(f"Password must be at most {_PW_MAX} characters.")
    if not _RE_LOWER.search(value):
        raise ValueError("Password must contain at least one lowercase letter.")
    if not _RE_UPPER.search(value):
        raise ValueError("Password must contain at least one uppercase letter.")
    if not _RE_DIGIT.search(value):
        raise ValueError("Password must contain at least one digit.")
    if not _RE_SPECIAL.search(value):
        raise ValueError("Password must contain at least one special character.")
    return value
