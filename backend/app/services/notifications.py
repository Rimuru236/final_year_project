"""
Notification service — Day 5.

Replaces the Day 2 log-only stub with real async SMTP delivery via aiosmtplib.

Design principles:
- Fire-and-forget: notify_user() NEVER raises. Failures are logged and swallowed
  so the HTTP response is never blocked.
- Safe fallback: when SMTP_HOST is blank (or delivery fails) the message is
  logged at INFO level — same behaviour as the Day 2 stub — so the app works
  fully in development without any email configuration.
- Non-blocking: uses aiosmtplib (async SMTP) so no thread pool is needed.
- Opt-in filtering: if a user has notification_prefs saved (set in Day 6's
  settings), events not in their preferences are suppressed.

Events dispatched (event name → human subject):
  "account_created"     → "Welcome to Cognitive Sanctuary"
  "password_changed"    → "Your password was changed"
  "email_changed"       → "Your account email was changed" (sent to the OLD address)
  "day_sections_ready"  → "Your [day] study sections are ready"
  "weekly_digest"       → "Your weekly study summary"  (Day 6+ can trigger this)
  "streak_reminder"     → "Keep your [N]-day streak alive!" (services/streaks.py)
"""

from __future__ import annotations

import asyncio
import logging
from email.message import EmailMessage
from textwrap import dedent
from typing import Any

logger = logging.getLogger(__name__)


# ── Template registry ─────────────────────────────────────────────────────────

