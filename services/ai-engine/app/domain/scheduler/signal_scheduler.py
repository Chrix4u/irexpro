"""
SignalScheduler — paper-mode scheduled signal generation.

IMPORTANT:
- Disabled by default (AI_SCHEDULER_ENABLED=false)
- Paper mode only — no live trading approval
- Generates signal candidates and publishes via NestJsClient
- Never executes trades directly
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.core.config import get_settings
from app.core.logging import get_logger
from app.domain.market_data.ohlcv_service import OHLCVService
from app.domain.models.registry import ModelRegistry
from app.domain.scheduler.schemas import SessionStartRequest
from app.domain.signals.signal_generator import SignalGenerator
from app.integrations.nestjs_client import NestJsClient

logger = get_logger(__name__)

MarketDataSource = Literal["mock", "broker"]


@dataclass
class ScheduledSessionJob:
    trading_session_id: str
    user_id: str
    broker_connection_id: str
    instruments: list[str]
    timeframes: list[str]
    source: MarketDataSource
    interval_seconds: int
    execution_mode: str
    active: bool = True
    last_run_at: datetime | None = None
    last_publish_failed: bool = False
    scan_count: int = 0
    last_decision: str = "WAITING_FOR_FIRST_SCAN"
    last_reason: str | None = "Waiting for the first scheduled market scan"
    last_instrument: str | None = None
    last_timeframe: str | None = None
    last_confidence_score: float | None = None
    confidence_threshold: float | None = None
    last_signal_id: str | None = None
    registered_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class SignalScheduler:
    """
    Manages per-session scheduled signal generation jobs.
    One job per tradingSessionId — duplicates are rejected.
    """

    def __init__(
        self,
        signal_generator: SignalGenerator | None = None,
        nestjs_client: NestJsClient | None = None,
    ) -> None:
        self._settings = get_settings()
        self._scheduler = AsyncIOScheduler()
        self._jobs: dict[str, ScheduledSessionJob] = {}
        self._signal_generator = signal_generator
        self._nestjs_client = nestjs_client or NestJsClient()
        self._started = False

    @property
    def is_enabled(self) -> bool:
        return self._settings.ai_scheduler_enabled

    def start(self) -> None:
        if not self.is_enabled or self._started:
            return
        self._scheduler.start()
        self._started = True
        logger.info("Signal scheduler started", enabled=True)

    def shutdown(self) -> None:
        if self._started:
            self._scheduler.shutdown(wait=False)
            self._started = False
        self._jobs.clear()
        logger.info("Signal scheduler stopped")

    def register_session(self, request: SessionStartRequest) -> bool:
        if not self.is_enabled:
            logger.info("Scheduler disabled — session registration skipped")
            return False

        settings = get_settings()
        # Round 5 (session authority): the request carries the TradingSession's
        # durable executionMode ("paper" = legacy API value). Scheduled signal
        # generation itself stays paper-only — the risk + execution gates in
        # the API own the enforcement boundary for SEMI_AUTO / FULL_AUTO.
        if request.mode not in ("paper", "PAPER_ONLY", "SEMI_AUTO", "FULL_AUTO"):
            logger.warning("Unsupported scheduler mode", mode=request.mode)
            return False

        if request.source == "mock" and settings.is_production and not settings.ai_allow_mock_market_data:
            logger.warning("Mock source blocked in production for scheduler")
            return False

        session_id = request.trading_session_id
        if session_id in self._jobs:
            logger.info(
                "Reconciling existing scheduler job",
                trading_session_id=session_id,
            )
            self.unregister_session(session_id)

        interval = request.interval_seconds or settings.ai_signal_interval_seconds
        timeframes = request.timeframes or [request.timeframe]
        job = ScheduledSessionJob(
            trading_session_id=session_id,
            user_id=request.user_id,
            broker_connection_id=request.broker_connection_id,
            instruments=[i.upper() for i in request.instruments],
            timeframes=[t.upper() for t in timeframes],
            source=request.source,
            interval_seconds=interval,
            execution_mode=request.mode,
        )
        self._jobs[session_id] = job

        if not self._started:
            self.start()

        self._scheduler.add_job(
            self._run_session_job,
            trigger=IntervalTrigger(seconds=interval),
            id=f"signal-{session_id}",
            args=[session_id],
            replace_existing=True,
        )

        logger.info(
            "Scheduler job registered",
            trading_session_id=session_id,
            interval_seconds=interval,
            source=request.source,
        )
        return True

    def unregister_session(self, trading_session_id: str) -> bool:
        job = self._jobs.pop(trading_session_id, None)
        if job:
            job.active = False
        try:
            self._scheduler.remove_job(f"signal-{trading_session_id}")
        except Exception:
            pass
        logger.info("Scheduler job unregistered", trading_session_id=trading_session_id)
        return job is not None

    def get_session_job(self, trading_session_id: str) -> ScheduledSessionJob | None:
        return self._jobs.get(trading_session_id)

    @property
    def is_running(self) -> bool:
        return self._started

    def next_run_at(self, trading_session_id: str) -> datetime | None:
        if not self._started:
            return None
        scheduled = self._scheduler.get_job(f"signal-{trading_session_id}")
        return scheduled.next_run_time if scheduled else None

    def _get_signal_generator(self) -> SignalGenerator:
        if self._signal_generator is not None:
            return self._signal_generator
        from app.main import app_state

        registry: ModelRegistry = app_state["registry"]
        cache_client = app_state.get("redis")
        from app.domain.market_data.redis_cache import OHLCVRedisCache

        ohlcv_service = OHLCVService(cache=OHLCVRedisCache(redis_client=cache_client))
        self._signal_generator = SignalGenerator(ohlcv_service, registry)
        return self._signal_generator

    async def _run_session_job(self, trading_session_id: str) -> None:
        job = self._jobs.get(trading_session_id)
        if not job or not job.active:
            return

        if job.last_publish_failed:
            job.last_publish_failed = False
            logger.info(
                "Skipping scheduler cycle after publish failure",
                trading_session_id=trading_session_id,
            )
            return

        settings = get_settings()
        if settings.ai_signal_mode != "paper":
            logger.warning("Scheduler only supports paper mode")
            return

        generator = self._get_signal_generator()

        if job.execution_mode == "FULL_AUTO":
            from app.main import app_state

            registry: ModelRegistry = app_state["registry"]
            active_model = registry.get_active_model()
            governance = registry.get_governance(active_model.get_model_version())
            if not governance.approved_for_live:
                job.last_run_at = datetime.now(UTC)
                job.last_decision = "LIVE_MODEL_BLOCKED"
                job.last_reason = (
                    f"Model {active_model.get_model_version()} is not approved for live trading"
                )
                job.last_confidence_score = None
                job.confidence_threshold = None
                logger.warning(
                    "Live scheduler cycle blocked by model governance",
                    trading_session_id=trading_session_id,
                    model_version=active_model.get_model_version(),
                )
                return

        for instrument in job.instruments:
            for timeframe in job.timeframes:
                try:
                    result = await generator.generate(
                        user_id=job.user_id,
                        trading_session_id=job.trading_session_id,
                        broker_connection_id=job.broker_connection_id,
                        instrument=instrument,
                        timeframe=timeframe,
                        source=job.source,
                    )

                    job.last_run_at = datetime.now(UTC)
                    job.scan_count += 1
                    job.last_instrument = instrument
                    job.last_timeframe = timeframe

                    if not result.generated or result.signal is None:
                        job.last_decision = "NO_SIGNAL"
                        job.last_reason = (
                            result.no_signal.reason if result.no_signal else "no_signal"
                        )
                        job.last_confidence_score = (
                            result.no_signal.confidence_score if result.no_signal else None
                        )
                        job.confidence_threshold = (
                            result.no_signal.threshold if result.no_signal else None
                        )
                        job.last_signal_id = None
                        logger.debug(
                            "No signal to publish",
                            trading_session_id=trading_session_id,
                            instrument=instrument,
                            timeframe=timeframe,
                            reason=job.last_reason,
                        )
                        continue

                    await self._nestjs_client.publish_signal(result.signal)
                    job.last_publish_failed = False
                    job.last_decision = "SIGNAL_PUBLISHED"
                    job.last_reason = "Signal passed model confidence gate and was published"
                    job.last_confidence_score = result.signal.confidence_score
                    job.confidence_threshold = None
                    job.last_signal_id = result.signal.signal_id
                except Exception as e:
                    job.last_run_at = datetime.now(UTC)
                    job.scan_count += 1
                    job.last_publish_failed = True
                    job.last_decision = "ERROR"
                    job.last_reason = str(e)
                    job.last_instrument = instrument
                    job.last_timeframe = timeframe
                    logger.warning(
                        "Scheduled signal generation failed",
                        trading_session_id=trading_session_id,
                        instrument=instrument,
                        timeframe=timeframe,
                        error=str(e),
                    )
