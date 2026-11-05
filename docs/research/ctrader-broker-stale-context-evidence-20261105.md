# cTrader DEMO stale-context as-of evidence — 2026-11-05

## Actual incident

An ACTIVE cTrader DEMO FULL_AUTO session scanned three eligible pairs
(AUDUSD, EURUSD and GBPUSD) but broker entry authority remained zero.
Repeated broker-native context requests returned M5 bars last opened at
21:25 UTC and M15 bars last opened at 21:15 UTC while the clock had passed
22:00 UTC. The same cTrader connection reported CONNECTED; some one-minute
spot observations arrived. By approximately 22:08 UTC M5 had resumed with
22:00 UTC buckets, but M15 remained at 21:15 UTC at the 22:14 UTC check.

This is a provider-history freshness gap **in addition to** negative/invalid
model expectancy and non-admitted primary models. Fresh quotes, a connected
broker, and a running AI session are not evidence that all required
historical timeframes are current.

cTrader's historical GET_TRENDBARS_REQ uses the requested timeframe and
Unix-millisecond from/to timestamps; this client already passes the correct
period enum. A provider response can be delivered successfully yet contain
old completed bars. We must not call such data fresh.

## Scope of change

- For broker-native M1, M5, and M15 fail-closed readiness reasons, include
  a bounded, UTC-only `lastClosedAt`, the observed `ageMinutes`, and the
  already-enforced `maxAgeMinutes`. If no completed bar exists, use
  `lastClosedAt=UNAVAILABLE`, never a fabricated time.
- The trade page appends an easily readable **last verified close time** to
  the appropriate existing stale-market message. It ignores missing or
  invalid details and never alters the readiness or broker authority.
- No additional API calls, provider entitlements, order dispatches,
  model changes, automatic promotion, lot/risk gate changes, synthetic
  candles or broker credential handling.
- Neither changing the number of pairs nor clearing risk restrictions
  can substitute for real, timely broker-native M5/M15 bars.
- Fresh-context alerts resolve automatically only when genuinely fresh
  provider bars arrive and **all** independent risk/model gates pass.

## Verification

- Targeted API and trade-status UI Jest suites: 13 + 43 passed.
- Targeted API/web ESLint and full API/web TypeScript checks: passed.
- Read-only staging SQL verified actual broker history times; no positions
  were opened, accounts changed or broker sessions restarted by this work.

## Still open

The broker's M15 historical stream is behind the required freshness limit.
Do not bypass it or falsely label the app execution-ready. Investigate
official cTrader provider-native live trendbar subscription as a distinct
future solution only with strict source provenance and completion
verification; no resampled/synthetic context is approved here.
