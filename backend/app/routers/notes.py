import io
import re
import uuid
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from fastapi.concurrency import run_in_threadpool

from ..core.database import notes_col, note_sections_col
from ..core.security import get_current_user
from ..core.config import settings
from ..core.text_utils import smart_truncate as _smart_truncate
from ..schemas import NoteResponse, NoteListItem, SegmentResponse, NoteSection, GlossaryTerm, GlossaryResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notes", tags=["notes"])


# ---------------------------------------------------------------------------
# Text extraction helpers
# ---------------------------------------------------------------------------
 
def extract_text_from_pdf(data: bytes) -> str:
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=data, filetype="pdf")
        text = "\n".join(page.get_text() for page in doc)
        logger.info("[Notes] PDF extracted — %d chars", len(text))
        return text
    except Exception as exc:
        logger.warning("[Notes] PDF extraction failed: %s", exc)
        return ""
 
 
def extract_text_from_docx(data: bytes) -> str:
    try:
        from docx import Document
        doc = Document(io.BytesIO(data))
        text = "\n".join(p.text for p in doc.paragraphs)
        logger.info("[Notes] DOCX extracted — %d chars", len(text))
        return text
    except Exception as exc:
        logger.warning("[Notes] DOCX extraction failed: %s", exc)
        return ""
 
 
# ---------------------------------------------------------------------------
# Segmentation
# ---------------------------------------------------------------------------
 
def segment_text(text: str, note_id: str, topic: str = "") -> list[dict]:
    """
    Split text into coherent sections by:
      1. Markdown headings  (#, ##, ###)
      2. Numbered headings  (1. Title, 2. Title …)  ← fixed: was uppercase-only
      3. ALL-CAPS headings  (5+ capital letters)
      4. Fallback: double-newline paragraphs
 
    Each section dict maps directly to the note_sections MongoDB schema.
    The topic field (from the parent note) is stored so the timetable can
    display "Topic: Algebra — §3 Quadratic Equations" style labels.
    """
    heading_pattern = re.compile(
    r"^("
    r"#{1,6}\s+.+"
    r"|[A-Z][A-Z\s]{3,}"
    r"|(?:\d+[\.\)])\s+.+"
    r"|(?:Chapter|Topic|Lesson|Unit)\s+\d*[:\-]?\s*.+"
    # Audit M6: original r"|[A-Z][a-zA-Z\s]{5,60}$" matched any title-case sentence
    # under 60 chars (e.g. "The nucleus contains DNA"), splitting prose into dozens of
    # tiny sections. Fixed: require all words to be capitalised (max 5 words) so only
    # genuine headings like "Photosynthesis Overview" are treated as section breaks.
    r"|(?:[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,}){0,4})$"
    r")",
    re.MULTILINE,
)
 
    splits = list(heading_pattern.finditer(text))
    sections_raw: list[dict] = []
 
    if not splits:
        # Fallback: split by double newlines (paragraph chunks)
        parts = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        for i, part in enumerate(parts):
            first_line = part.split("\n")[0][:60].strip()
            sections_raw.append({
                "title":   first_line or f"Section {i + 1}",
                "content": part,
            })
        logger.info("[Notes] No headings found — split into %d paragraph chunks", len(parts))
    else:
        for i, match in enumerate(splits):
            start = match.start()
            end   = splits[i + 1].start() if i + 1 < len(splits) else len(text)
            title   = match.group(0).lstrip("#").strip()
            content = text[start:end].strip()
            sections_raw.append({"title": title[:80], "content": content})
        logger.info("[Notes] Heading-based split — %d sections found", len(splits))
 
    # Build final section documents
    sections: list[dict] = []
    for idx, s in enumerate(sections_raw):
        words = s["content"].split()
        wc = len(words)
        if wc < 2:
            # Skip trivially empty sections
            continue
 
        # Prepend topic to title when provided, e.g. "[Algebra] Quadratic Equations"
        display_title = f"[{topic}] {s['title']}" if topic else s["title"]
 
        sections.append({
            "_id":                 str(uuid.uuid4()),
            "note_id":             note_id,
            "title":               display_title,
            "content":             s["content"],
            "word_count":          wc,
            "estimated_read_time": round(wc / 200, 2),  # ~200 wpm
            "section_index":       idx,
        })
 
    logger.info("[Notes] segment_text — %d usable sections produced", len(sections))
    return sections
 
 
def _doc_to_section(d: dict) -> NoteSection:
    """Map a MongoDB note_sections document to a NoteSection schema object."""
    return NoteSection(
        section_id=d["_id"],          # _id  →  section_id
        note_id=d["note_id"],
        title=d["title"],
        content=d["content"],
        word_count=d["word_count"],
        estimated_read_time=d["estimated_read_time"],
        section_index=d["section_index"],
    )
 
 
# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
 
