# iRexPro / z.ai P1 — post-protected-exit causal policy-grid feasibility check
Date: 2026-11-03. Research branch: `feat/zai-post-close-shadow-grid-20261103`.

**Research only. No broker orders, position management, risk settings, model authority, deployment or DB writes.**

## Hypothesis and exact scope

The z.ai review suggests P1, a proposed *50% scale-out near 1R and 2.5×ATR trailing-stop remainder*. The original post-close first-TP/SL counterfactual cannot evaluate that proposal, which starts **before** the actual protected exit. Before building a full entry-to-exit simulator, this feasibility grid asks the narrower, testable question:

> At the **actual** protected close, what if only 50% were closed at the actual exit outcome and the remaining 50% followed either the original TP/SL or an ATR-at-exit, non-widening stop with original TP?

This is **not a replay of a 1R partial scale-out from entry**, a production candidate, or a net-P&L backtest. It is a deliberately labeled intermediate research step.

Module: `scripts/research/zai-post-close-shadow-grid.cjs`; tests: `scripts/research/zai-post-close-shadow-grid.test.cjs`. 9/9 tests PASS on staging server's Node runtime after review; one additional test disallows counting a candle that does not fully end before the four-hour horizon. All functions are pure; no DB, order, adapter, config, timer or service imports. Research calculations use provided explicit OHLC data, independently extracted with read-only PostgreSQL queries.

Algorithm:
- Each trade provides its stored executed-trade entry/SL/TP geometry at close, real protected exit R and exit price, actual close timestamp, direction, strategy route and currency. Executed trade geometry must not be silently substituted with the original requested intent levels: those are different fields. Trade references never leave memory or the research process.
- Broker-native M1 candles only; full M1 begins after actual close minute, with continuity checks. First post-close bar skipped if a candle is missing; conflicting TP/stop same minute is AMBIGUOUS and excluded.
- Optional trailing stop distance is 2, 2.5 or 3 times the ATR14 computed from **15 fully completed consecutive M1 candles before close**. ATR is fixed as-of exit, and stop updates use only the **prior completed bar** for future minutes. SL cannot widen. Gapped stop fills use worse open where applicable.
- Hypothetical combined R = 50% × actual protected exit R + 50% × remaining exit R; the delta vs actual close is (1-0.5)×(hypothetical remaining R - actual R). Additional-cost sensitivity `0/0.05/0.10R` is an **assumed extra penalty on the combined trade**, not measured broker commission/spread.
- The code returns `DATA_GAP`, `NO_PREEXIT_ATR`, `AMBIGUOUS_SAME_M1`, `NEITHER_4H` or resolved, and aggregates **separately by account currency and strategy route**. It does not pick a winning configuration or authorize promotion.

## Staging verification

Read-only 76 protected cTrader DEMO trades from the 240-minute `profit-protection-counterfactual-v1` cohort, all EUR. Price series accessed from the same broker connection using `market_data.provider_quote_candles`. **Exact stored trade barrier replication: 76/76 matches** the previously persisted state (52 `TP_FIRST`, 20 `SL_FIRST`, 4 `DATA_GAP`).

**Independent verification (2026-11-04 09:53 UTC):** a new read-only staging recheck reproduced all 76 existing first-barrier states with the stored executed trade SL/TP. In **72/76** cases, at least one of the stored trade stop/target prices differed from the originally requested `trade_intents` geometry; substituting the intent prices matched only **69/76** states. Accordingly, this grid uses the trade-record geometry that generated the stored outcome, **not** an unverified claim about original broker order placement. These differences must be reconciled with broker fill/reconciliation history before entry-to-exit policy validation.

**All numbers below are mean hypothetical change in R vs actual protected exit, 50% closed at actual exit and 50% retained, gross/assumed-cost research only.**

| Route | n total | 50%-hold original TP/SL (n resolved), extra cost=0 | 50%-hold original with +0.05R penalty | 50%-hold ATR2.5 (n resolved), extra cost=0 | ATR2.5 with +0.05R penalty |
|---|---:|---:|---:|---:|---:|
| CONFIRMED_REVERSAL | 15 | **+0.369R** (14) | +0.319R | +0.165R (15) | +0.115R |
| EARLY_TRANSITION | 36 | **+0.209R** (36) | +0.159R | +0.029R (36) | **-0.021R** |
| TREND_CONTINUATION | 25 | **-0.047R** (22) | -0.097R | -0.006R (24) | **-0.056R** |

For additional +0.10R penalty: original / ATR2.5 changes were Confirmed Reversal +0.269/+0.065R; Early Transition +0.109/**-0.071R**; Trend Continuation -0.147/**-0.106R**.

**Interpretation:** P1's specific 2.5 ATR idea is not supported as a universally better policy from the observed after-close paths; a 50% *hold to original barrier* looks positive in some selected routes, but this is a hindsight selection sample of previously profitable/protected positions and omits the outcomes of trades that never reached a protected close. A large benefit here could evaporate under a true from-opening run. Trend Continuation remains especially fragile.

## Required next work (still no order behavior)

1. Construct an **entry-to-exit** counterfactual for *every eligible signal* including losses, not only protected winners. Persist initial stop and target at entry, strategy route, policy version, broker connection, original money risk and ATR snapshot (or derive ATR only from bars completed before entry). For intra-first-bar ambiguity, fail closed; do not presume optimistic hit ordering.
2. Compare existing baseline exit engine and a *pre-registered route-specific grid* including 1R partial-close + 2/2.5/3 ATR trail and hold-to-TP/SL. Use proper per-leg commissions, quote-side bid/ask, swaps, execution gap/latency, partial lots, broker min volumes and original risk-based sizing. Do **not** double-subtract spread from realized P&L.
3. Require 6+ months' independent observations, 6-fold purged walk-forward + 1-day embargo, untouched 20% holdout, DSR > 0, PBO <= 0.5, net-positive 1.5x P90 spread cost stress, >=4 weeks shadow, then DEMO A/B >=100 per arm or 8 weeks, whichever longer.
4. Keep existing LIVE/DEMO exits and risk controls unchanged until the complete validation succeeds. The research branch must never be merged to an execution-capable release merely to increase trade frequency.

## Reproduce tests

```bash
node --test scripts/research/zai-post-close-shadow-grid.test.cjs
```

Staging read-only result was produced with existing server Node/PostgreSQL client and the module in a temporary research directory. No account identifiers, credentials or raw trade rows are included in this committed report.
