# Execution Spread Observation Count Design

## Intent
Remove the artificial ten-minute warm-up in broker-observed execution-spread evidence without weakening freshness or stale-market protection.

## Current State
`loadExecutionSpreadEvidence()` reads live spread data from `market_data.provider_quote_candles`. Each M1 row stores an accumulated `sample_count`, but the evidence query reports `COUNT(*)`, so governance interprets ten M1 buckets as ten samples. `ENSEMBLE_EXECUTION_SPREAD_MIN_SAMPLES=10` therefore requires roughly ten minutes even when the quote collector has already observed hundreds of live quotes.

The cTrader Friday-close evidence confirms why freshness must remain authoritative: the collector continues sampling the broker's last quote, increasing the stored row's `sample_count`, while `last_sample_at` remains the provider's stale 16:29:59 timestamp. Governance already rejects evidence older than five minutes.

## Chosen Behavior
- In the 30-minute positive-spread CTE, include each row's `sample_count`.
- Report `sample_count` as the sum of those live quote observations, not the number of M1 rows.
- Keep P90 spread calculation, positive-spread filtering, 30-minute lookback, and `latest_sample_at` unchanged.
- Keep the five-minute freshness veto and all governance thresholds unchanged.

## Safety
A stale or closed broker market remains blocked even if an old M1 row has a very large accumulated sample count, because the existing latest-provider-timestamp freshness gate remains mandatory.
