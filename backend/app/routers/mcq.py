import uuid
import json
import re
import logging
from fastapi import APIRouter, HTTPException, Depends

from ..core.database import mcqs_col, note_sections_col, notes_col, progress_col, users_col
from ..core.security import get_current_user
from ..core.config import settings
from ..core.text_utils import smart_truncate as _smart_truncate
from ..schemas import MCQ, MCQGenerateRequest, MCQOption
from ..services.rl_engine import _score_band

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcq", tags=["mcq"])

# ---------------------------------------------------------------------------
# Groq generation
# ---------------------------------------------------------------------------

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile"  # Fast & free on Groq. Alternatives: "mixtral-8x7b-32768", "llama3-70b-8192"


DIFFICULTY_INSTRUCTIONS = {
    "easy": (
        "  • This student is still building foundational understanding of this material "
        "(recent quiz scores are low). Focus on core definitions and foundational recall — "
        "avoid multi-step reasoning, edge cases, or trick questions.\n"
    ),
    "medium": (
        "  • Balance recall with light application, typical exam-style questions.\n"
    ),
    "hard": (
        "  • This student has already demonstrated strong mastery of this material (recent "
        "quiz scores are high). Focus on application, synthesis, and edge cases — avoid "
        "simple recall questions that only restate a definition.\n"
    ),
}


async def _generate_via_groq(content: str, n: int, difficulty: str = "medium") -> list[dict]:
    """
    Call the Groq chat-completions endpoint and return a list of
    raw MCQ dicts with keys: question, options, correct_answer, explanation.

    The endpoint is OpenAI-compatible so we use httpx directly (no SDK needed).

    difficulty ("easy"/"medium"/"hard") adapts question style to the student's
    recent performance on this section — see _determine_difficulty().
    """
    import httpx

    truncated_content = _smart_truncate(content, max_chars=4000)
    difficulty_instruction = DIFFICULTY_INSTRUCTIONS.get(difficulty, DIFFICULTY_INSTRUCTIONS["medium"])

    prompt = (
        f"Generate exactly {n} multiple-choice questions based on the study notes below.\n\n"
        "REQUIREMENTS:\n"
        "  • Questions must test understanding, not just memory of surface facts.\n"
        "  • Each question must have exactly one unambiguously correct answer.\n"
        "  • Distractors (wrong options) must be plausible but clearly incorrect.\n"
        "  • Vary question types: definition, application, comparison, cause-effect.\n"
        f"{difficulty_instruction}\n"
        "STRICT OUTPUT FORMAT — return ONLY a valid JSON array, no markdown fences, "
        "no preamble, no trailing text. Each element must have:\n"
        '  "question": string,\n'
        '  "options": { "A": string, "B": string, "C": string, "D": string },\n'
        '  "correct_answer": one of "A","B","C","D",\n'
        '  "explanation": string (1-2 sentences explaining why the answer is correct)\n\n'
        f"Study notes:\n{truncated_content}"
    )

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an expert educational assessment designer. "
                    "You output ONLY valid JSON arrays, never markdown."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 2048,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.groq_api_key}",
    }

    logger.info("[MCQ] Calling Groq API — model=%s n=%d content_len=%d", GROQ_MODEL, n, len(content))

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(GROQ_API_URL, json=payload, headers=headers)

        logger.info("[MCQ] Groq HTTP status: %d", resp.status_code)

        if resp.status_code == 401:
            raise HTTPException(
                status_code=502,
                detail="Groq API authentication failed. Check GROQ_API_KEY in .env.",
            )
        if resp.status_code == 400:
            logger.error("[MCQ] Groq 400 body: %s", resp.text[:500])
            raise HTTPException(
                status_code=502,
                detail=f"Groq API bad request: {resp.text[:300]}",
            )
        if not resp.is_success:
            raise HTTPException(
                status_code=502,
                detail=f"Groq API error {resp.status_code}: {resp.text[:300]}",
            )

        data = resp.json()
        raw_text: str = data["choices"][0]["message"]["content"].strip()
        logger.debug("[MCQ] Groq raw response (first 500): %s", raw_text[:500])

    except httpx.RequestError as exc:
        logger.exception("[MCQ] Network error calling Groq API")
        raise HTTPException(status_code=502, detail=f"Network error reaching Groq API: {exc}")

    # -- Parse JSON robustly -------------------------------------------------
    # Strip optional markdown code fences (```json ... ```)
    cleaned = re.sub(r"```(?:json)?|```", "", raw_text).strip()

    # Some models wrap the array in {"mcqs": [...]} -- unwrap it
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        # Last resort: find the first [...] block
        arr_match = re.search(r"\[.*\]", cleaned, re.DOTALL)
        if not arr_match:
            logger.error("[MCQ] Could not parse Groq response as JSON: %s", cleaned[:300])
            raise HTTPException(
                status_code=502,
                detail="Groq returned malformed JSON. Check logs for details.",
            )
        parsed = json.loads(arr_match.group(0))

    if isinstance(parsed, dict):
        # Unwrap {"mcqs": [...]} or {"questions": [...]}
        for key in ("mcqs", "questions", "items", "data"):
            if key in parsed and isinstance(parsed[key], list):
                parsed = parsed[key]
                break

    if not isinstance(parsed, list):
        raise HTTPException(status_code=502, detail="Groq response was not a JSON array.")

    logger.info("[MCQ] Successfully parsed %d questions from Groq", len(parsed))
    return parsed


