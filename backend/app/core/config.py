from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache

# Sentinel used to detect the placeholder key at startup (audit C3).
UNSAFE_DEFAULT_KEY = "CHANGE_ME_IN_PRODUCTION_USE_LONG_RANDOM_STRING"


class Settings(BaseSettings):
    # MongoDB
    mongodb_url: str = "mongodb://localhost:27017"
    database_name: str = "studymind"

    # JWT
    secret_key: str = UNSAFE_DEFAULT_KEY
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # Anthropic (legacy field kept for compatibility)
    anthropic_api_key: str = ""
    groq_api_key: str = ""

    # Model paths
    model_dir: str = "ml_models"

    # ── Email / SMTP (Day 5) ──────────────────────────────────────────────────
    # Leave SMTP_HOST blank to stay in log-only fallback mode (safe for dev).
    smtp_host:     str  = ""
    smtp_port:     int  = 587
    smtp_username: str  = ""
    smtp_password: str  = ""
    smtp_from:     str  = "noreply@cognitive-sanctuary.app"
    smtp_from_name: str = "Cognitive Sanctuary"
    # Set smtp_use_tls=false only for local mailhog/mailcatcher dev servers.
    smtp_use_tls:  bool = True

    # Deployment environment — used for cookie security flags
    environment: str = "development"   # "production" enables secure cookies

    # CORS
    allowed_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # Pydantic v2 config — replaces the old inner `class Config`
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",           # silently ignore unknown .env keys
        protected_namespaces=(),  # fixes the model_dir warning
    )

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()