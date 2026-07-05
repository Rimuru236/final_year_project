// ── Core Domain Types — mirrors backend Pydantic schemas exactly ─────────────

export interface User {
  user_id: string;
  name: string;
  email: string;
  level: string;
  avatar_b64?: string | null;
}

// NoteListItem — returned by GET /notes/ (no raw_text per backend C6 audit fix)
export interface Note {
  note_id: string;
  filename: string;
  subject: string;
  topic: string;
  created_at: string;
  // D8: lifecycle archive state
  content_archived: boolean;
  archived_at: string | null;
}

// NoteResponse — returned on POST /notes/upload (includes raw_text)
export interface NoteResponse extends Note {
  raw_text: string;
}

export interface Section {
  section_id: string;
  note_id: string;
  title: string;
  content: string;
  word_count: number;
  estimated_read_time: number;
  section_index: number;
}

export interface DaySchedule {
  study: number;
  breaks: number;
  total: number;
}

export interface PredictResult {
  subject: string;
  topic: string;
  exam_score: number;
  is_weak: boolean;
  confidence: number;
  recommended_hours: number;
  study_days: number;
  daily_schedule: Record<string, DaySchedule>;
  // FIX: backend PredictResponse includes known_subjects — was missing from frontend types
  known_subjects: string[];
  // Set when recommended_hours was nudged using this user's own quiz history for this subject
  bias_applied: boolean;
  // Set false when subject/topic weren't in the ML model's fixed training vocabulary
  is_known_subject: boolean;
  is_known_topic: boolean;
}

// TimetableSlot — section_content populated by timetable router on GET /:id
export interface TimetableSlot {
  section_id: string;
  section_title: string;
  section_content: string | null;
  hours_allocated: number;
  start_time: string;
  end_time: string;
  break_minutes: number;
  // D3: present when this slot was moved to a different day by the RL swap step.
  moved_from?: string | null;
}

export interface Timetable {
  timetable_id: string;
  note_id: string;
  week_start: string;
  version: number;
  days: Record<string, TimetableSlot[]>;
}

export interface MCQ {
  mcq_id: string;
  section_id: string;
  question: string;
  // FIX: backend returns MCQOption (object with A/B/C/D) not Record<string,string>
  options: { A: string; B: string; C: string; D: string };
  correct_answer: string;
  explanation: string;
}

// ── Study Session State ───────────────────────────────────────────────────────
export type StudyModalMode = "study" | "quiz-loading" | "quiz";

export interface StudySession {
  slot: TimetableSlot;
  timetableId: string; // FIX: was missing — needed for progress submit
  mode: StudyModalMode;
  mcqs: MCQ[];
  quizIdx: number;
  selected: string | null;
  revealed: boolean;
  score: { correct: number; total: number };
  // Per-question elapsed/allotted-time fractions, only recorded when the
  // quiz timer was enabled — used to compute avg_response_time_pct on submit.
  responseTimeFractions: number[];
}

// ── App Routing ───────────────────────────────────────────────────────────────
export type Page =
  | "login"
  | "signup"
  | "dashboard"
  | "upload"
  | "analysis"
  | "timetable"
  | "report"
  | "quiz"
  | "ai-assistant"
  | "schedule"
  | "settings";

// ── Toast ─────────────────────────────────────────────────────────────────────
export interface Toast {
  id: number;
  msg: string;
  type: "success" | "error" | "info";
}

// ── Progress Report ───────────────────────────────────────────────────────────
// FIX: frontend had ProgressReport matching frontend-invented shape.
// Backend returns WeeklyReport — mapped here correctly.
export interface ReportSection {
  section_id: string;
  section_title: string;
  current_score: number;
  previous_score: number | null;
  improvement: number;
  attempt_number: number;
  hours_allocated: number;
}

