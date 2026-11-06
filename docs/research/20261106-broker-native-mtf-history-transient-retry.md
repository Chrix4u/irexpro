# cTrader DEMO broker-native multi-timeframe history: bounded transient retry
6 November 2026 — shadow scorer reliability only

The active cTrader DEMO session has repeatedly scored the separate
high-conviction expert as UNAVAILABLE with
BROKER_MARKET_DATA_UNAVAILABLE, even while the main M1 scanner continues
with fresh prices. A direct same-account check also found the internal
OHLCV endpoint returning HTTP 200 and broker-native history for all
M1/M5/M15/H1/H4 timeframes. This does not prove every failure is
transient, but a single temporary transport failure can currently drop
the entire multi-timeframe score.

The broker provider now retries a read-only internal OHLCV GET at most
ONCE after HTTP 502/503/504, timeout or transport failure. It keeps
the request bound to the original internal API host, user, connection,
symbol, timeframe, credentials and limit. The first attempt keeps the
original 15-second timeout; the retry is capped at three seconds, with
a 100-ms async delay. No retry occurs on 400/401/403/404/429 or an
invalid JSON/candle payload, and the provider never logs credentials.
Paper simulator advanceSimulation=true requests are NOT retried
because they might advance state. There is no broker order sent from
this provider.

Source validation is unchanged: the original OHLCV service rejects
insufficient bars, duplicate/future bars, mixed provenance, invalid
spread evidence and stale broker candles. Failed retry still returns a
MarketDataError and leaves the trained expert unavailable; it does not
fall back to historical, synthetic or relaxed timestamps. No live
ensemble weights, lot sizes, DEMO phase, commission gate, stop/TP,
risk or broker-execution authority changed.

Tests cover 503 then successful broker bars, timeouts recovered,
503 exhaustion, 400/401/403/404/429 no retry, and simulator 503
one call only. VPS standard-library mock smoke successfully checked
503 recovery, simulator nonreplay and access-denied nonretry.
The full Python test suite is required to pass in CI before merge.

This is a bounded reliability improvement, not evidence of profitable
entry signals or permission to weaken a rejected setup.
