"""
Test script to call the adapt API endpoint and verify the swap.
"""
import asyncio
import sys
import os
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

from motor.motor_asyncio import AsyncIOMotorClient
from app.core.config import settings
from app.routers.timetable import adapt_timetable

TIMETABLE_ID = "a9d6b5d8-8860-4ea0-88ec-46b19d4e4a54"

async def test_adapt_direct():
    """Test the adapt function directly without API layer."""
    client = AsyncIOMotorClient(settings.mongodb_url)
    db = client[settings.database_name]

    timetables = db.timetables

    # Get the timetable before adapt
    doc = await timetables.find_one({"_id": TIMETABLE_ID})
    if not doc:
        print(f"Timetable {TIMETABLE_ID} not found")
        return

    print(f"Timetable before adapt (version {doc['version']}):")
    for day, slots in doc["days"].items():
        if slots:
            print(f"  {day}: {len(slots)} slots")
            for slot in slots:
                print(f"    - {slot['section_title']} (id: {slot['section_id'][:8]}...)")

    # Simulate the adapt logic
    from app.routers.timetable import _swap_days, _day_average_score

    # Get progress for this timetable
    progress = db.progress
    all_section_ids = list({
        slot["section_id"]
        for slots in doc["days"].values()
        for slot in slots
    })

    all_progress_docs = await progress.find(
        {"section_id": {"$in": all_section_ids}},
    ).sort("date", -1).to_list(500)

    latest_progress = {}
    for p in all_progress_docs:
        sid = p["section_id"]
        if sid not in latest_progress:
            latest_progress[sid] = p

    print(f"\nFound {len(latest_progress)} progress records")
    print(f"Section IDs with progress: {list(latest_progress.keys())}")

    # Calculate day averages
    day_averages = {}
    for day_name, slots in doc["days"].items():
        avg = _day_average_score(day_name, slots, latest_progress)
        if avg is not None:
            day_averages[day_name] = avg
            print(f"{day_name}: {avg:.1f}%")

    # Perform swap
    reassignment_log = []
    new_days = _swap_days(doc["days"], latest_progress, reassignment_log)

    print(f"\nReassignment log: {reassignment_log}")

    print(f"\nTimetable after swap:")
    for day, slots in new_days.items():
        if slots:
            print(f"  {day}: {len(slots)} slots")
            for slot in slots:
                moved_from = f" [moved from {slot['moved_from']}]" if slot.get('moved_from') else ""
                print(f"    - {slot['section_title']} (id: {slot['section_id'][:8]}...){moved_from}")

    # Verify the swap
    print("\n=== Verification ===")
    monday_before = [s["section_id"] for s in doc["days"]["Monday"]]
    tuesday_before = [s["section_id"] for s in doc["days"]["Tuesday"]]
    monday_after = [s["section_id"] for s in new_days["Monday"]]
    tuesday_after = [s["section_id"] for s in new_days["Tuesday"]]

    if monday_after == tuesday_before and tuesday_after == monday_before:
        print("✓ SUCCESS: Monday and Tuesday sections were swapped!")
    else:
        print("✗ FAILED: Sections were not swapped as expected")
        print(f"  Monday before: {monday_before}")
        print(f"  Monday after: {monday_after}")
        print(f"  Tuesday before: {tuesday_before}")
        print(f"  Tuesday after: {tuesday_after}")

    # Check moved_from fields
    moved_from_count = sum(1 for slots in new_days.values() for s in slots if s.get("moved_from"))
    if moved_from_count > 0:
        print(f"✓ SUCCESS: {moved_from_count} slots have 'moved_from' field")
    else:
        print("✗ FAILED: No slots have 'moved_from' field")

    client.close()

if __name__ == "__main__":
    asyncio.run(test_adapt_direct())
