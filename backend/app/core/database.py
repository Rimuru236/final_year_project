# from motor.motor_asyncio import AsyncIOMotorClient
# from .config import settings

# _client: AsyncIOMotorClient | None = None


# def get_client() -> AsyncIOMotorClient:
#     global _client
#     if _client is None:
#         _client = AsyncIOMotorClient(settings.mongodb_url)
#     return _client


# def get_db():
#     return get_client()[settings.database_name]


# async def close_db():
#     global _client
#     if _client:
#         _client.close()
#         _client = None


# # Collection helpers
# def users_col():
#     return get_db()["users"]

# def notes_col():
#     return get_db()["notes"]

# def note_sections_col():
#     return get_db()["note_sections"]

# def timetables_col():
#     return get_db()["timetables"]

# def mcqs_col():
#     return get_db()["mcqs"]

# def progress_col():
#     return get_db()["progress"]

# def q_table_col():
#     return get_db()["q_table"]
# #===============================================================================
# #===============================================================================
from motor.motor_asyncio import AsyncIOMotorClient
from .config import settings

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        _client = AsyncIOMotorClient(settings.mongodb_url)
    return _client


def get_db():
    return get_client()[settings.database_name]


async def close_db():
    global _client
    if _client:
        _client.close()
        _client = None


# Collection helpers
def users_col():
    return get_db()["users"]

def notes_col():
    return get_db()["notes"]

def note_sections_col():
    return get_db()["note_sections"]

def timetables_col():
    return get_db()["timetables"]

def mcqs_col():
    return get_db()["mcqs"]

def progress_col():
    return get_db()["progress"]

def q_table_col():
    return get_db()["q_table"]

def sessions_col():
    return get_db()["sessions"]


# ---------------------------------------------------------------------------
# Index creation  (audit C4: no indexes defined anywhere)
# Call once at application startup — safe to call repeatedly (idempotent).
# ---------------------------------------------------------------------------

async def create_indexes() -> None:
    """
    Create all performance-critical MongoDB indexes.
    Each call is idempotent: if the index already exists MongoDB is a no-op.
    """
    import logging
    logger = logging.getLogger(__name__)

    # progress: most-queried collection — used in adapt loop + report
    await progress_col().create_index(
        [("user_id", 1), ("section_id", 1), ("date", -1)],
        name="progress_user_section_date",
    )

    # q_table: unique per (user, section)
    await q_table_col().create_index(
        [("user_id", 1), ("section_id", 1)],
        unique=True,
        name="qtable_user_section",
    )

    # mcqs: fetched by section_id on every quiz start
    await mcqs_col().create_index(
        [("section_id", 1)],
        name="mcqs_section",
    )

    # note_sections: fetched by note_id on timetable generation
    await note_sections_col().create_index(
        [("note_id", 1), ("section_index", 1)],
        name="sections_note_index",
    )

    # timetables: listed by user, ordered by recency
    await timetables_col().create_index(
        [("user_id", 1), ("week_start", -1)],
        name="timetables_user_week",
    )

    # notes: listed by user, ordered by recency
    await notes_col().create_index(
        [("user_id", 1), ("created_at", -1)],
        name="notes_user_created",
    )

    logger.info("[DB] MongoDB indexes ensured.")