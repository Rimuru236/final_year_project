from __future__ import annotations
from ..core.database import q_table_col

ACTIONS = ["increase", "keep", "decrease"]
ALPHA   = 0.1   # learning rate
GAMMA   = 0.9   # discount factor
EPSILON = 0.1   # exploration rate

MIN_SLOT_HOURS = 0.25  # RL2: absolute floor
MAX_SLOT_HOURS = 8.0   # RL3: absolute ceiling


def _score_band(score: float) -> str:
    if score < 60:  return "low"
    if score < 80:  return "mid"
    return "high"


# A correct-but-slow answer (most of the allotted time used despite scoring
# well) suggests the student is still consolidating this material, not
# confidently mastering it — cap the reward instead of rewarding it the same
# as a fast, confident answer, so hours aren't cut prematurely.
SLOW_RESPONSE_THRESHOLD_PCT = 85.0


def _reward(score: float, avg_response_time_pct: float | None = None) -> float:
    if score >= 80:
        if avg_response_time_pct is not None and avg_response_time_pct >= SLOW_RESPONSE_THRESHOLD_PCT:
            return 0.0
        return 1.0
    if score >= 60: return 0.0
    return -1.0


async def get_q_values(user_id: str, section_id: str, band: str = "") -> dict:
    """
    RL4: State key now includes the score band for finer-grained Q-values.
    Falls back to the section-only key for backwards compatibility with
    existing Q-table rows that don't have a band suffix.
    """
    state_key = f"{section_id}:{band}" if band else section_id
    doc = await q_table_col().find_one({"user_id": user_id, "state_key": state_key})
    if doc:
        return doc["q_values"]
    # Backwards compat: try legacy section_id-only key
    legacy = await q_table_col().find_one({"user_id": user_id, "section_id": section_id})
    if legacy:
        return legacy["q_values"]
    return {a: 0.0 for a in ACTIONS}


async def update_q_table(
    user_id: str,
    section_id: str,
    score: float,
    avg_response_time_pct: float | None = None,
) -> str:
    """
    Update Q-values and return recommended action for next week.

    Uses epsilon-greedy selection so the agent genuinely explores
    and exploits over time rather than being hardwired by score band.
    """
    import random

    band   = _score_band(score)
    q      = await get_q_values(user_id, section_id, band)
    reward = _reward(score, avg_response_time_pct)

    # ── Epsilon-greedy action selection ──────────────────────────────────────
    if random.random() < EPSILON:
        action = random.choice(ACTIONS)          # explore
    else:
        action = max(q, key=lambda a: q[a])      # exploit best known Q-value

    # ── Bellman Q-update ─────────────────────────────────────────────────────
    old_q    = q.get(action, 0.0)
    max_next = max(q.values())
    q[action] = old_q + ALPHA * (reward + GAMMA * max_next - old_q)

    state_key = f"{section_id}:{band}"
    await q_table_col().update_one(
        {"user_id": user_id, "state_key": state_key},
        {"$set": {
            "q_values":    q,
            "section_id":  section_id,
            "last_score":  score,
            "last_band":   band,
            "state_key":   state_key,
        }},
        upsert=True,
    )
    return action


def apply_action(current_hours: float, action: str) -> float:
    """
    Apply RL action to produce new hour allocation.

    RL2: Hard floor at MIN_SLOT_HOURS (0.25h) — prevents a slot vanishing.
    RL3: Hard ceiling at MAX_SLOT_HOURS (8h) — prevents runaway expansion.
    """
    if action == "increase":
        new_hours = min(current_hours * 1.3, current_hours + 2.0)
    elif action == "decrease":
        new_hours = max(current_hours * 0.75, MIN_SLOT_HOURS)
    else:
        new_hours = current_hours

    # Clamp between absolute bounds
    new_hours = max(MIN_SLOT_HOURS, min(MAX_SLOT_HOURS, new_hours))
    return round(new_hours, 2)
