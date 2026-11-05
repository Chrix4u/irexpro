# cTrader DEMO OOD independent-regime outcome audit — 2026-11-05

## Purpose and safety boundary

The already deployed OOD collector captures which feature envelopes a proposed
M1 trade falls outside, but its `dominant_ood_dimensions` counts all persisted
signals, including multiple evaluations on nearby bars. Such counts do not
measure independently executable opportunities or support auto-promoting a model.

This change adds `independent_ood_condition_outcomes` to the existing, private
research JSON output. It **does not** change trading execution, admission,
risk gates, broker connections, commission calculations, model weights,
account sessions, or trade settings. Output remains research-only.

## Method

- Input is the same account-scoped, read-only SQL cohort and the same
  independently sampled broker-native bid/ask quotes as the existing OOD study.
- Select the earliest observation per pair, strictly more than 15 minutes apart,
  across both routes and both BUY/SELL directions. Future outcomes **never**
  influence selection.
- Report the independent opportunity count, covered UTC days, aggregate and
  per-route outcomes, then each known OOD dimension's count, pair distribution,
  mean 15-minute spread-inclusive price proxy after an extra estimated 1 pip,
  and positive fraction. Unknown tags are not echoed.
- Multiple OOD dimensions may describe the same selected observation:
  dimension counts must not be summed into trade counts.
- Pairs remain correlated, the fixed-horizon proxy omits actual broker fills,
  stop/TP behavior and verified round-trip commission, and there is no
  statistical test or claim of profitability.

## Initial snapshot (Thursday 2026-11-05, approximately 21:40 UTC)

The verified OOD cohort had **2,472** decisions over **3 UTC days**. The new
earliest-per-pair 15-minute de-overlap retains **382** observations. Their mean
15-minute price proxy was **−1.2613 pips** after the provisional extra friction.

| OOD condition | Non-overlapping observations | Mean 15m proxy |
|---|---:|---:|
| extensionAtr:HARD_HIGH | 261 | −0.8858 pips |
| emaSeparation:HARD_HIGH | 127 | −1.4307 pips |
| emaSeparation:HARD_LOW | 108 | −1.6537 pips |
| directionalMomentumAtr:HARD_HIGH | 70 | −1.2371 pips |
| mtfStrength:HARD_HIGH | 60 | −1.8917 pips |
| rsi14:HARD_HIGH | 30 | −3.8133 pips |

These conditions can overlap; they are not six independent datasets.
The study continues to **block model fitting** until at least 12 qualified
multi-pair trading days and other holdout requirements are met. Even a later
research-only fit cannot promote itself to paper, DEMO or LIVE.

## Validation

- Synthetic overlap test covers two directions, two routes, independent pairs,
  and a subsequent 16-minute-separated opportunity.
- Arbitrary untrusted condition tags cannot enter the report.
- All 14 targeted existing/new pytest tests passed on a disposable test runner
  (one warning because the production environment omits pytest-asyncio);
  Python syntax and `git diff --check` passed.
- A real snapshot produced the expected bounded, anonymous report with
  `model_fitted=false` and `promotion_allowed=false`.

Next: continue collecting separate market days; then evaluate purged,
out-of-time performance and **actual after-commission broker economics**
before contemplating a new execution-eligible model. This new summary is
only an aid to diagnosis and research prioritization.
