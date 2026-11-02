# Side Selection Three-Class v1 Design

## Goal
Build a research-only KEEP / FLIP / ABSTAIN classifier that learns from iRexPro's resolved shadow opportunities without changing DEMO execution.

## Target semantics
Pair BUY and SELL shadow decisions only when instrument, market_bar_time and policy version match, and both were generated within the same decision episode. For each direction-conditioned row:
- KEEP: the candidate first-hit outcome is WIN.
- FLIP: the candidate is LOSS and its simultaneously generated opposite-side shadow is WIN.
- ABSTAIN: the candidate and simultaneous opposite-side shadow are both LOSS.
- UNRESOLVED: either paired outcome is missing, expired, ambiguous, wrong-version, or invalid; exclude from training.

Resolved outcomes are target construction only. Predictors must be values persisted at or before evaluated_at. The opposite-side decision itself is not a predictor; only the label may use its future-resolved outcome.

## Dataset scope
- Source: `trading.ensemble_shadow_decisions` for the configured scanner paper connection and active engine.
- Default lookback: 14 days.
- Include both current Plan-B policy versions as categorical context; report results separately for the newest `cal2-m5tim1` policy.
- Require existing outcome version `m5-first-hit-72bar-side-aware-v4` on both simultaneous sides.
- Pair by instrument + market_bar_time + policy version; choose the earliest observation per side when duplicate scans exist.
- De-overlap at instrument level: after accepting a paired episode, skip later market bars until both paired outcomes have resolved.

## Pre-entry feature families
Numeric: candidate/direction/trade/exit/pair/session/portfolio quality, portfolio risk and counts, MTF strength, EMA separation, extension ATR, RSI, volatility, short-horizon momentum, governance gross/net expected R and cost R, adaptive edge/net R/risk multiplier/ranks, calibration directional probabilities/edge/win probability/net R/sample count, trained-expert confidence/opportunity probability/votes.

Categorical: instrument, candidate direction, strategy route, pair-side route, policy version, drift state, event risk, sleeve state, adaptive market state/evidence class, trained-expert state/direction, calibration conflict state/reason/raw preferred direction.

Explicitly prohibited predictors: realized P&L, close reason, MFE, MAE, resolved outcome fields, post-entry telemetry, or any value timestamped after evaluated_at.

## Model and validation
- Python/XGBoost multiclass softprob.
- Fold-local preprocessing: median imputation + standard numeric passthrough; one-hot encoding fitted only on each training fold.
- Purged walk-forward time splits, not random shuffle.
- Keep the latest chronological 20% as untouched future holdout, with at least 250 rows; if insufficient, report evidence shortage rather than weaken validation.
- Class-balanced sample weights.
- Confidence gate: predicted class probability >= 0.60; otherwise operational prediction is ABSTAIN for research scoring.

## Qualification
Research candidate only; never approved for DEMO/LIVE from this task. Report:
- multiclass balanced accuracy,
- FLIP precision/recall,
- KEEP precision/recall,
- action accuracy among confident predictions,
- counterfactual net-R policy metrics using +targetR-cost for correct KEEP/FLIP, -1R-cost for incorrect actions, and 0R for predicted ABSTAIN,
- profit factor, Sharpe, max drawdown, positive-fold fraction, positive-instrument fraction.

Use existing project gates as a research scorecard: balanced accuracy >= 0.52, Sharpe >= 1.0, profit factor >= 1.15, max drawdown <= 12 normalized R-units, positive folds >= 60%, positive instruments >= 67%, confidence >= 0.60. Passing does not grant execution authority.

## Safety
- Exporter uses REPEATABLE READ READ ONLY.
- Generated datasets/reports live outside git by default.
- Model artifact is research-only, `executionAuthority=NONE`, `modifiesExecution=false`, `approvedForDemo=false`, `approvedForLive=false`.
