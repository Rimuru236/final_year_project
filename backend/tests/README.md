# Test suite scope

Run with `pytest` from `backend/` (needs `pip install -r requirements-dev.txt` first).

This suite currently covers **pure, DB-independent functions only** — the
highest-risk logic that was previously verified by hand, live, against the
real MongoDB instance each time it changed (RL reward shaping, mastery decay
weighting, RL day-pairing). These are fast, deterministic, and require no
fixtures.

**Not yet covered** (needs a disposable test-database fixture, not the shared
dev/local MongoDB instance): anything that reads/writes Mongo directly —
`adapt_timetable()`, `section_mastery()`, `run_lifecycle_job()`,
`check_rate_limit()`, `get_subject_aggregate_score()`, the auth/session
routers, etc. Introducing DB-backed tests against the same MongoDB instance
real users' data lives in would be its own footgun; that needs a dedicated
test database (e.g. a `studymind_test` DB name swapped in via `.env.test`)
before it's safe to automate — flagged as follow-up work, not silently
skipped.
