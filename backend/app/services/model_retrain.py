"""
Periodic ML model retraining -- closes the feedback loop the RL engine
(rl_engine.py) and per-user subject bias (subject_performance.py) already
have, but the static sklearn weakness classifier never did (see
ADAPTIVE_SYSTEM_SUGGESTIONS.md item 4.1).

Scope, deliberately narrow:

- Retrains ONLY the weakness classifier (clf.pkl + its two label encoders,
  le_subject.pkl/le_topic.pkl). Real (Subject, Topic, Exam_Score, Study_Time)
  -> Weakness_Label examples are derived from actual quiz history
  (progress_col() joined through note_sections/notes -- see
  _collect_real_examples()), appended to the original CSV training set, and
  the classifier + encoders are refit from scratch. RandomForest has no
  incremental partial_fit, so a full periodic refit -- not an online update
  -- is the correct pattern here, mirroring how save_models.py already
  trains it once.

  A useful side effect: refitting the label encoders on CSV + real data
  expands the known-subject/topic vocabulary with real users' subjects over
  time, directly improving is_known_subject/is_known_topic accuracy for
  users whose subjects the original synthetic CSV never saw. Note this is
  asymmetric with the regression model below: predict.py's combined
  is_known_subject flag is `subj_known and subj2_known`, and subj2_known
  comes from le_subject2 (the regression model's own separate encoder, not
  retrained here) -- so a newly-learned subject can make the classifier's
  half of that check pass while the flag as a whole still reads False until
  reg.pkl is addressed too.

- Deliberately does NOT retrain the study-time regressor (reg.pkl). There is
  no real "actual hours needed to reach mastery" ground truth captured
  anywhere in this schema -- the closest field, hours_allocated, is itself
  an output of this same recommendation pipeline (further nudged by the RL
  engine and by subject_performance.py's bias), so using it as a regression
  TARGET would train the model to reproduce its own prior bias rather than
  learn from independent signal -- a data-leakage feedback loop, not a real
  improvement. Retraining reg.pkl needs a genuine "time spent studying" or
  "attempts needed to reach 80%" tracking feature that does not exist yet;
  flagged as separate future work rather than faked here.

Safety: the new classifier is only swapped in if its held-out accuracy is
not meaningfully worse than the currently-loaded model's (evaluated on the
SAME held-out split, run through both models); otherwise the retrain is
rejected and logged, so a small/noisy batch of new real-world labels can't
silently regress predictions for every user.
"""
from __future__ import annotations

import logging
from pathlib import Path

import joblib
import pandas as pd
from fastapi.concurrency import run_in_threadpool
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score

logger = logging.getLogger(__name__)

# Mirrors subject_performance.MIN_ATTEMPTS_FOR_BIAS -- same "is this enough
# evidence to trust" bar used elsewhere for per-user signal.
MIN_ATTEMPTS_FOR_LABEL = 3
# Mirrors rl_engine._score_band's low/mid boundary -- reuse the threshold
# already established elsewhere for "weak" rather than inventing a new one.
WEAK_THRESHOLD_PCT = 60.0
# Below this many real examples, a retrain would be fitting noise, not signal.
MIN_REAL_EXAMPLES_TO_RETRAIN = 20
# Allow up to this much accuracy drop (vs the currently-loaded model, on the
# same held-out split) before rejecting the retrain outright.
ACCURACY_REGRESSION_TOLERANCE = 0.03

# Repo-root-relative, independent of the backend process's CWD (unlike
# settings.model_dir, which intentionally stays CWD-relative to match how
# save_models.py and load_models() already work).
_CSV_PATH = Path(__file__).resolve().parents[3] / "merged_student_dataset.csv"


async def _collect_real_examples() -> pd.DataFrame:
    """
    Derive (Subject, Topic, Exam_Score, Study_Time, Weakness_Label) rows from
    real quiz history across ALL users -- one row per section with enough
    attempts to trust its mastery classification.

    Exam_Score proxy: the student's FIRST quiz attempt on this section (the
    closest real analogue to a diagnostic, pre-intervention exam score).
    Study_Time proxy: hours_allocated for that section's timetable slot (the
    actual scheduled study time) -- used as an input FEATURE here, which is
    fine; it's only unsafe to use as the regression TARGET (see module
    docstring).
    Weakness_Label: 1 if the section's current weighted mastery is below
    WEAK_THRESHOLD_PCT, else 0 -- a real, observed outcome rather than a
    synthetic label.
    """
    from app.core.database import notes_col, note_sections_col, progress_col, timetables_col
    from app.services.mastery import weighted_mastery_pct

    sections = await note_sections_col().find({}, {"_id": 1, "note_id": 1}).to_list(20000)
    note_ids = list({s["note_id"] for s in sections})
    notes = await notes_col().find(
        {"_id": {"$in": note_ids}}, {"_id": 1, "subject": 1, "topic": 1}
    ).to_list(20000)
    note_meta = {n["_id"]: n for n in notes}

    # hours_allocated per section, from whichever timetable slot references
    # it most recently seen in this scan -- a rough proxy, not ground truth.
    hours_by_section: dict[str, float] = {}
    async for tt in timetables_col().find({}, {"days": 1}):
        for day_slots in tt.get("days", {}).values():
            for slot in day_slots:
                hours_by_section[slot["section_id"]] = slot["hours_allocated"]

    rows = []
    for sec in sections:
        note = note_meta.get(sec["note_id"])
        if not note or not note.get("subject") or not note.get("topic"):
            continue

        progs = await progress_col().find(
            {"section_id": sec["_id"]}, {"score_pct": 1, "date": 1}
        ).sort("date", 1).to_list(50)
        if len(progs) < MIN_ATTEMPTS_FOR_LABEL:
            continue

        mastery_pct = weighted_mastery_pct(progs[-5:])
        rows.append({
            "Subject": note["subject"].strip(),
            "Topic": note["topic"].strip(),
            "Exam_Score": progs[0]["score_pct"],
            "Study_Time": hours_by_section.get(sec["_id"], 5.0),
            "Weakness_Label": int(mastery_pct < WEAK_THRESHOLD_PCT),
        })

    return pd.DataFrame(rows, columns=["Subject", "Topic", "Exam_Score", "Study_Time", "Weakness_Label"])


