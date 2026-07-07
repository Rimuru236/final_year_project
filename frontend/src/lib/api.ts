/// <reference types="vite/client" />
// ── API Client ────────────────────────────────────────────────────────────────
// Production-grade API utility with:
//   - Silent JWT refresh (401 → POST /auth/refresh → replay)
//   - Structured error extraction from FastAPI detail field
//   - AbortController support via opts.signal
//
// FIX: VITE_API_URL is left blank when using the Vite dev proxy (vite.config.ts).
//      The proxy rewrites /auth/* → http://localhost:8000/auth/* etc.
//      In production set VITE_API_URL=https://api.yourdomain.com

const API: string = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) || "";

export { API };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {};

  // Don't set Content-Type for FormData — browser must set multipart boundary
  if (!(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  Object.assign(headers, opts.headers ?? {});

  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    ...opts,
    headers,
  });

  // Silent token refresh: if access token expired (401), attempt refresh once
  // then replay the original request. Excludes auth endpoints to prevent loops.
  if (
    res.status === 401 &&
    path !== "/auth/refresh" &&
    path !== "/auth/login" &&
    path !== "/auth/me"
  ) {
    try {
      const refreshRes = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (refreshRes.ok) {
        const retry = await fetch(`${API}${path}`, {
          credentials: "include",
          ...opts,
          headers,
        });
        if (retry.ok) return retry.json();
      }
    } catch {
      // Refresh failed — fall through to throw the 401 below
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const msg =
      typeof err.detail === "string"
        ? err.detail
        : Array.isArray(err.detail)
        ? err.detail.map((d: any) => d.msg ?? String(d)).join("; ")
        : "Request failed";
    throw new ApiError(msg, res.status);
  }

  // 204 No Content → return null
  if (res.status === 204) return null;
  return res.json();
}

// ── Typed API helpers ─────────────────────────────────────────────────────────

export const authApi = {
  login: async (email: string, password: string) => {
    // D7: login may return 202 when 2FA is required — handle before the
    // normal api() helper which throws on non-2xx.
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (res.status === 202 && data.requires_2fa) return data;  // 2FA challenge
    if (!res.ok) throw new Error(data.detail ?? "Login failed");
    return data;
  },

  signup: (name: string, email: string, password: string, level: string) =>
    api("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name, email, password, level }),
    }),

  me: () => api("/auth/me"),

  logout: () => api("/auth/logout", { method: "POST" }),
};

export const notesApi = {
  // FIX: backend GET /notes/ returns NoteListItem[] (no raw_text) — correct
  list: () => api("/notes/"),

  // FIX: upload must NOT set Content-Type header — FormData needs browser-set boundary
  upload: (file: File, subject: string, topic: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("subject", subject);
    fd.append("topic", topic);
    return api("/notes/upload", {
      method: "POST",
      body: fd,
    });
  },

  // FIX: backend path is POST /notes/{note_id}/segment — correct
  segment: (noteId: string) =>
    api(`/notes/${noteId}/segment`, { method: "POST" }),

  // FIX: ADDED — missing from original frontend; needed by TimetablePage
  getSections: (noteId: string) => api(`/notes/${noteId}/sections`),

  // Feature 3: Glossary endpoints
  getGlossary: (noteId: string) => api(`/notes/${noteId}/glossary`),
  generateGlossary: (noteId: string) => api(`/notes/${noteId}/glossary`, { method: "POST" }),
};

export const predictApi = {
  run: (form: {
    subject: string;
    topic: string;
    exam_score: number;
    study_time: number;
    weakness_score: number;
    topic_difficulty: number;
  }) => api("/predict/", { method: "POST", body: JSON.stringify(form) }),

  // FIX: ADDED — backend exposes GET /predict/subjects for subject/topic dropdowns
  subjects: () => api("/predict/subjects"),
};