export interface ProgressReport {
  // FIX: backend WeeklyReport has user_id + week_label, not timetable_id
  timetable_id: string; // passed in by frontend for the API call
  user_id: string;
  week_label: string;
  overall_score: number;
  overall_improvement: number;
  total_attempts: number;
  sections: ReportSection[];
  reassignment_log: string[];
  // D2-1: Per-day breakdown — mirrors backend daily_breakdown field
  daily_breakdown: Record<string, DayProgress>;
}

// ── Per-Day Progress (D2-1) ───────────────────────────────────────────────────
// D2-1: Per-day aggregated progress — mirrors backend DayProgress schema
export interface DayProgress {
  day_name: string;
  average_score: number;
  section_count: number;
  attempted_count: number;
}

// ── Onboarding / Schedule Constraints (D4) ───────────────────────────────────
export const VALID_DAYS = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
] as const;
export type Weekday = (typeof VALID_DAYS)[number];

export const VALID_STUDY_TIMES = [
  "early_morning", "morning", "afternoon", "evening", "night",
] as const;
export type StudyTime = (typeof VALID_STUDY_TIMES)[number];

export interface ScheduleConstraints {
  weekday_free_hours: Record<Weekday, number> | null;
  preferred_study_times: StudyTime[] | null;
  blocked_days: Weekday[] | null;
  default_break_ratio: number | null;
  preferred_session_length: number | null;
  has_constraints: boolean;
  // Weekdays the user appears to never study on (derived from quiz history),
  // not yet in blocked_days — surfaced as a one-tap suggestion.
  suggested_blocked_days: Weekday[];
}

// ── Settings (D6) ─────────────────────────────────────────────────────────────
export interface SettingsData {
  user_id: string;
  name: string;
  email: string;
  level: string;
  theme: "light" | "dark";
  avatar_b64: string | null;
  notification_prefs: string[];
  two_factor_enabled: boolean;
  default_session_length: number | null;
  default_break_ratio: number | null;
  timezone: string;
  locale: string;
}

// ── Session Management (Feature 1) ─────────────────────────────────────────────
export interface SessionItem {
  session_id: string;
  user_agent: string;
  ip_address: string;
  created_at: string;
  last_seen: string;
  is_current: boolean;
}

// ── Study Streak (Feature 2) ─────────────────────────────────────────────────
export interface StreakData {
  current_streak: number;
  longest_streak: number;
  last_study_date: string | null;
  studied_today: boolean;
}

// ── Activity Log (Feature 4) ───────────────────────────────────────────────────
export interface ActivityEntry {
  event: string;
  detail: string;
  at: string;
}

// ── Display Preferences (Feature 6) ─────────────────────────────────────────────
export interface DisplayPrefs {
  week_start_day: "Monday" | "Sunday" | null;
  time_format: "12h" | "24h" | null;
  timetable_default_view: "current_day" | "full_week" | null;
}

// ── Study Preferences (Features 7 & 8) ─────────────────────────────────────────
export interface StudyPrefs {
  default_session_length: number | null;
  default_break_ratio: number | null;
  default_mcq_count: number | null;
  default_mcq_difficulty: string | null;
  archive_after_days: number | null;
}

// ── Mastery Classification (Feature 1) ───────────────────────────────────────
export interface SectionMastery {
  section_id: string;
  section_title: string;
  mastery_pct: number | null;
  classification: "solid" | "shaky" | "revise" | "untouched";
  attempt_count: number;
  hours_allocated: number;
}

export interface MasteryReport {
  timetable_id: string;
  solid: SectionMastery[];
  shaky: SectionMastery[];
  revise: SectionMastery[];
  untouched: SectionMastery[];
  total_sections: number;
  overall_mastery_pct: number | null;
  // NEW — maps day name to the section_ids scheduled on that day
  sections_by_day: Record<string, string[]>;
  // Solid sections not attempted in a while — subset of `solid`, not exclusive
  due_for_review: SectionMastery[];
}

// ── Glossary (Feature 3) ─────────────────────────────────────────────────────
export interface GlossaryTerm {
  term: string;
  definition: string;
}

export interface GlossaryResponse {
  note_id: string;
  filename: string;
  terms: GlossaryTerm[];
  generated: boolean;
}
