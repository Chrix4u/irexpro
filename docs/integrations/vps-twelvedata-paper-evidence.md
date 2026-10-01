# VPS-native six-pair PAPER evidence collector

Provider evidence key: **`vps-twelvedata-six-pair-v3`**.

Status: **PAPER evidence collection only.** This path does not grant DEMO or LIVE execution authority.

Version history:

- **v1** produced one genuine USDCAD candidate during activation, but the Risk Engine rejected it before execution because its ATR stop was 4.7 pips versus the 5-pip structural minimum.
- **v2** introduced the 5.1-pip candidate stop floor and produced genuine forward PAPER evidence while the live-feed execution path was being hardened. Its results remain historical evidence but are excluded from the qualification scorecard because execution semantics changed during that campaign.
- **v3** is the clean qualification stream. It began on **2026-10-01 09:56:45 UTC** with a fresh **10,000.00 USD** PAPER balance, zero open positions, zero committed AI capital and zero v3 evidence. The first scheduled v3 candidate executed at 10:00 UTC.

The 5.1-pip floor is the 5-pip platform minimum plus a 0.1-pip rounding buffer. The 2.5:1.5 target/stop ratio is preserved, and the Risk Engine remains independently authoritative.

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
- 500 bars requested per pair
- timezone: UTC
- cadence: every 10 minutes
- Monday–Friday only
- 21:00–23:59 UTC excluded deliberately for rollover / low-liquidity risk

A shared `demo` key is rejected for production evidence. The production collector requires a real account API key.

Twelve Data OHLC is treated as a market-data mid, not as an executable broker bid/ask. The PAPER broker applies a documented conservative fixed spread per pair around the latest fully closed M5 candle. This is a simulation assumption and must never be represented as broker-live execution evidence.

The same cached market data drives both strategy selection and PAPER fills/SL/TP evaluation so live-data signals are never executed against the historical replay feed. The live PAPER adapter claims the configured connection before startup priming; if the six-pair cache is unavailable, price reads fail closed rather than falling back to a single-instrument simulator.

### Closed-candle protection semantics

Every newly available fully closed M5 candle after a position opens is evaluated for protective exits using its **high/low**, not only its closing price. Twelve Data supplies mid OHLC, so the PAPER engine converts candle extremes to the relevant executable bid/ask side using the documented pair spread. This prevents a stop or target touched between 10-minute scanner polls from being missed.

If one M5 candle touches **both** stop loss and take profit, the intrabar ordering is unknowable from OHLC alone; the simulator therefore resolves the candle **SL-first**. This deliberately conservative rule prevents ambiguous candles from receiving favorable hindsight treatment.

On API restart, the scanner primes all six pairs and heartbeats every instrument immediately so restored positions are checked across any closed M5 bars that arrived during downtime.

### Basic-plan credit guard

One six-pair request consumes six symbol credits. The scanner caches the successful batch for the current UTC minute and reuses it if another internal collection path runs during that minute, preventing a startup-prime plus scheduled scan from spending 12 credits and exceeding an 8-credit/minute Basic allowance.

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

## v3 qualification boundary

The v3 scorecard is keyed only by `vps-twelvedata-six-pair-v3`; v1/v2 trades cannot contribute to its signal, execution, closed-trade or performance counts. Historical durable trades are retained for audit rather than deleted.

The underlying PAPER account still enforces same-day account safety across versions. In particular, PAPER/DEMO daily-loss checks use exact realised P&L scoped to the logical broker account and USD currency, while the v3 session opening balance is 10,000.00 USD. This conservative safety carry-over does **not** enter the v3 provider-performance scorecard.

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

### Scorecard economics

- **Balanced accuracy** compares the submitted BUY/SELL direction with fill-to-exit price direction on closed trades; flat exits are excluded.
- **Profit Factor** is conventional gross realised USD profit divided by gross realised USD loss. Broker-required margin is not used as the PF denominator.
- **Evidence Sharpe** is `sqrt(N) × mean / sample SD` of per-trade account returns, where each return is realised P&L divided by that trade's session opening balance. It is deliberately labelled evidence-window Sharpe and is not annualized.
- **Max drawdown** is peak-to-trough drawdown from authoritative PAPER account equity snapshots beginning with the provider campaign's first bound session. This includes unrealised equity movement and fails closed if snapshot evidence is unavailable.
- **Positive weeks** and **positive pairs** use summed per-trade account returns; the pair denominator remains the fixed six-pair universe.

These definitions intentionally avoid normalizing performance by broker margin. Margin is a capital-allocation/execution constraint, not the account equity base against which strategy drawdown should be judged.

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
