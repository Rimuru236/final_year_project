from fastapi import APIRouter
from pydantic import BaseModel
from groq import Groq
from app.core.config import settings
from typing import List
import logging

router = APIRouter()

logger = logging.getLogger(__name__)

# Initialize Groq client
client = Groq(api_key=settings.groq_api_key)


# ─────────────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────────────

class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[Message] = []
    user_name: str = "Student"
    level: str = "Undergraduate"
    system_prompt: str = ""


# ─────────────────────────────────────────────────────────────
# Chat Endpoint
# ─────────────────────────────────────────────────────────────

@router.post("/chat")
async def chat(req: ChatRequest):
    try:
        messages = []

        # Add system prompt
        if req.system_prompt:
            messages.append({
                "role": "system",
                "content": req.system_prompt
            })

        # Add previous conversation history
        for msg in req.history[-10:]:
            if msg.role in ["user", "assistant"]:
                messages.append({
                    "role": msg.role,
                    "content": msg.content
                })

        # Add current user message
        messages.append({
            "role": "user",
            "content": req.message
        })

        logger.info(f"Sending {len(messages)} messages to Groq")

        # Call Groq
        completion = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=messages,
            temperature=0.7,
            max_tokens=600,
        )

        assistant_response = completion.choices[0].message.content

        return {
            "response": assistant_response
        }

    except Exception as e:
        logger.exception("Chat endpoint error")

        return {
            "error": str(e),
            "response": "Sorry, the AI assistant is temporarily unavailable."
        }
