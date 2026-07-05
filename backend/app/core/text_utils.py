"""Shared text-processing helpers used across routers."""


def smart_truncate(text: str, max_chars: int = 4000) -> str:
    """
    Truncate text at a sentence boundary rather than mid-word.
    Audit C5: the original hard-truncated at 3000 chars, producing incomplete
    sentences that confused the LLM and caused questions about unfinished ideas.
    """
    if len(text) <= max_chars:
        return text
    truncated = text[:max_chars]
    last_period = max(truncated.rfind(". "), truncated.rfind(".\n"))
    return truncated[: last_period + 1] if last_period > max_chars // 2 else truncated
