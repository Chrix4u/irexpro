# cTrader H1 broker-context refresh cadence — 2026-11-05

## Why investigate

The user reports no new cTrader DEMO trades despite a live `FULL_AUTO` session since **13:05:33 UTC**, and the separately deployed entry-liveness funnel shows frequent Plan B and OOD denials. The scanner and trade execution adapter are not proven faulty: M1 records updated continuously, broker binding was present, but no candidate earned broker order authority.

A **read-only** staging quote-candle investigation at approximately 20:09 UTC found current M1 and completed M5/M15 bars for AUDUSD/EURUSD/GBPUSD but the latest persisted **H1** for EURUSD/GBPUSD was `18:00`. The most recently completed H1 bar, with `bucket_time 19:00`, had closed at 20:00, so this represents up to roughly 10 minutes of archive-update delay after the hour. By 20:11, all three pairs had `19:00` H1 bars stored; the delay **resolved without intervention**. The H4 `14:00` bar was expected: `18:00`–`22:00` H4 was still forming and must not be synthesized.

### Traced exact live data dependency

`M1TacticalSchedulerService.processInstrument` consumes the **broker-native** `M1TacticalMarketDataService.loadSnapshot`. This loads M1/M5/M15/H1/H4 via `ProviderQuoteCandleStoreService.getCandles` and then computes multi-timeframe agreement using H1/H4 in `buildM1TacticalFeatures`. M1/M5/M15 freshness is already enforced and stale sources fail closed. No separate H1 age veto is added in this patch, because it would reject even more trades without proving its benefit.

The broker-native cTrader collector `CTraderQuoteCollectorService` has a **15-second** configured historical collection cycle, with **three M1 + one context** request per cycle, and a separately scheduled live bid/ask quote stream. It uses six rotating instruments. The former eight-slot context rotation `M5,M15,M5,M15,M5,M15,H1,H4` provides one H1 request/pair per **48 collection slots = 12 minutes** and one H4 per pair per 12 minutes. This is compatible with the observed hourly latency.

### Technical adjustment (no increased request budget)

A new 16-slot context cycle retains **six M5 and six M15 slots** (the exact existing 37.5% share for each), rebalances the remaining slots to **three H1 and one H4**. As each timeframe has an independent instrument cursor:

| Timeframe | Previous requests per pair/96 cycles | New requests per pair/96 cycles | Nominal revisit (staging 15s cycle) |
|---|---:|---:|---:|
| M5 | 6 | 6 | ≤4 minutes |
| M15 | 6 | 6 | ≤4 minutes |
| H1 | 2 | **3** | ≤8 minutes |
| H4 | 2 | **1** | ≤24 minutes |

The H4 refresh remains comfortably within its 4-hour period. M1 remains exactly three requests per cycle, live spread quote sampling runs independently, and the provider budget remains four historical requests per cycle; no additional cTrader subscription or paid service.

The H1 bar may still lag when the **broker itself returns stale historical data**, the request fails, or a context tick arrives after the completed H1 boundary. This is a freshness improvement, **not a guarantee of trade execution**. No fabricated broker candles, backdating, market-data authority fallback, model drift-envelope relaxation, lot-size/risk gate removal, trading-session reset or broker order dispatch added.

### Tests

An extended collector regression runs **96 simulated 15-second collection cycles** and asserts exact 384 historical calls (288 M1 + 96 context), 96×6 separate live-quote calls, equal M5/M15 requests, H1 within 32 slots/pair, H4 6-pair coverage, and preserved one context call/cycle. Existing quote-store authority/market readiness tests are included. TypeScript, eslint, prettier and diff checks also run.

### Next step toward a profitable DEMO session

Data freshness is one prerequisite, not sufficient trading authorization. Keep the explicit demo three-pair restriction, risk/recent-loss vetoes and broker fee gate. Continue independent shadow review by strategy/pair; promote a real execution candidate only on demonstrated after-commission economic benefit and bounded drawdown. The 0.20 preferred lot and up-to-4.00 allowed size remain unchanged.
