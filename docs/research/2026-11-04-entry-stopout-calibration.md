# iRexPro: entry-time signal confidence versus subsequent stop-loss and net returns

**Research artifact:** `entry-stopout-calibration-shadow-v1`
**Read-only staging observation:** 2026-11-04 12:22 UTC, cTrader DEMO account.

## Motivation

The last seven days of DEMO data yielded **158 closed trades** and **−€359.26 net** on complete recorded costs. 47 positions closed via `STOP_LOSS_HIT` (−€506.58 net in aggregate). Existing `AI_CLOSE_SIGNAL` closes and round-trip commissions are another drag. Confidence alone must not justify higher lot sizes or automatic authorization when observed after-cost expectancy is negative.

This pure research module uses *entry-time* metadata already recorded on the original trade intent: `confidenceScore`, `feature_extension_atr`, `marketRegime`, `multimodel_plan_b_route`, and `m1_net_expected_r`. It compares those with the *subsequent* broker-reconciled close reason and net realized R, using pre-entry `sizing_inputs.finalRiskAtStop` as the denominator. Source trades were read with an account/user-scoped, bounded PostgreSQL `READ ONLY` transaction. The module itself is pure and has **no database, risk policy or broker execution dependency**.

## Reproducible study method

- Normalize `realised_pnl − abs(commission) + swap` into R using pre-entry recorded cash risk. Missing or non-positive cash risk, missing gross P&L/commission/swap, invalid times, direction or instrument are *invalid*, never silently zero-filled.
- A stop-out label is only `STOP_LOSS_HIT`, not every negative trade. Other close reasons remain distinct.
- Group by currency, route, pair/side, engine, market regime, exit reason and fixed descriptive **confidence bins**: below 0.60, 0.60–0.69, 0.70 and above. Also fixed extension bins: below 0.75 ATR, 0.75–1.25 ATR, above 1.25 ATR.
- Sort by original trade opening time. The first approximately 70% is training/descriptive; the remainder is later holdout. Require early positions to have closed by the training cutoff, and exclude overlapping positions and a **60-minute purge** after the boundary. This does **not** remove all portfolio dependencies or regime imbalance.
- Calculate Wilson 95% intervals for stop-out proportions. Do not infer a reliable rule from tiny cells. A group must contain at least 10 research-training examples just to appear as a train-to-holdout comparison, and every comparison is explicitly `eligibleForExecution=false`.
- Never infer profitable opportunities among trades that existing gates rejected; this only covers orders executed and subsequently closed.

## Seven-day DEMO findings

| Cohort | Trades | Stop-outs | Mean after-fee R |
|---|---:|---:|---:|
| All complete | 157 | 47 (29.9%; Wilson interval 23.3–37.5%) | −0.296 |
| Earlier training set | 107 | — | — |
| Later holdout set | 47 | — | — |

Three records around the chronological boundary were excluded as crossing the train boundary or purged.

### Route results across the chronological split

| Route | Early training trades | Early stop-outs | Earlier mean net R | Later holdout trades | Later stop-outs | Later mean net R |
|---|---:|---:|---:|---:|---:|---:|
| Early transition | 57 | 21 | −0.223 | 10 | 0 | **−0.775** |
| Confirmed reversal | 23 | 12 | −0.441 | 11 | 0 | −0.045 |
| Trend continuation | 27 | 12 | −0.386 | 26 | 1 | −0.085 |

**Key discovery:** All **10 later early-transition trades lost money after recorded costs**, although **none closed via a full stop-loss**. This is evidence that early-transition deterioration also involves earlier exit decisions and payoff geometry; a stop-out-only label cannot detect all unprofitable positions.

Another important finding is **strong distribution shift**: training stop-loss frequencies are much higher than those in the later period. A threshold fitted on earlier stop-out data could badly misclassify later signals. The later samples are too small and too close in time to prove the effectiveness of any new entry filter.

### Confidence stratification is not a promotion policy

Within trend continuation, the >=0.70 confidence bin had 10 earlier trades, eight stop-outs and mean −0.993R, versus later 11 trades, one stop-out and mean −0.247R. The 0.60–0.69 bin had 17 earlier trades, four stop-outs and mean −0.030R; later eight trades, zero stop-outs and mean +0.043R.

**Do not interpret this as "lower confidence is safer."** These confidence scores originate from different engines and routes and can be on incompatible calibration scales; the sample sizes are very small. Conditioning on an accepted trade also introduces selection bias, and market conditions changed between periods.

## Technical implementation and safety

- Pure functions in `apps/api/scripts/research-entry-stopout-calibration.cjs`.
- Jest coverage in `apps/api/src/modules/ai/entry-stopout-calibration-research.spec.ts`: fixed bins, cash-risk and fee completeness, close chronology, overlapping-position purge, currency grouping, Wilson intervals, min-size comparisons, and no mutation.
- The module has no scheduler, service injection, database reader, broker adapter, file writer, feature-flag or position order code. No risk brakes or model admission thresholds are changed.
- A user-scoped read-only data export is needed to rerun it; never pass unscoped multi-user trades or any broker credentials. Do not log trade IDs or account identifiers.

## Next research gates

1. Collect a **larger prospective sample** with frozen signal probability, risk and spread/commission estimates at entry, including rejected setup shadow outcomes.
2. Compare expected versus observed after-cost R **within each engine** rather than mix confidence scales. Account for session, volatility, source-timestamp freshness, pair/side, and market regime, with session-separated/purged walk-forward validation.
3. Investigate *why* the later early-transition trades all lost: time of closure, signal sign flip, spread/fee giveback, and stop/target location. Compare to similar untraded alternatives; do not use realized outcomes to make a contemporaneous claim.
4. Build independent holdouts across market weeks and multiple broker settings. Require after-cost net expectancy, drawdown and positive cross-pair results under the promotion gates before any **separate DEMO** policy experiment. LIVE remains disabled.

The purpose is to avoid the false impression that simply forcing more trades or raising volume creates profitability. The evidence currently supports **continued careful research**, not promises of guaranteed returns.