@router.post("/upload", response_model=NoteResponse)
async def upload_note(
    file: UploadFile = File(...),
    subject: str = Form(...),
    topic: str = Form(...),
    current: dict = Depends(get_current_user),
):
    """
    Upload a study note (PDF / DOCX / TXT).
    The note is auto-segmented immediately so a timetable can be generated
    right after upload without a separate /segment call.
 
    Audit H3: Added file size (10 MB) and extension allow-list guards.
    """
    MAX_FILE_BYTES    = 10 * 1024 * 1024          # 10 MB
    ALLOWED_EXTS      = {"pdf", "docx", "txt", "md"}
 
    data  = await file.read()
    fname = file.filename or "upload"
    ext   = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
 
    # ── Guards ────────────────────────────────────────────────────────────────
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(data) // 1024} KB). Maximum allowed size is 10 MB.",
        )
 
    if ext not in ALLOWED_EXTS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '.{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTS))}",
        )
 
    if ext == "pdf":
        # PyMuPDF parsing is synchronous CPU/IO work — offload it so a large
        # upload doesn't stall the event loop (and every other user) for the
        # duration of the parse.
        raw_text = await run_in_threadpool(extract_text_from_pdf, data)
    elif ext == "docx":
        raw_text = await run_in_threadpool(extract_text_from_docx, data)
    else:
        raw_text = data.decode("utf-8", errors="replace")
 
    if not raw_text.strip():
        raise HTTPException(status_code=422, detail="Could not extract text from file")
 
    note_id = str(uuid.uuid4())
    doc = {
        "_id":        note_id,
        "user_id":    current["user_id"],
        "filename":   fname,
        "subject":    subject,
        "topic":      topic,
        "raw_text":   raw_text,
        "created_at": datetime.now(timezone.utc),
    }
    await notes_col().insert_one(doc)
    logger.info("[Notes] Uploaded note %s (%s / %s) — %d chars", note_id, subject, topic, len(raw_text))
 
    # Auto-segment so timetable generation works immediately
    sections = segment_text(raw_text, note_id, topic=topic)
    if sections:
        await note_sections_col().insert_many(sections)
        logger.info("[Notes] Auto-segmented %d sections for note %s", len(sections), note_id)
 
    return NoteResponse(
        note_id=note_id,
        filename=fname,
        subject=subject,
        topic=topic,
        raw_text=raw_text,
        created_at=doc["created_at"],
    )
 
 
@router.post("/{note_id}/segment", response_model=SegmentResponse)
async def segment_note(note_id: str, current: dict = Depends(get_current_user)):
    """Re-segment an existing note (also used to refresh sections)."""
    note = await notes_col().find_one({"_id": note_id, "user_id": current["user_id"]})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    # D8: Archived notes cannot be re-segmented — raw_text was cleared.
    if note.get("content_archived"):
        raise HTTPException(
            status_code=410,
            detail="Note content has been archived. Re-upload the file to regenerate sections.",
        )
 
    # Remove stale sections before re-segmenting
    await note_sections_col().delete_many({"note_id": note_id})
 
    sections = segment_text(note["raw_text"], note_id, topic=note.get("topic", ""))
    if sections:
        await note_sections_col().insert_many(sections)
 
    return SegmentResponse(
        note_id=note_id,
        sections=[_doc_to_section(s) for s in sections],
        total_sections=len(sections),
    )
 
 
@router.get("/{note_id}/sections", response_model=list[NoteSection])
async def get_sections(note_id: str, current: dict = Depends(get_current_user)):
    note = await notes_col().find_one({"_id": note_id, "user_id": current["user_id"]})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    docs = (
        await note_sections_col()
        .find({"note_id": note_id})
        .sort("section_index", 1)
        .to_list(200)
    )
    return [_doc_to_section(d) for d in docs]
 
 
@router.get("/", response_model=list[NoteListItem])
async def list_notes(current: dict = Depends(get_current_user)):
    """
    List all notes for the current user — metadata only, no raw_text.
 
    Audit C6: NoteListItem is now the actual response_model (previously
    used NoteResponse with raw_text="" as a workaround). Using the correct
    schema means Pydantic's serialiser will never accidentally include raw_text
    even if the workaround is removed, and the OpenAPI docs are accurate.
    """
    docs = (
        await notes_col()
        .find({"user_id": current["user_id"]})
        .sort("created_at", -1)
        .to_list(50)
    )
    return [
        NoteListItem(
            note_id=d["_id"],
            filename=d["filename"],
            subject=d["subject"],
            topic=d["topic"],
            created_at=d["created_at"],
            content_archived=d.get("content_archived", False),
            archived_at=d.get("archived_at"),
        )
        for d in docs
    ]


# ---------------------------------------------------------------------------
# Glossary endpoints (Feature 3)
# ---------------------------------------------------------------------------

@router.get("/{note_id}/glossary", response_model=GlossaryResponse)
async def get_glossary(note_id: str, current: dict = Depends(get_current_user)):
    """
    Return cached glossary if it exists, otherwise return empty with generated=False.
    """
    note = await notes_col().find_one({"_id": note_id, "user_id": current["user_id"]})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    terms = [GlossaryTerm(**t) for t in note.get("glossary", [])]
    return GlossaryResponse(
        note_id=note_id,
        filename=note["filename"],
        terms=terms,
        generated=False,
    )


