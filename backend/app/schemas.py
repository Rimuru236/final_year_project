from __future__ import annotations
from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import Optional, Any
from datetime import datetime

from app.core.validators import validate_password_complexity


# ── Auth ─────────────────────────────────────────────────────
class SignupRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    email: EmailStr
    # D1-1: Password policy upgraded to 8–12 chars + complexity requirements.
    # Validator is in app/core/validators.py so Day 6 change-password reuses it.
    password: str = Field(..., min_length=8, max_length=12)
    level: str  # "High School" | "Undergraduate" | "Postgraduate"

    @field_validator("password")
    @classmethod
    def password_complexity(cls, v: str) -> str:
        return validate_password_complexity(v)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str  # No complexity check — existing hashes must still authenticate


class AuthResponse(BaseModel):
    user_id: str
    name: str
    email: str
    level: str
    avatar_b64: Optional[str] = None
    message: str


# ── Notes ────────────────────────────────────────────────────
class NoteSection(BaseModel):
    section_id: str
    note_id: str
    title: str
    content: str
    word_count: int
    estimated_read_time: float
    section_index: int


class NoteResponse(BaseModel):
    note_id: str
    filename: str
    subject: str
    topic: str
    raw_text: str       # included only on upload response; use NoteListItem for list endpoints
    created_at: datetime


class NoteListItem(BaseModel):
    """
    Audit C6: Lean schema for list endpoints — excludes raw_text which can be
    hundreds of kilobytes per note.  Only note_id, metadata, and section_count
    are returned when listing notes.  Full raw_text is still returned by the
    upload endpoint (NoteResponse) for immediate use after upload.

    D8: added content_archived and archived_at so the frontend can show an
    'Archived' badge on notes whose bulk text has been cleared by the lifecycle job.
    """
    note_id: str
    filename: str
    subject: str
    topic: str
    created_at: datetime
    content_archived: bool = False
    archived_at: Optional[datetime] = None


class SegmentResponse(BaseModel):
    note_id: str
    sections: list[NoteSection]
    total_sections: int


# ── Prediction ───────────────────────────────────────────────
class PredictRequest(BaseModel):
    subject: str
    topic: str
    exam_score: float = Field(..., ge=0, le=100)
    study_time: float = Field(..., ge=0)
    weakness_score: float = Field(0.5, ge=0.0, le=1.0)
    topic_difficulty: int = Field(2, ge=1, le=3)


class DaySchedule(BaseModel):
    study: float
    breaks: float
    total: float


class PredictResponse(BaseModel):
    subject: str
    topic: str
    exam_score: float
    is_weak: bool
    confidence: float
    recommended_hours: float
    study_days: int
    daily_schedule: dict[str, DaySchedule]
    known_subjects: list[str]
    # Set when recommended_hours was nudged using this user's own quiz history
    # for this subject (services/subject_performance.py). False means the raw
    # regressor output was used unchanged (no bias data available yet).
    bias_applied: bool = False
    # Set when subject/topic were NOT in the ML model's fixed training
    # vocabulary — the base prediction is a rough estimate in that case
    # (services/predict.py's safe_encode() falls back to a heuristic class).
    is_known_subject: bool = True
    is_known_topic: bool = True


# ── Timetable ────────────────────────────────────────────────
class TimetableSlot(BaseModel):
    section_id: str
    section_title: str
    section_content: str | None = None
    hours_allocated: float
    start_time: str
    end_time: str
    break_minutes: int
    # D3: set when a slot was relocated to a different day by the RL swap step.
    # None means the slot stayed in its original day this version.
    moved_from: str | None = None


class TimetableGenerateRequest(BaseModel):
    note_id: str
    recommended_hours: float
    study_days: int
    is_weak: bool
    topic_difficulty: int


class TimetableResponse(BaseModel):
    timetable_id: str
    note_id: str
    week_start: str
    version: int
    days: dict[str, list[TimetableSlot]]


# ── MCQ ──────────────────────────────────────────────────────
class MCQOption(BaseModel):
    A: str
    B: str
    C: str
    D: str


class MCQ(BaseModel):
    mcq_id: str
    section_id: str
    question: str
    options: MCQOption
    correct_answer: str
    explanation: str


class MCQGenerateRequest(BaseModel):
    section_id: str
    # Audit M3: default unified to 5 — frontend always requests 5, backend
    # defaulted to 20, causing non-deterministic quiz length when cached MCQs
    # from a previous 20-question session were served to a 5-question request.
    num_questions: int = 5


# ── Progress ─────────────────────────────────────────────────
class ProgressSubmit(BaseModel):
    section_id: str
    timetable_id: str
    score_pct: float = Field(..., ge=0, le=100)
    questions_attempted: int
    correct_answers: int
    # Average fraction (0-100) of the allotted per-question time actually used,
    # only sent when the quiz timer was enabled (Smart Drill timed mode).
    # None means no timing data — the RL reward falls back to score-only.
    avg_response_time_pct: Optional[float] = Field(None, ge=0, le=100)


class SectionProgress(BaseModel):
    section_id: str
    section_title: str
    current_score: float
    previous_score: Optional[float]
    improvement: float
    attempt_number: int
    hours_allocated: float


class DayProgress(BaseModel):
    """Per-day aggregated progress — added in D2-1."""
    day_name: str
    average_score: float
    section_count: int
    attempted_count: int


class WeeklyReport(BaseModel):
    user_id: str
    week_label: str
    sections: list[SectionProgress]
    overall_score: float
    overall_improvement: float
    total_attempts: int
    reassignment_log: list[str]
    # D2-1: Per-day breakdown — additive, existing callers are unaffected.
    daily_breakdown: dict[str, DayProgress] = {}


# ── Mastery Classification (Feature 1) ─────────────────────────────────────
class SectionMastery(BaseModel):
    section_id: str
    section_title: str
    mastery_pct: Optional[float] = None
    classification: str
    attempt_count: int
    hours_allocated: float


class MasteryReport(BaseModel):
    timetable_id: str
    solid: list[SectionMastery]
    shaky: list[SectionMastery]
    revise: list[SectionMastery]
    untouched: list[SectionMastery]
    total_sections: int
    overall_mastery_pct: Optional[float] = None
    # NEW — maps day name -> list of section_ids scheduled on that day.
    # Lets the frontend filter the four classification lists above by day
    # without an additional API call.
    sections_by_day: dict[str, list[str]] = {}
    # Solid sections not attempted in a while — a lightweight, opt-in "due for
    # review" nudge (subset of `solid`, not a fifth exclusive bucket).
    due_for_review: list[SectionMastery] = []


# ── Glossary (Feature 3) ───────────────────────────────────────────────────
class GlossaryTerm(BaseModel):
    term: str
    definition: str


class GlossaryResponse(BaseModel):
    note_id: str
    filename: str
    terms: list[GlossaryTerm]
    generated: bool
