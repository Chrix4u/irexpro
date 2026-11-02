# Side-Selection Three-Class Research Results — 2026-11-02

## Objective
Predict whether the higher-ranked pre-entry side should be **KEEP**, **FLIP**, or **ABSTAIN** using only information available at decision time. Future first-hit outcomes define labels only. This research has no DEMO or LIVE authority.

## Dataset
- 18,016 resolved shadow decisions were available in the source scan history.
- Simultaneous BUY/SELL pairing produced 8,650 raw paired observations.
- De-overlap by instrument/outcome window produced 973 independent episodes (1,946 direction rows).
- Episode target classes: KEEP / FLIP / ABSTAIN.
- Validation is chronological with target-resolution purge; the final future holdout contains 250 episodes.

## Pairwise candidate model v2
The pairwise model represents each episode as the higher-ranked PRIMARY candidate, the OPPOSITE candidate, and their feature deltas.

Qualification / walk-forward aggregate:
- Balanced accuracy: 0.347 — FAIL (< 0.52)
- Total return: +6.886R
- Profit factor: 1.113 — FAIL (< 1.15)
- Sharpe: 0.521 — FAIL (< 1.0)
- Positive folds: 2/3 = 66.7% — PASS
- Positive instruments: 66.7% — borderline/pass at locked threshold
- Fold results were unstable: +15.575R, +2.860R, -11.549R.

Untouched 250-episode future holdout:
- Balanced accuracy: 0.363 — FAIL
- Actions: 35 / 250 (14.0%)
- Wins / losses: 17 / 18
- Total return: +8.312R
- Average return: +0.237R per action
- Profit factor: 1.436 — PASS
- Sharpe: 1.037 — PASS
- Max drawdown: 3.73% — PASS
- Positive instruments: 50.0% — FAIL

**Decision:** research-promising, not qualified for DEMO execution. The economics improved materially, but classification stability and instrument breadth are insufficient.

## Hierarchical TRADE/ABSTAIN → KEEP/FLIP experiment
A separate hierarchical experiment was evaluated and performed worse:
- Qualification balanced accuracy: 0.320
- Qualification PF: 0.893
- Qualification Sharpe: -0.679
- Qualification total: -10.813R
- Holdout balanced accuracy: 0.353
- Holdout PF: 0.872
- Holdout Sharpe: -0.526
- Holdout total: -7.52R

**Decision:** rejected. The experimental implementation is not retained in the shipping branch.

## Regime / data observations
The label distribution is not stationary. In particular, 2026-11-01 (Sunday reopening session) produced 22 ABSTAIN labels out of 24 episodes, while 2026-11-02 returned to a mixed KEEP/FLIP/ABSTAIN distribution. The current policy version (`cal2-m5tim1`) has only 125 independent paired episodes, so policy-specific promotion would be premature.

## Missing information and next research step
The first pairwise model contains rich governance, calibration, adaptive-market, exposure and expert-vote features, but it lacks explicit multi-bar price-action structure. A prospective, shadow-only `side-selection-pattern-telemetry-v1` artifact is therefore being added with:
- raw M5 momentum over 1/3/6 bars;
- EMA separation and slope;
- candle body/range/wick structure;
- body pressure, directional run and path efficiency;
- range expansion and breakout geometry;
- direction-aligned forms of the same signals;
- H1/H4 context already known at decision time.

The artifact is `executionAuthority=NONE` and `modifiesExecution=false`. It must accumulate prospective resolved episodes before the model is retrained and re-qualified. No automatic FLIP rule is authorized by this research.
