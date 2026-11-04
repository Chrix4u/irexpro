# iRexPro causal commission-per-lot estimator (research only)

**Version:** `causal-commission-per-lot-shadow-v1`
**Verified against:** cTrader DEMO, 2026-11-04 11:33 UTC.

## Objective

The existing Plan-B spread-cost model `(1.25 × P90 spread)/stopDistance` does **not explicitly include broker commission**. The approved audit in PR #592 independently measured mean broker commission **0.202R** versus spread/slippage estimate **0.073R** over 157 complete trades.

This study tests whether *past* broker commission observations can predict *future* account-currency commission before an entry, without data leakage. It is **not** a trade admission, sizing or profitability change.

## Pure shadow function

`apps/api/scripts/research-causal-commission-estimator.cjs` exposes `commissionShadowAtEntry(candidate, history)` and `backtestCommissionShadow(trades)`. It does not read databases, call broker APIs, update orders, or alter execution settings. A caller supplies one **already owner-scoped broker account** as input; mixed accounts are rejected.

For each candidate, historical observations must:
- match the exact broker connection, account currency and instrument
- have positive lot size and recorded commission
- have **closed strictly before** the candidate's opening time
- have closed no earlier than seven days before that entry
- include at least five earlier completed trades

The prediction uses a **90th percentile** of those earlier values:

`predicted cash commission = candidate lots × P90(past absolute commission / past lots)`

`predicted commission R = predicted cash commission / candidate initial cash risk`

`shadow after-commission expected R = stored pre-existing expected net R − predicted commission R`

The stored expected net R already reflects the model's spread/slippage estimate; the additional term is specifically the separately charged commission, not a replacement for spread or a future observation. This prediction relies on cash-risk and commission conventions remaining consistent.

## Read-only historical validation

An independent user-and-connection-scoped, read-only SQL query collected 158 closed DEMO trades and the **pre-entry** capital-allocation risk. A pure chronological backtest applied the predictor. **128** trades had at least five prior same-pair/connection/currency completed fee samples.

| Pair | Covered | Mean forecast commission R | Mean actual commission R | MAE in R |
|---|---:|---:|---:|---:|
| AUDUSD | 49 | 0.1276 | 0.1266 | 0.0011 |
| USDCAD | 30 | 0.2531 | 0.2519 | 0.0013 |
| EURUSD | 21 | 0.2021 | 0.2014 | 0.0008 |
| USDJPY | 21 | 0.2856 | 0.2838 | 0.0018 |
| GBPUSD | 7 | 0.2424 | 0.2422 | 0.0004 |

This confirms low historical **commission estimation error**, **not** positive trading expectancy or a live broker fee guarantee. USDCHF did not have five earlier eligible observations in the sample. Price conversion, broker fee changes, round-trip versus per-side accounting and FX conversions require separate verification.

### Hypothetical threshold sensitivity — NOT approval

A diagnostic rule of **predicted net after commission < 0.08R** would flag **111 of 128 covered trades**. But **56 of those flagged trades actually closed with positive after-cost results** (55 negative). The other 17 trades at or above this floor included **10 after-cost winners** and **seven losers**.

A universal hard cost floor would block many observed winners, and this already-selected cohort cannot tell us what the market, account exposure, or alternative entries would have done. No hypothetical "saved losses" are recognized as realized improvements.

## Necessary validation before a DEMO policy change

1. Verify commission schedules directly from broker-native records or account specification, including per-side/round-trip treatment, lot scaling and account-currency conversion.
2. Collect prospective *frozen, entry-time* predictions with only completed earlier trades and exact risk denominators.
3. Stratify reliability and signal calibration by pair, route, volatility regime, session, confidence and cost burden; include positions rejected by existing gates as separate shadow examples.
4. Compare an all-in cost-adjusted entry threshold to the existing policy in chronological walk-forward out-of-sample data, including spread/slippage, commission, swaps, aborted trades, full exit results and opportunity cost.
5. Only if that study demonstrates sustained after-fee benefit with acceptable drawdown, propose a separately reviewed cTrader **DEMO** A/B experiment. Never bypass current safety/portfolio/lot/broker controls; **no LIVE rollout**.

## Regression suite

`jest src/modules/ai/causal-commission-shadow.spec.ts --runInBand`

Tests cover past-only chronology, overlapping positions, exact same-time closure exclusion, account/pair/currency isolation, P90 interpolation, stale records, minimum sample, invalid lot/risk, bounded inputs and absence of mutation.

**This commit is limited to a pure research estimator, unit tests and documentation.** It is not wired to a scheduler, execution gate, broker adapter or UI.
