"""Trusted source registry for advisory macro/event context."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

ContextSourceType = Literal[
    "CENTRAL_BANK",
    "OFFICIAL_STATISTICS",
    "ECONOMIC_CALENDAR",
    "FINANCIAL_NEWS",
]


class TrustedContextSource(BaseModel):
    """Governed source definition used before contextual evidence is accepted."""

    model_config = ConfigDict(frozen=True)

    source_id: str = Field(
        ...,
        min_length=2,
        max_length=80,
        pattern=r"^[a-z0-9][a-z0-9_-]+$",
    )
    display_name: str = Field(..., min_length=2, max_length=160)
    source_type: ContextSourceType
    currencies: set[str] = Field(..., min_length=1)
    credibility: float = Field(..., ge=0.0, le=1.0)
    enabled: bool = True
    requires_corroboration: bool = False
    independence_group: str | None = Field(
        default=None,
        min_length=2,
        max_length=80,
        pattern=r"^[a-z0-9][a-z0-9_-]+$",
    )

    @field_validator("display_name")
    @classmethod
    def display_name_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("display_name cannot be blank")
        return value

    @field_validator("currencies")
    @classmethod
    def normalize_currencies(cls, values: set[str]) -> set[str]:
        normalized = {value.strip().upper() for value in values}
        if any(len(value) != 3 or not value.isalpha() for value in normalized):
            raise ValueError("currencies must contain three-letter alphabetic codes")
        return normalized

    @property
    def independence_key(self) -> str:
        """Identity used when deciding whether corroborating sources are independent."""
        return (self.independence_group or self.source_id).casefold()


class TrustedContextSourceRegistry:
    """Immutable-by-interface lookup for explicitly approved context sources."""

    def __init__(self, sources: list[TrustedContextSource]) -> None:
        indexed: dict[str, TrustedContextSource] = {}
        for source in sources:
            key = source.source_id.casefold()
            if key in indexed:
                raise ValueError(f"duplicate trusted context source: {source.source_id}")
            indexed[key] = source
        self._sources = indexed

    def get(self, source_id: str) -> TrustedContextSource | None:
        return self._sources.get(source_id.strip().casefold())

    def enabled_for_currency(
        self,
        source_id: str,
        currency: str,
    ) -> TrustedContextSource | None:
        source = self.get(source_id)
        currency_code = currency.strip().upper()
        if source is None or not source.enabled or currency_code not in source.currencies:
            return None
        return source

    def list_enabled_for_currency(self, currency: str) -> list[TrustedContextSource]:
        currency_code = currency.strip().upper()
        return [
            source
            for source in self._sources.values()
            if source.enabled and currency_code in source.currencies
        ]


def default_trusted_source_registry() -> TrustedContextSourceRegistry:
    """Primary official sources for the six-major-pair research universe."""
    return TrustedContextSourceRegistry(
        [
            TrustedContextSource(
                source_id="federal_reserve",
                display_name="Federal Reserve",
                source_type="CENTRAL_BANK",
                currencies={"USD"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="us_bls",
                display_name="U.S. Bureau of Labor Statistics",
                source_type="OFFICIAL_STATISTICS",
                currencies={"USD"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="ecb",
                display_name="European Central Bank",
                source_type="CENTRAL_BANK",
                currencies={"EUR"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="eurostat",
                display_name="Eurostat",
                source_type="OFFICIAL_STATISTICS",
                currencies={"EUR"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="bank_of_england",
                display_name="Bank of England",
                source_type="CENTRAL_BANK",
                currencies={"GBP"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="uk_ons",
                display_name="UK Office for National Statistics",
                source_type="OFFICIAL_STATISTICS",
                currencies={"GBP"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="bank_of_japan",
                display_name="Bank of Japan",
                source_type="CENTRAL_BANK",
                currencies={"JPY"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="japan_statistics_bureau",
                display_name="Statistics Bureau of Japan",
                source_type="OFFICIAL_STATISTICS",
                currencies={"JPY"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="reserve_bank_of_australia",
                display_name="Reserve Bank of Australia",
                source_type="CENTRAL_BANK",
                currencies={"AUD"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="australian_bureau_statistics",
                display_name="Australian Bureau of Statistics",
                source_type="OFFICIAL_STATISTICS",
                currencies={"AUD"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="bank_of_canada",
                display_name="Bank of Canada",
                source_type="CENTRAL_BANK",
                currencies={"CAD"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="statistics_canada",
                display_name="Statistics Canada",
                source_type="OFFICIAL_STATISTICS",
                currencies={"CAD"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="swiss_national_bank",
                display_name="Swiss National Bank",
                source_type="CENTRAL_BANK",
                currencies={"CHF"},
                credibility=1.0,
            ),
            TrustedContextSource(
                source_id="swiss_federal_statistics",
                display_name="Swiss Federal Statistical Office",
                source_type="OFFICIAL_STATISTICS",
                currencies={"CHF"},
                credibility=1.0,
            ),
        ]
    )