def _should_accept(new_accuracy: float, old_accuracy: float | None) -> bool:
    """
    Pure accuracy-guard decision, isolated from the sklearn fit/eval work so
    it's directly unit-testable without needing to engineer a real dataset
    that reliably produces a worse-fitting model (sklearn accuracy on
    synthetic data is noisy enough to make that flaky).
    """
    if old_accuracy is None:
        return True
    return new_accuracy >= old_accuracy - ACCURACY_REGRESSION_TOLERANCE


def _fit_and_compare(combined_df: pd.DataFrame, model_dir: str) -> dict:
    """
    Synchronous sklearn work (fit + accuracy-guard + optional swap-in) --
    isolated from the DB-touching collection step above so it can be run in
    a threadpool (mirrors predict.py's run_in_threadpool treatment of
    sklearn's blocking predict() calls) and unit-tested with a synthetic
    DataFrame + a scratch model_dir with no DB or real ml_models/ files
    involved.
    """
    base = Path(model_dir)

    le_subject = LabelEncoder().fit(combined_df["Subject"])
    le_topic   = LabelEncoder().fit(combined_df["Topic"])
    combined_df = combined_df.copy()
    combined_df["Subject_Enc"] = le_subject.transform(combined_df["Subject"])
    combined_df["Topic_Enc"]   = le_topic.transform(combined_df["Topic"])

    X = combined_df[["Subject_Enc", "Topic_Enc", "Exam_Score", "Study_Time"]]
    y = combined_df["Weakness_Label"]
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42,
        stratify=y if y.nunique() > 1 else None,
    )

    new_clf = RandomForestClassifier(n_estimators=100, random_state=42)
    new_clf.fit(X_train, y_train)
    new_accuracy = accuracy_score(y_test, new_clf.predict(X_test))

    # Re-evaluate the currently-loaded model on the SAME held-out split, for
    # a fair before/after comparison, before deciding whether to swap in.
    old_accuracy = None
    old_clf_path = base / "clf.pkl"
    if old_clf_path.exists():
        try:
            old_clf = joblib.load(old_clf_path)
            old_le_subject = joblib.load(base / "le_subject.pkl")
            old_le_topic = joblib.load(base / "le_topic.pkl")

            def _old_encode(le, series):
                known = set(le.classes_)
                # Unseen labels -> -1: the old model will simply get these
                # wrong, which is the correct, honest comparison (that's
                # exactly the vocabulary gap this retrain is meant to close).
                return series.map(lambda v: int(le.transform([v])[0]) if v in known else -1)

            test_df = combined_df.loc[X_test.index]
            old_X_test = pd.DataFrame({
                "Subject_Enc": _old_encode(old_le_subject, test_df["Subject"]),
                "Topic_Enc":   _old_encode(old_le_topic, test_df["Topic"]),
                "Exam_Score":  test_df["Exam_Score"],
                "Study_Time":  test_df["Study_Time"],
            })
            old_accuracy = accuracy_score(y_test, old_clf.predict(old_X_test))
        except Exception:
            logger.warning("[Retrain] Could not evaluate existing model for comparison", exc_info=True)

    if not _should_accept(new_accuracy, old_accuracy):
        return {
            "status": "rejected", "reason": "accuracy_regression",
            "old_accuracy": round(old_accuracy, 3), "new_accuracy": round(new_accuracy, 3),
            "total_examples": len(combined_df),
        }

    base.mkdir(parents=True, exist_ok=True)
    joblib.dump(new_clf,    base / "clf.pkl")
    joblib.dump(le_subject, base / "le_subject.pkl")
    joblib.dump(le_topic,   base / "le_topic.pkl")

    return {
        "status": "retrained",
        "total_examples": len(combined_df),
        "new_accuracy": round(new_accuracy, 3),
        "old_accuracy": round(old_accuracy, 3) if old_accuracy is not None else None,
        "known_subjects": len(le_subject.classes_),
        "known_topics": len(le_topic.classes_),
    }


async def retrain_classifier(model_dir: str = "ml_models") -> dict:
    """
    Periodic classifier retrain job -- registered on the same leader-only
    APScheduler used for the lifecycle/streak jobs (see main.py). Returns a
    summary dict for logging (not exposed via API).
    """
    real_df = await _collect_real_examples()
    n_real = len(real_df)

    if n_real < MIN_REAL_EXAMPLES_TO_RETRAIN:
        summary = {"status": "skipped", "reason": "not_enough_real_data", "real_examples": n_real}
        logger.info("[Retrain] %s", summary)
        return summary

    if _CSV_PATH.exists():
        original_df = pd.read_csv(_CSV_PATH)[
            ["Subject", "Topic", "Exam_Score", "Study_Time", "Weakness_Label"]
        ].dropna()
        combined_df = pd.concat([original_df, real_df], ignore_index=True)
    else:
        combined_df = real_df

    result = await run_in_threadpool(_fit_and_compare, combined_df, model_dir)
    result["real_examples"] = n_real

    if result["status"] == "retrained":
        from app.core.models import load_models
        load_models(model_dir)   # hot-reload the registry -- no restart needed

    logger.info("[Retrain] %s", result)
    return result
