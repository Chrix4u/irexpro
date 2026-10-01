# VPS-native six-pair PAPER evidence collector

Provider evidence key: **`vps-twelvedata-six-pair-v1`**.

Status: **PAPER evidence collection only.** This path does not grant DEMO or LIVE execution authority.

## Purpose

This replaces TradingView webhook transport as the default evidence-collection path. TradingView remains an optional integration, but iRexPro does not require a paid TradingView plan.

The VPS collector reads fully closed M5 forex candles for:

- EURUSD
- GBPUSD
- USDJPY
- AUDUSD
- USDCAD
- USDCHF

It ranks deterministic trend candidates, sends at most the strongest qualifying candidate per scan through the normal `AiSignalService → StrategyOrchestrator → Risk → Execution` pipeline, and records provider performance under a versioned evidence stream.

The rule is an **evidence collector, not a qualified trading edge**. It cannot bypass iRexPro's promotion gates.

## Market data

The collector uses Twelve Data's `/time_series` endpoint with one batched six-symbol request:

- timeframe: M5
- only fully closed candles
- 70 bars requested per pair
- timezone: UTC
- cadence: every 10 minutes
- Monday–Friday only
- 21:00–23:59 UTC excluded deliberately for rollover / low-liquidity risk

A shared `demo` key is rejected for production evidence. The production collector requires a real account API key.

Twelve Data OHLC is treated as a market-data mid, not as an executable broker bid/ask. The PAPER broker applies a documented conservative fixed spread per pair around the latest fully closed M5 candle. This is a simulation assumption and must never be represented as broker-live execution evidence.

The same cached market data drives both strategy selection and PAPER fills/SL/TP evaluation so live-data signals are never executed against the historical replay feed.

## Required server configuration

Keep secrets in `apps/api/.env`; never expose the API key to the browser or commit it to Git.

```env
VPS_FOREX_SCANNER_ENABLED=true
TWELVEDATA_API_KEY=<server-secret>
VPS_FOREX_SCANNER_USER_ID=<user UUID>
VPS_FOREX_SCANNER_BROKER_CONNECTION_ID=<paper-broker connection UUID>
```

The scanner fails closed unless all four values are valid. `TWELVEDATA_API_KEY=demo` is explicitly rejected when enabled.

## Authority isolation

When this scanner owns an exact user + paper connection binding:

1. scanner startup stops any already-registered legacy Python AI scheduler job for the active session;
2. future starts of that exact PAPER session skip legacy scheduler registration;
3. every scanner signal is still tagged `EXTERNAL_PROVIDER` + `external_provider_paper_only=true`;
4. StrategyOrchestrator therefore requires the exact internal `paper-broker` DEMO session in `PAPER_ONLY` mode;
5. automatic DEMO and LIVE promotion remain disabled.

Other users and broker connections keep the existing AI scheduler behavior.

## Evidence gates

Provider results are read from the durable signal → intent → allocation → trade lineage. DEMO review eligibility still requires all configured gates, including:

- balanced accuracy ≥ 0.52
- evidence-window Sharpe ≥ 1.0
- profit factor ≥ 1.15
- max drawdown ≤ 12%
- positive weekly-window fraction ≥ 60%
- positive six-pair fraction ≥ 67%
- minimum submitted confidence ≥ 60%
- at least 100 closed PAPER trades
- median signal interval ≤ 10 minutes

Passing every gate only makes the provider eligible for a separate DEMO review. It never auto-promotes to DEMO or LIVE.

## Status endpoint

Authenticated clients can read:

`GET /api/v1/ai/external/vps-forex/status`

Possible states:

- `WAITING_FOR_CONFIGURATION`
- `DISABLED`
- `WAITING_FOR_PAPER_SESSION`
- `WAITING_FOR_MARKET_DATA`
- `ACTIVE`

The response never contains the Twelve Data API key, bound user id, or broker connection id.
