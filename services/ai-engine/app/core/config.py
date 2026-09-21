"""
iRexPro AI Engine — Configuration

Uses pydantic-settings to load all config from environment variables.
All sensitive values come from the environment — never hardcoded.
"""
from __future__ import annotations

from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ─── Service identity ──────────────────────────────────────────────────
    ai_engine_env: Literal["development", "staging", "production"] = "development"
    ai_engine_port: int = 8001
    ai_engine_service_name: str = "irexpro-ai-engine"
    ai_engine_version: str = "0.1.0"

    # ─── NestJS integration ────────────────────────────────────────────────
    nestjs_api_base_url: str = "http://localhost:3000/api/v1"
    nestjs_ai_signal_endpoint: str = "/ai/internal/signals"
    nestjs_market_data_endpoint: str = "/market-data/internal/ohlcv"
    nestjs_internal_api_key: str = "dev_internal_key_change_me"

    # ─── Redis ────────────────────────────────────────────────────────────
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str = "irexpro_redis_dev_password"
    redis_db: int = 1
    ai_redis_key_prefix: str = "ai"
    ai_ohlcv_cache_ttl_seconds: int = 300

    # ─── AI behaviour ─────────────────────────────────────────────────────
    ai_default_model_version: str = "baseline-xgboost-v0.1.0"
    ai_min_confidence_score: float = 0.60
    ai_signal_mode: Literal["paper", "sandbox", "live"] = "paper"
    ai_allow_mock_market_data: bool = False
    # LIVE activation feature gate (default OFF). Live signal mode requires
    # ALL of: ai_signal_mode == "live" AND this env gate (AI_ENGINE_ALLOW_
    # LIVE_MODEL=true) AND a valid out-of-band promotion record matching the
    # active model's verified artifact bytes. See app/domain/models/promotion.py.
    ai_engine_allow_live_model: bool = False

    # ─── Scheduler ────────────────────────────────────────────────────────
    ai_scheduler_enabled: bool = False
    ai_signal_interval_seconds: int = 60

    # ─── CORS ─────────────────────────────────────────────────────────────
    ai_cors_origins: str = "http://localhost:3000,http://localhost:3001"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.ai_cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.ai_engine_env == "production"

    @property
    def nestjs_signal_url(self) -> str:
        return f"{self.nestjs_api_base_url}{self.nestjs_ai_signal_endpoint}"

    @property
    def nestjs_market_data_url(self) -> str:
        return f"{self.nestjs_api_base_url}{self.nestjs_market_data_endpoint}"


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
