"""
One-time migration: give every legacy (unbanded) q_table row a state_key.

Background: RL4 introduced banded state keys ("{section_id}:{band}") so the
Q-table can distinguish "this section when the student was scoring low" from
"...scoring high". get_q_values() already falls back gracefully to the old
section_id-only rows, but nothing merges the two — a user with both a legacy
row and a banded row for the same section has a reward history split across
two disconnected Q-tables. This script closes that gap.

Each legacy row already recorded the band it was last updated under
(last_band), so we use that rather than guessing — it's the actual state the
row's q_values reflect, not an assumption. Rows with no last_band ever
recorded fall back to "mid" as the safest default.

Safety:
  - Never overwrites an existing banded row — if one already exists for the
    same (user_id, section_id, band), the legacy row is left untouched and
    flagged for manual review instead of silently discarding either history.
  - Adds the state_key field in place ($set) rather than delete+insert, so a
    crash mid-run can't lose a row's q_values.
  - Defaults to a dry run; pass --apply to actually write.

Usage:
  python migrate_qtable_legacy_keys.py            # dry run, prints the plan
  python migrate_qtable_legacy_keys.py --apply     # actually migrates
"""
import asyncio
import sys

from motor.motor_asyncio import AsyncIOMotorClient
from app.core.config import settings

VALID_BANDS = {"low", "mid", "high"}


async def migrate(apply: bool) -> None:
    client = AsyncIOMotorClient(settings.mongodb_url)
    db = client[settings.database_name]
    q_table = db.q_table

    legacy_docs = await q_table.find({"state_key": {"$exists": False}}).to_list(1000)
    print(f"Found {len(legacy_docs)} legacy (unbanded) q_table row(s).")
    print(f"Mode: {'APPLY' if apply else 'DRY RUN (pass --apply to write)'}\n")

    migrated, skipped_conflict = 0, 0

    for doc in legacy_docs:
        band = doc.get("last_band")
        if band not in VALID_BANDS:
            band = "mid"
        state_key = f"{doc['section_id']}:{band}"

        conflict = await q_table.find_one({"user_id": doc["user_id"], "state_key": state_key})
        if conflict:
            print(
                f"SKIP (conflict): user={doc['user_id']} section={doc['section_id']} "
                f"-> {state_key} already exists as a banded row ({conflict['_id']}); "
                f"leaving legacy row {doc['_id']} untouched for manual review."
            )
            skipped_conflict += 1
            continue

        print(f"{'MIGRATE' if apply else 'WOULD MIGRATE'}: {doc['_id']} "
              f"section={doc['section_id']} band={band} -> state_key={state_key}")

        if apply:
            await q_table.update_one(
                {"_id": doc["_id"]},
                {"$set": {"state_key": state_key}},
            )
        migrated += 1

    print(
        f"\nDone. {'Migrated' if apply else 'Would migrate'}: {migrated}, "
        f"skipped (conflict): {skipped_conflict}, total legacy found: {len(legacy_docs)}"
    )

    client.close()


if __name__ == "__main__":
    asyncio.run(migrate(apply="--apply" in sys.argv))
