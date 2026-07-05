import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings, UNSAFE_DEFAULT_KEY
from app.core.models import load_models
from app.core.database import close_db, create_indexes
from app.core.leader_lock import acquire_scheduler_leadership, release_scheduler_leadership
from app.routers import auth, notes, predict, timetable, mcq, progress
from app.routers.chat import router as chat_router
from app.routers.onboarding import router as onboarding_router
from app.routers.settings import router as settings_router
from app.routers.twofa import router as twofa_router
from app.routers.sessions import router as sessions_router
from app.services.lifecycle import run_lifecycle_job
from app.services.streaks import run_streak_nudge_job
#from routes.chat import router as chat_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
   
  
    if settings.secret_key == UNSAFE_DEFAULT_KEY:
        if settings.is_production:
            import sys
            logger.critical(
                "FATAL: SECRET_KEY is the default placeholder value. "
                "Set a strong SECRET_KEY in .env before deploying to production."
            )
            sys.exit(1)
        else:
            logger.warning(
                "⚠  SECRET_KEY is using the default placeholder — safe for local "
                "development but MUST be changed before any production deployment."
            )

    
    await create_indexes()

    load_models(settings.model_dir)

    # D8: Start the note lifecycle scheduler (daily at 02:00 UTC)
    # Only one process across all workers/replicas should run these cron
    # jobs — otherwise every worker fires its own copy (duplicate streak
    # emails, redundant archive sweeps). Guarded by a Mongo-backed leader lock.
    scheduler = None
    is_leader = await acquire_scheduler_leadership()
    if is_leader:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        scheduler = AsyncIOScheduler(timezone="UTC")
        scheduler.add_job(
            run_lifecycle_job,
            trigger="cron",
            hour=2, minute=0,
            id="note_lifecycle",
            replace_existing=True,
        )
        # Streak-preservation nudge — one fixed UTC evening hour for all users
        # (no per-user timezone-aware scheduling exists yet; see streaks.py).
        scheduler.add_job(
            run_streak_nudge_job,
            trigger="cron",
            hour=20, minute=0,
            id="streak_nudge",
            replace_existing=True,
        )
        scheduler.start()
        logger.info("[Startup] Note lifecycle scheduler started (daily at 02:00 UTC)")
        logger.info("[Startup] Streak nudge scheduler started (daily at 20:00 UTC)")

    # D5: Warn once at startup if SMTP is not configured
    if not settings.smtp_host:
        logger.warning(
            "[Startup] SMTP_HOST is not configured — email notifications will "
            "log to console only. Set SMTP_HOST in .env for real delivery."
        )

    yield

    if scheduler:
        scheduler.shutdown(wait=False)
        await release_scheduler_leadership()
    await close_db()


app = FastAPI(
    title="StudyMind AI API",
    version="1.0.0",
    description="Adaptive AI-powered student learning platform",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(notes.router)
app.include_router(predict.router)
app.include_router(timetable.router)
app.include_router(mcq.router)
app.include_router(progress.router)
app.include_router(chat_router)
app.include_router(onboarding_router)
app.include_router(settings_router)
app.include_router(twofa_router)
app.include_router(sessions_router)

@app.get("/health")
async def health():
    from app.core.models import models_ready
    return {
        "status": "ok",
        "models_loaded": models_ready(),
        "environment": settings.environment,
        "email_configured": bool(settings.smtp_host),
    }