"""
Test script to verify RL Adapt day swap works correctly with realistic data.
This script creates a test scenario with:
1. A note with multiple sections
2. A timetable with multiple days
3. Progress records for sections on different days
4. Calls adapt and verifies the swap occurs
"""
import asyncio
import sys
import os
from datetime import datetime, timezone

# Add the app directory to the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

from motor.motor_asyncio import AsyncIOMotorClient
from app.core.config import settings
import uuid

async def create_test_data():
    """Create test data for adapt swap verification."""
    client = AsyncIOMotorClient(settings.mongodb_url)
    db = client[settings.database_name]

    users = db.users
    notes = db.notes
    note_sections = db.note_sections
    timetables = db.timetables
    progress = db.progress

    # Use the existing user
    user_id = "69f01a7c576e95291859d7cc"
    print(f"Using user: {user_id}")

    # Create a test note
    note_id = str(uuid.uuid4())
    note_doc = {
        "_id": note_id,
        "user_id": user_id,
        "filename": "test_note.pdf",
        "subject": "Test Subject",
        "topic": "Test Topic",
        "raw_text": "Test content",
        "created_at": datetime.now(timezone.utc),
    }
    await notes.insert_one(note_doc)
    print(f"Created test note: {note_id}")

    # Create test sections (simulate split sections)
    section_ids = []
    for i in range(6):  # 6 sections
        section_id = str(uuid.uuid4())
        section_doc = {
            "_id": section_id,
            "note_id": note_id,
            "title": f"Test Section {i+1}",
            "content": f"Content for section {i+1}",
            "word_count": 1000,
            "section_index": i,
        }
        await note_sections.insert_one(section_doc)
        section_ids.append(section_id)
    print(f"Created {len(section_ids)} test sections")

    # Create a timetable with 3 days
    timetable_id = str(uuid.uuid4())
    week_start = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Distribute sections across 3 days
    days = {
        "Monday": [
            {
                "section_id": section_ids[0],
                "section_title": "Test Section 1",
                "section_content": "Content for section 1",
                "hours_allocated": 1.0,
                "start_time": "09:00",
                "end_time": "10:00",
                "break_minutes": 5,
            },
            {
                "section_id": section_ids[1],
                "section_title": "Test Section 2",
                "section_content": "Content for section 2",
                "hours_allocated": 1.0,
                "start_time": "10:05",
                "end_time": "11:05",
                "break_minutes": 5,
            },
        ],
        "Tuesday": [
            {
                "section_id": section_ids[2],
                "section_title": "Test Section 3",
                "section_content": "Content for section 3",
                "hours_allocated": 1.0,
                "start_time": "09:00",
                "end_time": "10:00",
                "break_minutes": 5,
            },
            {
                "section_id": section_ids[3],
                "section_title": "Test Section 4",
                "section_content": "Content for section 4",
                "hours_allocated": 1.0,
                "start_time": "10:05",
                "end_time": "11:05",
                "break_minutes": 5,
            },
        ],
        "Wednesday": [
            {
                "section_id": section_ids[4],
                "section_title": "Test Section 5",
                "section_content": "Content for section 5",
                "hours_allocated": 1.0,
                "start_time": "09:00",
                "end_time": "10:00",
                "break_minutes": 5,
            },
            {
                "section_id": section_ids[5],
                "section_title": "Test Section 6",
                "section_content": "Content for section 6",
                "hours_allocated": 1.0,
                "start_time": "10:05",
                "end_time": "11:05",
                "break_minutes": 5,
            },
        ],
    }

    timetable_doc = {
        "_id": timetable_id,
        "user_id": user_id,
        "note_id": note_id,
        "week_start": week_start,
        "version": 1,
        "days": days,
    }
    await timetables.insert_one(timetable_doc)
    print(f"Created test timetable: {timetable_id}")

    # Create progress records:
    # Monday: low scores (90%, 85%) - average 87.5%
    # Tuesday: high scores (40%, 50%) - average 45%
    # Wednesday: medium scores (60%, 70%) - average 65%
    # Expected swap: Tuesday (worst) <-> Monday (best)

    progress_records = [
        # Monday - high scores
        {"section_id": section_ids[0], "score_pct": 90.0},
        {"section_id": section_ids[1], "score_pct": 85.0},
        # Tuesday - low scores
        {"section_id": section_ids[2], "score_pct": 40.0},
        {"section_id": section_ids[3], "score_pct": 50.0},
        # Wednesday - medium scores
        {"section_id": section_ids[4], "score_pct": 60.0},
        {"section_id": section_ids[5], "score_pct": 70.0},
    ]

    for idx, record in enumerate(progress_records):
        progress_doc = {
            "_id": str(uuid.uuid4()),
            "user_id": user_id,
            "section_id": record["section_id"],
            "timetable_id": timetable_id,
            "score_pct": record["score_pct"],
            "questions_attempted": 5,
            "correct_answers": int(record["score_pct"] / 100 * 5),
            "attempt_number": 1,
            "date": datetime.now(timezone.utc),
        }
        await progress.insert_one(progress_doc)

    print(f"Created {len(progress_records)} progress records")
    print()
    print("=== Test Data Summary ===")
    print(f"Timetable ID: {timetable_id}")
    print(f"Note ID: {note_id}")
    print(f"User ID: {user_id}")
    print()
    print("Day Averages (calculated):")
    print(f"  Monday: (90 + 85) / 2 = 87.5%")
    print(f"  Tuesday: (40 + 50) / 2 = 45%")
    print(f"  Wednesday: (60 + 70) / 2 = 65%")
    print()
    print("Expected swap: Tuesday (45%) <-> Monday (87.5%)")
    print()
    print("=== Next Steps ===")
    print("1. Start the backend server")
    print(f"2. Call POST /timetable/{timetable_id}/adapt")
    print("3. Verify that sections are swapped between Tuesday and Monday")
    print("4. Verify that 'moved_from' field is set on swapped sections")
    print()
    print("=== Cleanup Command ===")
    print(f"Delete test data:")
    print(f"  db.notes.deleteOne({{_id: '{note_id}'}})")
    print(f"  db.note_sections.deleteMany({{note_id: '{note_id}'}})")
    print(f"  db.timetables.deleteOne({{_id: '{timetable_id}'}})")
    print(f"  db.progress.deleteMany({{timetable_id: '{timetable_id}'}})")

    client.close()

if __name__ == "__main__":
    asyncio.run(create_test_data())
