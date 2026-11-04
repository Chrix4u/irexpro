# Plan-B-admitted, M1-rejected timing counterfactual (read-only)

## Purpose

Investigate whether M1 entry-timing disagreements block promising Plan-B DEMO setups, without promoting a model, changing any trading gate, enabling a broker, or submitting orders. This observational audit fills a research gap: the existing M1 15-minute shadow-outcome store requires a non-`ABSTAIN` M1 route, so many Plan-B-admitted timing rejections have no comparable outcome.

Runner: `apps/api/scripts/audit-planb-m1-timing-counterfactual.cjs`.
The runner uses only `SELECT` statements in `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, requires the exact user-owned `ctrader` `DEMO` connection, and never logs account IDs or credentials. It is **manual only**; neither AI scheduling nor execution code imports it.

## Method and caveats

1. Read a bounded period of M1 decisions and select rows where the Plan-B ensemble is paper admitted but the multi-model authority records an M1 timing disagreement. The admission criteria are historical, not recalculated with future data.
2. Deduplicate same instrument, direction and Plan-B strategy route into episode leaders; gaps of five minutes or less remain part of the same episode.
3. For each leader with valid recorded stop/target geometry and nonnegative estimated execution cost, replay the repository's `evaluateM1CausalOutcome15m` using the first 15 **consecutive completed M1 broker-native quote candles beginning one minute after evaluation**. Reject rows with incomplete/untimestamped quote coverage; both TP and SL reached within a single bar is ambiguous.
4. Subtract the **recorded** execution-cost estimate once. This replay does not reproduce actual latency, slippage, intrabar order, provider fills, commissions not captured by the estimate, swaps, market impact or changing account risk. It does not establish a broker-executable strategy.
5. Preserve unobservable/ambiguous outcomes separately. Compare reasons, pair/side, Plan-B route and market regime; do not count individual minute decisions as independent trades. Audit results are research-only, never model qualification evidence.

Environment: run from `apps/api` with compiled `dist`, installed dependencies, and the same protected staging database environment used by the API. Set `VPS_FOREX_SCANNER_USER_ID`, `M1_TACTICAL_MARKET_DATA_CONNECTION_ID` (or `VPS_FOREX_SCANNER_BROKER_CONNECTION_ID`), and optionally `PLANB_M1_TIMING_AUDIT_SINCE` (ISO UTC). The default lookback is six hours, bounded to 72 hours. Command: `node scripts/audit-planb-m1-timing-counterfactual.cjs`.

## Initial staging observation — 2026-11-04 08:54 UTC

This is a **single, selected, retrospective research window**, not a validated result:

| Category | Episode leaders | Observable | Positive | Negative | Simulated net R |
| --- | ---: | ---: | ---: | ---: | ---: |
| All timing disagreements | 66 | 53 | 15 | 38 | −15.04 |
| Higher-timeframe conflict | 54 | 42 | 11 | 31 | −15.58 |
| No valid M1 route | 7 | 6 | 2 | 4 | +0.71 |
| M1 continuation vs Plan-B strategy | 3 | 3 | 1 | 2 | +0.17 |
| Direction edge too small | 2 | 2 | 1 | 1 | −0.35 |

Thirteen episodes had no complete causal quote evidence and were **unobservable**, not zero-profit trades. Most of the negative aggregate came from conflict episodes; this supports keeping M1 timing as a safety gate pending stronger evidence. It does **not** justify changing the gate or claiming out-of-sample profit from the smaller positive subgroups.

## Research acceptance before modifying trading authority

- Expand to non-overlapping prospective episodes across sessions and multiple regimes, separately by pair, side, route, volatility and spread.
- Compare *enter immediately after Plan-B admission* versus *wait for M1 confirmation* versus *abstain*, on identical causal market paths, after all realistically modeled costs.
- Include shadow-outcome selection coverage, data gaps, intrabar ambiguity, exposure constraints, data-source freshness and exact model versions.
- Use purged chronological folds and a fully untouched holdout. Publish number of independent episodes, profit factor, expectancy, drawdown, uncertainty bounds and performance by currency. Reject policies that merely increase the trade count.
- Keep all executable admission, drift, broker authorization, account-risk and SL/TP gates unchanged until a separately approved DEMO-only experiment passes its predeclared criteria.