# ---------------------------------------------------------------------------
# Fallback when no API key is set
# ---------------------------------------------------------------------------

def _fallback_mcqs(section_id: str, n: int) -> list[dict]:
    """Placeholder MCQs shown when GROQ_API_KEY is absent."""
    logger.warning("[MCQ] GROQ_API_KEY not configured -- returning placeholder MCQs")
    return [
        {
            "question": f"Sample question {i + 1} (set GROQ_API_KEY in .env to generate real questions)",
            "options": {
                "A": "Option A",
                "B": "Option B",
                "C": "Option C",
                "D": "Option D",
            },
            "correct_answer": "A",
            "explanation": "Add your GROQ_API_KEY to the .env file for AI-generated questions.",
        }
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# Adaptive difficulty — derive from the student's own quiz history for this
# section, falling back to their declared default_mcq_difficulty setting
# (settings.py StudyPrefs) when there's no attempt data to adapt from yet.
# ---------------------------------------------------------------------------

_BAND_TO_DIFFICULTY = {"low": "easy", "mid": "medium", "high": "hard"}


async def _determine_difficulty(user_id: str, section_id: str, user_default: str | None) -> str:
    latest = await progress_col().find_one(
        {"user_id": user_id, "section_id": section_id},
        sort=[("date", -1)],
    )
    if latest:
        return _BAND_TO_DIFFICULTY[_score_band(latest["score_pct"])]
    if user_default in ("easy", "medium", "hard"):
        return user_default
    return "medium"


# ---------------------------------------------------------------------------
# Option normaliser -- handles list or dict from the model
# ---------------------------------------------------------------------------

def _normalise_options(raw_opts) -> dict:
    if isinstance(raw_opts, dict):
        return {
            "A": str(raw_opts.get("A", "")),
            "B": str(raw_opts.get("B", "")),
            "C": str(raw_opts.get("C", "")),
            "D": str(raw_opts.get("D", "")),
        }
    if isinstance(raw_opts, list):
        padded = list(raw_opts) + [""] * 4  # ensure at least 4 items
        return {chr(65 + i): str(padded[i]) for i in range(4)}
    return {"A": "", "B": "", "C": "", "D": ""}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/generate", response_model=list[MCQ])
async def generate_mcqs(
    body: MCQGenerateRequest,
    current: dict = Depends(get_current_user),
):
    """
    Generate MCQs for a note section using the Groq API.

    Fixes applied (audit H6, C2, C5, security):
      1. Phantom-ID handling: split sections (id "abc_0") aren't in the DB.
         We first try a direct lookup; if not found we check whether the base
         section exists and use its content with the chunk offset embedded.
      2. Ownership check: verify the section belongs to the requesting user.
      3. MCQ cache: if valid MCQs already exist for this section, return them
         immediately without a new Groq call — prevents quota exhaustion.
      4. Smart truncation: content is now truncated at a sentence boundary
         rather than mid-word at a fixed char limit.
    """
    from ..core.database import notes_col

    user_id = current["user_id"]

    # ── 1. Section lookup with phantom-ID handling ───────────────────────────
    section = await note_sections_col().find_one({"_id": body.section_id})

    if not section:
        # The section_id may be a split chunk id like "base-uuid_2".
        # Try resolving the base section and extracting the right word chunk.
        if "_" in body.section_id:
            parts     = body.section_id.rsplit("_", 1)
            base_id   = parts[0]
            try:
                chunk_idx = int(parts[1])
            except ValueError:
                chunk_idx = 0
            base_section = await note_sections_col().find_one({"_id": base_id})
            if base_section:
                from ..routers.timetable import MAX_SECTION_WORDS
                words  = base_section["content"].split()
                start  = chunk_idx * MAX_SECTION_WORDS
                chunk  = words[start: start + MAX_SECTION_WORDS]
                # Construct a virtual section document for MCQ generation
                section = {
                    **base_section,
                    "_id":        body.section_id,
                    "content":    " ".join(chunk),
                    "word_count": len(chunk),
                }
                logger.info(
                    "[MCQ] Resolved split section %s from base %s (chunk %d)",
                    body.section_id, base_id, chunk_idx,
                )

    if not section:
        raise HTTPException(status_code=404, detail="Section not found")

    # ── 2. Ownership check ───────────────────────────────────────────────────
    note = await notes_col().find_one(
        {"_id": section["note_id"], "user_id": user_id}
    )
    if not note:
        raise HTTPException(
            status_code=403,
            detail="Access denied: this section does not belong to your account",
        )

    # ── Adaptive difficulty: derive from this user's own performance on this
    #    section, falling back to their declared StudyPrefs default ──────────
    from bson import ObjectId as _ObjId
    user_doc = await users_col().find_one({"_id": _ObjId(user_id)})
    user_default_difficulty = user_doc.get("default_mcq_difficulty") if user_doc else None
    difficulty = await _determine_difficulty(user_id, body.section_id, user_default_difficulty)

    logger.info(
        "[MCQ] generate_mcqs -- section_id=%s n=%d user=%s difficulty=%s",
        body.section_id, body.num_questions, user_id, difficulty,
    )

    # ── 3. Return cached MCQs if they exist for this difficulty ──────────────
    # Legacy cached docs (generated before difficulty banding existed) have no
    # "difficulty" field — treat those as "medium" so they aren't orphaned.
    cache_query = (
        {"section_id": body.section_id, "$or": [{"difficulty": "medium"}, {"difficulty": {"$exists": False}}]}
        if difficulty == "medium"
        else {"section_id": body.section_id, "difficulty": difficulty}
    )
    existing = await mcqs_col().find(cache_query).to_list(body.num_questions + 5)

    if existing:
        logger.info(
            "[MCQ] Returning %d cached MCQs for section %s (difficulty=%s)",
            len(existing), body.section_id, difficulty,
        )
        return [
            MCQ(
                mcq_id=d["_id"],
                section_id=d["section_id"],
                question=d["question"],
                options=MCQOption(**d["options"]),
                correct_answer=d["correct_answer"],
                explanation=d["explanation"],
            )
            for d in existing
        ]

    # ── 4. Generate fresh MCQs ───────────────────────────────────────────────
    content = section["content"]

    # D8: Graceful degradation — if section content was archived (cleared by
    # the lifecycle job), return a clear 410 rather than sending an empty
    # string to Groq and getting meaningless questions.
    if not content or not content.strip():
        # Check if the parent note is actually archived
        note_id = section.get("note_id", "")
        note = await notes_col().find_one({"_id": note_id}, {"content_archived": 1}) if note_id else None
        if note and note.get("content_archived"):
            raise HTTPException(
                status_code=410,
                detail="MCQs unavailable — this section's content has been archived. Re-upload your notes to regenerate quizzes.",
            )

    if settings.groq_api_key:
        raw = await _generate_via_groq(content, body.num_questions, difficulty)
    else:
        raw = _fallback_mcqs(body.section_id, body.num_questions)

    docs = []
    for item in raw:
        opts = _normalise_options(item.get("options", {}))
        doc = {
            "_id":            str(uuid.uuid4()),
            "section_id":     body.section_id,
            "difficulty":     difficulty,
            "question":       item.get("question", "").strip(),
            "options":        opts,
            "correct_answer": item.get("correct_answer", "A"),
            "explanation":    item.get("explanation", "").strip(),
        }
        docs.append(doc)

    if docs:
        await mcqs_col().insert_many(docs)
        logger.info("[MCQ] Inserted %d MCQs for section %s", len(docs), body.section_id)

    return [
        MCQ(
            mcq_id=d["_id"],
            section_id=d["section_id"],
            question=d["question"],
            options=MCQOption(**d["options"]),
            correct_answer=d["correct_answer"],
            explanation=d["explanation"],
        )
        for d in docs
    ]


@router.get("/{section_id}", response_model=list[MCQ])
async def get_mcqs(section_id: str, current: dict = Depends(get_current_user)):
    """
    Retrieve previously generated MCQs for a section.
    Audit M3: raised to_list cap from 20 to 50 so a 20-question cached set
    is not silently truncated to 20 — which was masked by to_list(20) == 20
    but would silently drop questions if cache ever exceeded 20.
    """
    docs = await mcqs_col().find({"section_id": section_id}).to_list(50)
    return [
        MCQ(
            mcq_id=d["_id"],
            section_id=d["section_id"],
            question=d["question"],
            options=MCQOption(**d["options"]),
            correct_answer=d["correct_answer"],
            explanation=d["explanation"],
        )
        for d in docs
    ]


@router.delete("/{section_id}/cache")
async def clear_mcq_cache(section_id: str, current: dict = Depends(get_current_user)):
    """
    Clear cached MCQs for a section so fresh ones are generated on next quiz start.
    Useful when note content has been updated.
    """
    result = await mcqs_col().delete_many({"section_id": section_id})
    return {"deleted": result.deleted_count, "section_id": section_id}