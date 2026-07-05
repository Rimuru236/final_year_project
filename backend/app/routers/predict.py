import logging

import pandas as pd
from fastapi import APIRouter, HTTPException, Depends
from fastapi.concurrency import run_in_threadpool

from ..core.models import get_clf, get_reg, get_le_subject, get_le_topic, get_le_subject2, get_known_subjects, get_known_topics, models_ready
from ..core.security import get_current_user
from ..schemas import PredictRequest, PredictResponse, DaySchedule
from ..services.subject_performance import get_subject_aggregate_score, apply_subject_bias

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/predict", tags=["predict"])


def build_daily_schedule(total_weekly_hours: float, is_weak: bool, topic_difficulty: int) -> tuple[dict, int]:
    study_days = 5 if (is_weak or topic_difficulty == 3) else 6
    raw_hours_per_day = total_weekly_hours / study_days
    sessions_per_day  = raw_hours_per_day / 0.75
    break_hours       = sessions_per_day * (10 / 60)
    total_per_day     = raw_hours_per_day + break_hours

    days = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
    schedule = {}
    for i, day in enumerate(days):
        if i < study_days:
            schedule[day] = DaySchedule(
                study=round(raw_hours_per_day, 2),
                breaks=round(break_hours, 2),
                total=round(total_per_day, 2),
            )
        else:
            schedule[day] = DaySchedule(study=0, breaks=0, total=0)
    return schedule, study_days


@router.post("/", response_model=PredictResponse)
async def predict(body: PredictRequest, current: dict = Depends(get_current_user)):
    if not models_ready():
        raise HTTPException(status_code=503, detail="ML models not loaded. Place .pkl files in ml_models/ and restart.")

    clf         = get_clf()
    reg         = get_reg()
    le_subject  = get_le_subject()
    le_topic    = get_le_topic()
    le_subject2 = get_le_subject2()

    # Safe encode — unseen labels fall back to a documented "central class"
    # heuristic rather than silently misattributing to index 0 (whatever's
    # alphabetically first in the encoder's fixed vocabulary). LabelEncoder
    # doesn't retain training-set frequency info, so there's no true "most
    # common" class recoverable from the saved .pkl — this is a placeholder
    # until a retrain adds a real "Other"/unknown class.
    def safe_encode(le, val, field_name: str = "") -> tuple[int, bool]:
        if val in le.classes_:
            return int(le.transform([val])[0]), True
        fallback_class = le.classes_[len(le.classes_) // 2]
        fallback_idx = int(le.transform([fallback_class])[0])
        logger.warning(
            "[Predict] Unseen %s value '%s' — falling back to nearest-known class '%s' (idx=%d)",
            field_name or "label", val, fallback_class, fallback_idx,
        )
        return fallback_idx, False

    subj_enc,  subj_known  = safe_encode(le_subject,  body.subject, "subject")
    topic_enc, topic_known = safe_encode(le_topic,    body.topic,   "topic")
    subj2_enc, subj2_known = safe_encode(le_subject2, body.subject, "subject2")

    is_known_subject = subj_known and subj2_known
    is_known_topic   = topic_known

    w_input = pd.DataFrame(
        [[subj_enc, topic_enc, body.exam_score, body.study_time]],
        columns=["Subject_Enc","Topic_Enc","Exam_Score","Study_Time"]
    )

    r_input = pd.DataFrame(
        [[subj2_enc, body.exam_score, body.weakness_score, body.topic_difficulty]],
        columns=["Subject_Enc","Exam_Score","Weakness_Score","Topic_Difficulty"]
    )

    # Audit (scalability): sklearn predict() is a synchronous CPU call that
    # blocks the entire asyncio event loop while executing.  Under concurrent
    # load this stalls all other in-flight requests.  run_in_threadpool()
    # offloads each call to FastAPI's default ThreadPoolExecutor so the event
    # loop remains free to handle other requests during model inference.
    is_weak    = bool((await run_in_threadpool(clf.predict, w_input))[0])
    confidence = float(max((await run_in_threadpool(clf.predict_proba, w_input))[0]))
    recommended_hours = float((await run_in_threadpool(reg.predict, r_input))[0])
    recommended_hours = max(1.0, round(recommended_hours, 1))

    # Nudge recommended_hours using this user's own quiz history for this
    # subject, when there's enough data to trust it (see subject_performance.py)
    aggregate_pct, _attempt_count = await get_subject_aggregate_score(current["user_id"], body.subject)
    recommended_hours, bias_applied = apply_subject_bias(recommended_hours, aggregate_pct)

    schedule, study_days = build_daily_schedule(recommended_hours, is_weak, body.topic_difficulty)

    return PredictResponse(
        subject=body.subject,
        topic=body.topic,
        exam_score=body.exam_score,
        is_weak=is_weak,
        confidence=confidence,
        recommended_hours=recommended_hours,
        study_days=study_days,
        daily_schedule=schedule,
        known_subjects=get_known_subjects(),
        bias_applied=bias_applied,
        is_known_subject=is_known_subject,
        is_known_topic=is_known_topic,
    )


@router.get("/subjects")
async def known_subjects():
    return {"subjects": get_known_subjects(), "topics": get_known_topics()}