export const timetableApi = {
  list: () => api("/timetable/"),

  // FIX: correct path — backend is GET /timetable/{id}, not /timetable/:id
  get: (id: string) => api(`/timetable/${id}`),

  generate: (payload: {
    note_id: string;
    recommended_hours: number;
    study_days: number;
    is_weak: boolean;
    topic_difficulty: number;
  }) =>
    api("/timetable/generate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // swapBreadth: number of worst/best day pairs to swap in one Adapt call.
  // Default 1 matches today's behavior exactly (no query string sent).
  adapt: (id: string, swapBreadth: number = 1) =>
    api(`/timetable/${id}/adapt${swapBreadth > 1 ? `?swap_breadth=${swapBreadth}` : ""}`, { method: "POST" }),

  setGoal: (id: string, payload: { target_mastery_pct: number; deadline: string }) =>
    api(`/timetable/${id}/goal`, { method: "PUT", body: JSON.stringify(payload) }),

  clearGoal: (id: string) =>
    api(`/timetable/${id}/goal`, { method: "DELETE" }),
};

export const mcqApi = {
  // FIX: backend is GET /mcq/{section_id} — correct
  getBySectionId: (sectionId: string) => api(`/mcq/${sectionId}`),

  // FIX: backend is POST /mcq/generate — correct
  generate: (sectionId: string, numQuestions = 5) =>
    api("/mcq/generate", {
      method: "POST",
      body: JSON.stringify({ section_id: sectionId, num_questions: numQuestions }),
    }),
};

export const progressApi = {
  // FIX: backend ProgressSubmit uses score_pct, questions_attempted, correct_answers — correct
  submit: (payload: {
    section_id: string;
    timetable_id: string;
    score_pct: number;
    questions_attempted: number;
    correct_answers: number;
    avg_response_time_pct?: number;
    avg_confidence_pct?: number;
  }) =>
    api("/progress/submit", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // FIX: backend path is GET /progress/report/{timetable_id} — correct
  report: (timetableId: string) =>
    api(`/progress/report/${timetableId}`),

  // Feature 1: Mastery classification endpoint
  mastery: (timetableId: string) =>
    api(`/progress/mastery/${timetableId}`),
};

export const onboardingApi = {
  getSchedule: () => api("/onboarding/schedule"),
  saveSchedule: (payload: {
    weekday_free_hours?: Record<string, number> | null;
    preferred_study_times?: string[] | null;
    blocked_days?: string[] | null;
    default_break_ratio?: number | null;
    preferred_session_length?: number | null;
  }) =>
    api("/onboarding/schedule", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
};

export const settingsApi = {
  get:      ()                            => api("/settings"),
  patch:    (body: object)                => api("/settings",           { method: "PATCH", body: JSON.stringify(body) }),
  setTheme: (theme: "light" | "dark")    => api(`/settings/theme/${theme}`, { method: "POST" }),
  changePassword: (body: { current_password: string; new_password: string }) =>
    api("/settings/password", { method: "POST", body: JSON.stringify(body) }),
  getNotifPrefs:  ()                      => api("/settings/notifications"),
  setNotifPrefs:  (events: string[])      => api("/settings/notifications", { method: "PUT",  body: JSON.stringify({ enabled_events: events }) }),
  getStudyPrefs:  ()                      => api("/settings/study-prefs"),
  setStudyPrefs:  (body: object)          => api("/settings/study-prefs",   { method: "PUT",  body: JSON.stringify(body) }),
  exportData:     ()                      => api("/settings/export"),
  deleteAccount:  ()                      => api("/settings/account",       { method: "DELETE" }),
  // Feature 1: Session Management
  getSessions:       ()                  => api("/settings/sessions"),
  revokeSession:     (id: string)        => api(`/settings/sessions/${id}`, { method: "DELETE" }),
  revokeOtherSessions: ()               => api("/settings/sessions", { method: "DELETE" }),
  // Feature 2: Study Streak
  getStreak: () => api("/settings/streak"),
  // Feature 3: Email Change
  changeEmail: (body: { new_email: string; current_password: string }) =>
    api("/settings/email", { method: "POST", body: JSON.stringify(body) }),
  // Feature 4: Activity Log
  getActivity: () => api("/settings/activity"),
  // Feature 6: Display Preferences
  getDisplayPrefs: ()           => api("/settings/display-prefs"),
  setDisplayPrefs: (body: object) => api("/settings/display-prefs", { method: "PUT", body: JSON.stringify(body) }),
  // Feature 9: Remove Avatar
  deleteAvatar: () => api("/settings/avatar", { method: "DELETE" }),
};

export const twofaApi = {
  enroll:      ()                                           => api("/auth/2fa/enroll",       { method: "POST" }),
  enable:      (totp_code: string)                         => api("/auth/2fa/enable",        { method: "POST", body: JSON.stringify({ totp_code }) }),
  disable:     (totp_code: string)                         => api("/auth/2fa/disable",       { method: "DELETE", body: JSON.stringify({ totp_code }) }),
  verifyLogin: (pending_token: string, totp_code: string)  => api("/auth/2fa/verify-login",  { method: "POST", body: JSON.stringify({ pending_token, totp_code }) }),
};
