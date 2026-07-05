# StudyMind AI 🎓

An adaptive, AI-powered student learning platform integrating ML-based weakness detection, personalised timetables, NLP note segmentation, MCQ generation, and Q-learning timetable adaptation.

---

## Architecture

```
Frontend (React + TypeScript + Vite + Tailwind CSS)
        ↕  REST + httpOnly cookies
Backend (FastAPI + Motor)
   ├── ML Layer  (RandomForest + LinearRegression, loaded at startup)
   ├── NLP Layer (regex segmentation)
   ├── RL Engine (tabular Q-learning + day-swap reallocation)
   ├── Groq API  (MCQ generation, AI Assistant chat, glossary extraction)
   └── MongoDB   (Motor async driver)
        ├── users, notes, note_sections, sessions, rate_limits
        ├── timetables, mcqs
        ├── progress, q_table
```

---

## Quick Start

### 1. Generate ML model files

Place your CSV datasets in the root directory:
- `merged_student_dataset.csv`
- `study_time_regression_dataset.csv`

Then run:
```bash
python save_models.py
```

This exports `clf.pkl`, `reg.pkl`, `le_subject.pkl`, `le_topic.pkl`, `le_subject2.pkl` into `backend/ml_models/`.

---

### 2. Local Development (the working path today)

There is currently **no `docker-compose.yml`** in this repo (only a `backend/Dockerfile` exists, no frontend Dockerfile) — local dev via uvicorn + Vite, below, is the actual supported path.

#### Backend

```bash
cd backend

# Create virtual environment
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate

# Install dependencies (add requirements-dev.txt too if running tests)
pip install -r requirements.txt
pip install -r requirements-dev.txt   # optional, for pytest

# Copy and configure env
cp .env.example .env
# Edit .env — at minimum set GROQ_API_KEY for MCQ/chat/glossary generation

# Start FastAPI
uvicorn main:app --reload --port 8000
```

#### Frontend

```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:5173 — dev server proxies /auth, /notes, /predict,
# /timetable, /mcq, /progress, /onboarding, /settings, /health to :8000
```

#### Running tests

```bash
cd backend
pytest
```

Covers the pure, DB-independent logic (RL reward shaping, mastery decay
weighting, RL day-swap pairing) — see `backend/tests/README.md` for what's
covered and what still needs a dedicated test database before it can be
automated.

---

## Project Structure