def _render_html_wrapper(title: str, body_html: str) -> str:
    """Minimal but readable HTML email wrapper using inline styles."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title></head>
<body style="margin:0;padding:0;background:#f8f9fe;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fe;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:16px;overflow:hidden;
                    box-shadow:0 4px 24px rgba(68,86,186,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#4456ba,#6366f1);
                     padding:28px 32px;text-align:center;">
            <div style="display:inline-flex;align-items:center;gap:12px;">
              <div style="width:40px;height:40px;border-radius:10px;
                          background:rgba(255,255,255,0.2);display:inline-block;
                          line-height:40px;text-align:center;font-size:20px;">🧠</div>
              <span style="color:#fff;font-size:18px;font-weight:800;
                           letter-spacing:-0.5px;">Cognitive Sanctuary</span>
            </div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            {body_html}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px 24px;text-align:center;
                     border-top:1px solid #f0f0f8;">
            <p style="color:#9ca3af;font-size:12px;margin:0;">
              You're receiving this because you have an account at Cognitive Sanctuary.<br>
              To manage notification preferences, visit <strong>Settings → Notifications</strong>.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def _build_message(event: str, payload: dict) -> tuple[str, str, str] | None:
    """
    Return (subject, plain_text, html) for a given event + payload.
    Returns None for unknown events (no email sent).
    """
    name = payload.get("name", "there")

    if event == "account_created":
        subject = "Welcome to Cognitive Sanctuary 🎓"
        plain = dedent(f"""\
            Hi {name},

            Your Cognitive Sanctuary account is ready. Start by uploading your
            study notes and generating your first AI-powered timetable.

            Happy studying!
            — The Cognitive Sanctuary team
        """)
        html = _render_html_wrapper(subject, f"""
            <h1 style="color:#1e1b4b;font-size:24px;font-weight:800;margin:0 0 12px;">
              Welcome, {name}! 🎉
            </h1>
            <p style="color:#4b5563;line-height:1.7;margin:0 0 20px;">
              Your account is ready. Upload your study notes and let Cognitive
              Sanctuary's AI build a personalised timetable just for you.
            </p>
            <div style="text-align:center;margin:28px 0;">
              <a href="#" style="background:#4456ba;color:#fff;text-decoration:none;
                                 padding:14px 32px;border-radius:50px;font-weight:700;
                                 font-size:14px;display:inline-block;">
                Go to my Dashboard →
              </a>
            </div>
            <p style="color:#9ca3af;font-size:13px;margin:0;">
              If you did not create this account, you can safely ignore this email.
            </p>
        """)
        return subject, plain, html

    if event == "password_changed":
        email = payload.get("email", "your account")
        subject = "Your Cognitive Sanctuary password was changed"
        plain = dedent(f"""\
            Hi,

            The password for {email} was recently changed.

            If you made this change, no action is needed.
            If you did NOT make this change, please reset your password immediately.

            — The Cognitive Sanctuary team
        """)
        html = _render_html_wrapper(subject, f"""
            <h2 style="color:#1e1b4b;font-size:20px;font-weight:700;margin:0 0 12px;">
              Password changed
            </h2>
            <p style="color:#4b5563;line-height:1.7;margin:0 0 16px;">
              The password for <strong>{email}</strong> was recently updated.
            </p>
            <div style="background:#fef3c7;border-radius:12px;padding:16px;margin:0 0 20px;">
              <p style="color:#92400e;margin:0;font-size:13px;">
                ⚠️ If you did <strong>not</strong> make this change, reset your password
                immediately and contact support.
              </p>
            </div>
        """)
        return subject, plain, html

    if event == "email_changed":
        old_email = payload.get("old_email", "your old address")
        new_email = payload.get("new_email", "a new address")
        subject = "Your Cognitive Sanctuary account email was changed"
        plain = dedent(f"""\
            Hi,

            The email address on your Cognitive Sanctuary account was changed
            from {old_email} to {new_email}.

            If you made this change, no action is needed.
            If you did NOT make this change, your account may be compromised —
            reset your password immediately and contact support.

            — The Cognitive Sanctuary team
        """)
        html = _render_html_wrapper(subject, f"""
            <h2 style="color:#1e1b4b;font-size:20px;font-weight:700;margin:0 0 12px;">
              Account email changed
            </h2>
            <p style="color:#4b5563;line-height:1.7;margin:0 0 16px;">
              Your account email was changed from <strong>{old_email}</strong> to
              <strong>{new_email}</strong>.
            </p>
            <div style="background:#fef3c7;border-radius:12px;padding:16px;margin:0 0 20px;">
              <p style="color:#92400e;margin:0;font-size:13px;">
                ⚠️ If you did <strong>not</strong> make this change, your account may be
                compromised — reset your password immediately and contact support.
              </p>
            </div>
        """)
        return subject, plain, html

    if event == "day_sections_ready":
        day_name    = payload.get("day_name", "today's")
        tt_id       = payload.get("timetable_id", "")
        subject     = f"Your {day_name} study sections are ready 📚"
        plain = dedent(f"""\
            Hi,

            Your {day_name} study plan is ready in Cognitive Sanctuary.
            Head to your Timetable page to start your session.

            Timetable ID: {tt_id}

            — The Cognitive Sanctuary team
        """)
        html = _render_html_wrapper(subject, f"""
            <h2 style="color:#1e1b4b;font-size:20px;font-weight:700;margin:0 0 12px;">
              📚 Your {day_name} sessions are ready
            </h2>
            <p style="color:#4b5563;line-height:1.7;margin:0 0 20px;">
              Your AI-powered study plan for <strong>{day_name}</strong> is waiting.
              Open the Timetable page to begin your session.
            </p>
            <div style="text-align:center;margin:24px 0;">
              <a href="#" style="background:#4456ba;color:#fff;text-decoration:none;
                                 padding:14px 32px;border-radius:50px;font-weight:700;
                                 font-size:14px;display:inline-block;">
                View my Timetable →
              </a>
            </div>
        """)
        return subject, plain, html

    if event == "weekly_digest":
        overall = payload.get("overall_score", 0)
        attempts = payload.get("total_attempts", 0)
        subject  = "Your weekly study summary 📊"
        plain = dedent(f"""\
            Hi {name},

            Here's your Cognitive Sanctuary summary for this week:
            • Overall score: {overall:.0f}%
            • Total quiz attempts: {attempts}

            Keep it up!
            — The Cognitive Sanctuary team
        """)
        html = _render_html_wrapper(subject, f"""
            <h2 style="color:#1e1b4b;font-size:20px;font-weight:700;margin:0 0 16px;">
              📊 Weekly Study Summary
            </h2>
            <div style="display:flex;gap:16px;margin:0 0 24px;">
              <div style="flex:1;background:#ede9fe;border-radius:12px;
                          padding:20px;text-align:center;">
                <div style="font-size:32px;font-weight:800;color:#4456ba;">{overall:.0f}%</div>
                <div style="font-size:12px;color:#6b7280;margin-top:4px;">Overall Score</div>
              </div>
              <div style="flex:1;background:#d1fae5;border-radius:12px;
                          padding:20px;text-align:center;">
                <div style="font-size:32px;font-weight:800;color:#065f46;">{attempts}</div>
                <div style="font-size:12px;color:#6b7280;margin-top:4px;">Quiz Attempts</div>
              </div>
            </div>
            <p style="color:#4b5563;line-height:1.7;margin:0;">
              Keep building those study habits — consistency beats intensity every time. 🚀
            </p>
        """)
        return subject, plain, html

    if event == "streak_reminder":
        streak = payload.get("current_streak", 0)
        subject = f"Keep your {streak}-day streak alive! 🔥"
        plain = dedent(f"""\
            Hi {name},

            You're on a {streak}-day study streak — don't lose it! You
            haven't studied yet today. A quick session now keeps it going.

            — The Cognitive Sanctuary team
        """)
        html = _render_html_wrapper(subject, f"""
            <h2 style="color:#1e1b4b;font-size:20px;font-weight:700;margin:0 0 12px;">
              🔥 {streak}-day streak — keep it going!
            </h2>
            <p style="color:#4b5563;line-height:1.7;margin:0 0 20px;">
              You haven't studied yet today. A quick session now keeps your
              streak alive.
            </p>
            <div style="text-align:center;margin:24px 0;">
              <a href="#" style="background:#4456ba;color:#fff;text-decoration:none;
                                 padding:14px 32px;border-radius:50px;font-weight:700;
                                 font-size:14px;display:inline-block;">
                Continue Studying →
              </a>
            </div>
        """)
        return subject, plain, html

    logger.warning("[Notify] Unknown event '%s' — no template defined", event)
    return None


# ── Core send helper ──────────────────────────────────────────────────────────

async def _send_email(to_address: str, subject: str, plain: str, html: str) -> bool:
    """
    Attempt to send an email via aiosmtplib.
    Returns True on success, False on any failure (caller logs appropriately).
    """
    from app.core.config import settings   # local import avoids circular at module load

    if not settings.smtp_host:
        return False   # No SMTP configured — caller will log fallback

    try:
        import aiosmtplib
        msg = EmailMessage()
        msg["From"]    = f"{settings.smtp_from_name} <{settings.smtp_from}>"
        msg["To"]      = to_address
        msg["Subject"] = subject
        msg.set_content(plain)
        msg.add_alternative(html, subtype="html")

        await aiosmtplib.send(
            msg,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_username or None,
            password=settings.smtp_password or None,
            use_tls=(settings.smtp_port == 465),
            start_tls=(settings.smtp_port != 465) if settings.smtp_use_tls else False,
            # use_tls=settings.smtp_use_tls,
            timeout=10,
        )
        return True
    except ImportError:
        logger.warning("[Notify] aiosmtplib not installed — falling back to log-only")
        return False
    except Exception as exc:
        logger.warning("[Notify] SMTP delivery failed to %s: %s", to_address, exc)
        return False


# ── Public interface ───────────────────────────────────────────────────────────

async def notify_user(user_id: str, event: str, payload: dict) -> None:
    """
    Dispatch a notification for a user lifecycle event.  Fire-and-forget —
    never raises, never blocks the HTTP response.

    Looks up the user's email address and optional notification_prefs from
    MongoDB to decide whether to send and where to deliver.

    Events:
      "account_created"    payload: {"name": str, "email": str}
      "password_changed"   payload: {"email": str}
      "email_changed"      payload: {"old_email": str, "new_email": str, "email": <old_email>}
                            "email" must be set to old_email so this alerts the address
                            being replaced, not the new one (see routers/settings.py).
      "day_sections_ready" payload: {"timetable_id": str, "day_name": str}
      "weekly_digest"      payload: {"name": str, "overall_score": float, "total_attempts": int}
      "streak_reminder"    payload: {"current_streak": int}
    """
    try:
        await _notify_user_inner(user_id, event, payload)
    except Exception:
        logger.error("[Notify] Unexpected error in notify_user", exc_info=True)


async def _notify_user_inner(user_id: str, event: str, payload: dict) -> None:
    from app.core.database import users_col
    from bson import ObjectId

    # Resolve recipient email — use payload if provided (e.g. account_created
    # is called before the user doc may be committed), else look up from DB.
    to_email: str | None = payload.get("email")
    if not to_email:
        try:
            user = await users_col().find_one({"_id": ObjectId(user_id)})
            if user:
                to_email = user.get("email")
                # Merge name into payload if not provided
                if "name" not in payload and user.get("name"):
                    payload = {**payload, "name": user["name"]}
                # Check notification preferences (Day 6 settings)
                prefs: list[str] | None = user.get("notification_prefs")
                if prefs is not None and event not in prefs:
                    logger.info(
                        "[Notify] user=%s has opted out of event=%s — suppressed",
                        user_id, event,
                    )
                    return
        except Exception as exc:
            logger.warning("[Notify] Could not fetch user %s: %s", user_id, exc)

    # Build message
    result = _build_message(event, payload)
    if result is None:
        return  # Unknown event — already warned in _build_message
    subject, plain, html = result

    logger.info("[Notify] user=%s event=%s to=%s", user_id, event, to_email or "unknown")

    if not to_email:
        logger.info("[Notify] No email address available — logged only")
        return

    # Attempt real delivery
    sent = await _send_email(to_email, subject, plain, html)

    if sent:
        logger.info("[Notify] Email delivered: %s → %s", event, to_email)
    else:
        # Safe fallback — log the plain text so dev sees the content
        logger.info(
            "[Notify] Fallback (no SMTP or delivery failed) — would have sent:\n"
            "  To: %s\n  Subject: %s\n  Body: %s",
            to_email, subject, plain.strip()[:200],
        )