@router.post("/{note_id}/glossary", response_model=GlossaryResponse)
async def generate_glossary(note_id: str, current: dict = Depends(get_current_user)):
    """
    Generate (or regenerate) the glossary using Groq.
    """
    import httpx

    GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
    GROQ_MODEL = "llama-3.3-70b-versatile"

    # 1. Fetch the note with ownership check
    note = await notes_col().find_one({"_id": note_id, "user_id": current["user_id"]})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    # 2. Check if content is archived
    if note.get("content_archived"):
        raise HTTPException(
            status_code=410,
            detail="Glossary unavailable — note content has been archived.",
        )

    # 3. Collect all section content values
    sections = await note_sections_col().find({"note_id": note_id}).to_list(200)
    content_parts = [s["content"] for s in sections if s.get("content") and s["content"].strip()]
    concatenated_content = "\n\n".join(content_parts)

    if not concatenated_content.strip():
        raise HTTPException(status_code=422, detail="No content available for glossary generation")

    # Truncate to 4000 chars
    truncated_content = _smart_truncate(concatenated_content, max_chars=4000)

    # 4. Call Groq (or return fallback if no API key)
    if not settings.groq_api_key:
        logger.warning("[Glossary] GROQ_API_KEY not configured -- returning fallback glossary")
        fallback_terms = [
            GlossaryTerm(
                term="Glossary unavailable",
                definition="Configure GROQ_API_KEY in .env to enable AI glossary extraction."
            )
        ]
        await notes_col().update_one(
            {"_id": note_id},
            {"$set": {"glossary": [t.dict() for t in fallback_terms]}}
        )
        return GlossaryResponse(
            note_id=note_id,
            filename=note["filename"],
            terms=fallback_terms,
            generated=True,
        )

    prompt = (
        f"Extract exactly 10–15 key technical terms from the study notes below.\n\n"
        "REQUIREMENTS:\n"
        "  • Terms must be specific, non-obvious technical or domain vocabulary from the notes.\n"
        "  • Definitions must be concise (1-2 sentences), accurate, and self-contained.\n"
        "  • Do not include common words (the, and, etc.).\n\n"
        "STRICT OUTPUT FORMAT — return ONLY a valid JSON array, no markdown fences, "
        "no preamble. Each element must have:\n"
        '  "term": string,\n'
        '  "definition": string\n\n'
        f"Study notes:\n{truncated_content}"
    )

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an expert educational content designer. "
                    "You output ONLY valid JSON arrays, never markdown."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 2048,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.groq_api_key}",
    }

    logger.info("[Glossary] Calling Groq API — model=%s note_id=%s", GROQ_MODEL, note_id)

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(GROQ_API_URL, json=payload, headers=headers)

        logger.info("[Glossary] Groq HTTP status: %d", resp.status_code)

        if resp.status_code == 401:
            raise HTTPException(
                status_code=502,
                detail="Groq API authentication failed. Check GROQ_API_KEY in .env.",
            )
        if resp.status_code == 400:
            logger.error("[Glossary] Groq 400 body: %s", resp.text[:500])
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
        logger.debug("[Glossary] Groq raw response (first 500): %s", raw_text[:500])

    except httpx.RequestError as exc:
        logger.exception("[Glossary] Network error calling Groq API")
        raise HTTPException(status_code=502, detail=f"Network error reaching Groq API: {exc}")

    # 5. Parse JSON response
    cleaned = re.sub(r"```(?:json)?|```", "", raw_text).strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        arr_match = re.search(r"\[.*\]", cleaned, re.DOTALL)
        if not arr_match:
            logger.error("[Glossary] Could not parse Groq response as JSON: %s", cleaned[:300])
            raise HTTPException(
                status_code=502,
                detail="Groq returned malformed JSON. Check logs for details.",
            )
        parsed = json.loads(arr_match.group(0))

    if isinstance(parsed, dict):
        for key in ("terms", "glossary", "items", "data"):
            if key in parsed and isinstance(parsed[key], list):
                parsed = parsed[key]
                break

    if not isinstance(parsed, list):
        raise HTTPException(status_code=502, detail="Groq response was not a JSON array.")

    # 6. Build GlossaryTerm objects
    terms = []
    for item in parsed:
        if isinstance(item, dict) and "term" in item and "definition" in item:
            terms.append(GlossaryTerm(term=item["term"], definition=item["definition"]))

    # 7. Store the result
    await notes_col().update_one(
        {"_id": note_id},
        {"$set": {"glossary": [t.dict() for t in terms]}}
    )

    logger.info("[Glossary] Generated %d terms for note %s", len(terms), note_id)

    return GlossaryResponse(
        note_id=note_id,
        filename=note["filename"],
        terms=terms,
        generated=True,
    )