```
studymind/
├── save_models.py              ← Run once to export .pkl files
├── frontend/
│   ├── src/
│   │   ├── App.tsx             ← Router shell — dispatches to page components below
│   │   ├── main.tsx
│   │   ├── pages/               ← One component per route
│   │   │   ├── DashboardPage.tsx, AnalysisPage.tsx, TimetablePage.tsx
│   │   │   ├── StudyModal.tsx, AIAssistantPage.tsx, ReportPage.tsx
│   │   │   ├── OnboardingPage.tsx, SettingsPage.tsx, UploadPage.tsx
│   │   │   └── AuthPages.tsx
│   │   ├── components/          ← UI.tsx (shared components), ErrorBoundary.tsx
│   │   ├── lib/                 ← api.ts (typed fetch wrapper + auth refresh),
│   │   │                          contexts.tsx, useTheme.ts
│   │   └── types.ts             ← Hand-maintained mirror of backend Pydantic schemas
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── package.json
└── backend/
    ├── main.py                 ← FastAPI entry + lifespan (model loading, schedulers)
    ├── requirements.txt
    ├── requirements-dev.txt    ← pytest, for `backend/tests/`
    ├── Dockerfile
    ├── .env.example
    ├── ml_models/              ← Place .pkl files here
    │   ├── clf.pkl, reg.pkl, le_subject.pkl, le_topic.pkl, le_subject2.pkl
    └── app/
        ├── core/
        │   ├── config.py       ← Pydantic settings (reads .env)
        │   ├── database.py     ← Motor async MongoDB connection
        │   ├── models.py       ← ML model registry (loaded once)
        │   ├── security.py     ← JWT creation/verification, password hashing
        │   └── validators.py   ← Shared password-complexity validator
        ├── routers/
        │   ├── auth.py         ← /auth — signup, login, refresh, logout, me
        │   ├── twofa.py         ← /auth/2fa — TOTP enrollment, verify-login
        │   ├── sessions.py      ← /settings/sessions — device session list/revoke
        │   ├── notes.py        ← /notes — upload, segment, sections, glossary
        │   ├── predict.py      ← /predict — ML inference + schedule builder
        │   ├── timetable.py    ← /timetable — generate, get, list, adapt (RL)
        │   ├── mcq.py          ← /mcq — generate via Groq, get, clear cache
        │   ├── progress.py     ← /progress — submit, report, mastery, history
        │   ├── onboarding.py   ← /onboarding — per-user schedule constraints
        │   ├── settings.py     ← /settings — profile, password, notifications,
        │   │                      theme, export, delete account, streak, email
        │   └── chat.py         ← /chat — AI Assistant (Groq)
        ├── services/
        │   ├── rl_engine.py           ← Tabular Q-learning (hour allocation)
        │   ├── mastery.py             ← Decay-weighted mastery calculation
        │   ├── subject_performance.py ← Per-user predict bias (progress→notes join)
        │   ├── streaks.py             ← Study-streak calculation + nudge job
        │   ├── lifecycle.py           ← Note-archiving scheduled job
        │   ├── notifications.py       ← Templated email events
        │   └── rate_limit.py          ← Mongo-backed sliding-window rate limiter
        ├── tests/               ← pytest suite (pure functions only — see its README)
        └── schemas.py           ← All Pydantic request/response models
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|--------------|
| POST | `/auth/signup` | Register new user |
| POST | `/auth/login` | Login, set cookies (rate-limited per account) |
| POST | `/auth/refresh` | Refresh access token |
| POST | `/auth/logout` | Clear cookies |
| GET | `/auth/me` | Current user info |
| POST | `/auth/2fa/enroll` | Start TOTP enrollment |
| POST | `/auth/2fa/enable` | Confirm enrollment with a TOTP code |
| DELETE | `/auth/2fa/disable` | Disable 2FA (requires a valid TOTP code) |
| POST | `/auth/2fa/verify-login` | Second login step when 2FA is enabled |
| POST | `/notes/upload` | Upload PDF/DOCX/TXT, auto-segmented |
| POST | `/notes/{id}/segment` | Re-segment an existing note |
| GET | `/notes/{id}/sections` | List sections |
| GET | `/notes/` | List all notes |
| GET/POST | `/notes/{id}/glossary` | Fetch/generate a Groq-extracted glossary |
| POST | `/predict/` | ML weakness + hours prediction (per-user biased) |
| GET | `/predict/subjects` | Known subjects/topics (ML training vocabulary) |
| POST | `/timetable/generate` | Generate weekly timetable |
| GET | `/timetable/` | List timetables |
| GET | `/timetable/{id}` | Get timetable |
| POST | `/timetable/{id}/adapt` | RL-driven adaptation (`?swap_breadth=N`, default 1) |
| POST | `/mcq/generate` | Generate MCQs via Groq (difficulty adapts to mastery) |
| GET | `/mcq/{section_id}` | Get cached MCQs for a section |
| DELETE | `/mcq/{section_id}/cache` | Clear cached MCQs |
| POST | `/progress/submit` | Submit quiz result + RL update |
| GET | `/progress/report/{timetable_id}` | Weekly progress report |
| GET | `/progress/section/{section_id}` | Section score history |
| GET | `/progress/mastery/{timetable_id}` | Solid/shaky/revise/untouched + due-for-review |
| GET/PUT | `/onboarding/schedule` | Per-user schedule constraints + behavior-derived suggestions |
| GET/PATCH | `/settings` | Read/update profile |
| POST/DELETE | `/settings/avatar` | Upload/remove profile picture |
| POST | `/settings/password` | Change password (rate-limited) |
| GET/PUT | `/settings/notifications` | Notification preferences |
| POST | `/settings/theme/{theme}` | Persist light/dark theme |
| GET/PUT | `/settings/study-prefs` | Session length, break ratio, MCQ count/difficulty |
| GET | `/settings/export` | Download all of your own data as JSON |
| DELETE | `/settings/account` | Cascade-delete all your data |
| GET | `/settings/streak` | Current/longest study streak |
| POST | `/settings/email` | Change email (notifies the old address) |
| GET | `/settings/activity` | Last 20 security-relevant events |
| GET/PUT | `/settings/display-prefs` | Timetable display preferences |
| GET/DELETE | `/settings/sessions` | List sessions / revoke all but current |
| DELETE | `/settings/sessions/{id}` | Revoke one specific session |
| POST | `/chat` | AI Assistant (Groq), personalised with weak-topic context |
| GET | `/health` | Health check + model status |

Full interactive docs: http://localhost:8000/docs

---

## ML Models

### Weakness Classifier (Random Forest)
- **Input**: Subject, Topic, Exam Score, Study Time
- **Output**: `is_weak` (bool) + confidence probability
- **File**: `clf.pkl`

### Study Time Predictor (Linear Regression)
- **Input**: Subject, Exam Score, Weakness Score, Topic Difficulty
- **Output**: Recommended weekly study hours, then nudged ±20% by this user's
  own quiz history in that subject (`services/subject_performance.py`) once
  they have 3+ attempts
- **File**: `reg.pkl`
- Subjects/topics outside the model's fixed training vocabulary still get a
  prediction (via a documented fallback), flagged in the response as
  `is_known_subject`/`is_known_topic: false` rather than silently guessing

### Schedule Builder
- Splits recommended hours across 5 or 6 study days
- Adds 10-minute break per 45-minute session
- Weak students / hard topics → 5 study days (1 extra rest)

---

## RL Engine

Tabular Q-learning, banded by score (`low` <60%, `mid` 60–79%, `high` ≥80%),
with epsilon-greedy action selection (10% exploration) rather than a fixed
score→action mapping:

| Score Band | Reward | Notes |
|-----------|--------|-------|
| ≥ 80% | +1 (or 0 if the answer was slow — see below) | |
| 60–79% | 0 | |
| < 60% | −1 | |

A correct-but-slow answer (≥85% of the allotted time used, only tracked when
the quiz timer is on) caps the reward at 0 instead of +1, so hours aren't cut
on content the student is still visibly working hard on.

After each quiz submission:
1. Q-table updated (α=0.1, γ=0.9) for that section's hour-allocation action
2. `POST /timetable/{id}/adapt` applies the learned hour adjustments, then
   swaps sections between the worst/best-scoring day(s) — one pair by
   default, `?swap_breadth=N` for more
3. Version number incremented

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|--------------|
| `MONGODB_URL` | `mongodb://localhost:27017` | MongoDB connection string |
| `DATABASE_NAME` | `studymind` | Database name |
| `SECRET_KEY` | `change_me` | JWT signing secret |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `30` | Access token TTL |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `7` | Refresh token TTL |
| `GROQ_API_KEY` | `` | MCQ generation, AI Assistant chat, glossary extraction |
| `ANTHROPIC_API_KEY` | `` | Legacy field, not used by any current feature |
| `MODEL_DIR` | `ml_models` | Path to .pkl files |
| `ALLOWED_ORIGINS` | `[localhost:5173]` | CORS origins |
| `SMTP_HOST` | `` | Leave blank for log-only email (safe for dev) |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS |
| Backend | FastAPI + Uvicorn |
| Database | MongoDB + Motor (async) |
| Auth | JWT (httpOnly cookies) + optional TOTP 2FA |
| ML | scikit-learn (RandomForest + LinearRegression) |
| NLP | Regex-based note segmentation |
| RL | Custom tabular Q-learning + day-swap reallocation |
| MCQ / Chat / Glossary | Groq API (Llama models) |
| File parsing | PyMuPDF + python-docx |
| Testing | pytest (pure-function coverage — see `backend/tests/README.md`) |
