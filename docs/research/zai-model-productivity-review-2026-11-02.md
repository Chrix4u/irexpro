# z.ai independent model/productivity review — 2026-11-02

## Purpose

This branch is an isolated review/work lane for an independent z.ai assessment of iRexPro. Do not modify `main` directly. The goal is to identify evidence-backed improvements to trade selection, profitability, trade management, data reliability, model calibration, and operator productivity without weakening risk controls or silently changing LIVE behavior.

Base commit at branch creation: `09a25ce7076ed9be421b3109f7e6540cbae9631a` (`main`, 2026-11-02).

## Review priorities

Study the current implementation end-to-end, especially:

- M1 tactical scheduler and broker-native M1/M5/M15/H1/H4 feature pipeline.
- Multi-model / Plan-B ensemble scoring and admission.
- Trained three-expert XGBoost challenger and its shadow/authority boundaries.
- Three-class side-selection research model and primary-vs-opposite candidate telemetry.
- Confirmed reversal / continuation / early-transition routes.
- Drift, execution-cost/spread, event-risk, expectancy, reliability, and final risk governance.
- DEMO reliability vetoes and high-conviction rescue logic.
- Entry timing, lot sizing, stop/take-profit geometry, post-entry monitoring, profit protection, and exit logic.
- cTrader broker-native quote/trendbar ingestion and market-data readiness.
- Paper/demo telemetry, counterfactuals, model evaluation, and promotion gates.

## Current evidence snapshot

### Closed-trade aggregate available in staging

The current staging database contains 588 CLOSED trades with non-null realised P&L:

- Wins: 271
- Losses: 313
- Flat/zero: 4
- Win rate: 46.09%
- Gross positive P&L: +1420.85 account-currency units
- Gross negative P&L: -1761.82 account-currency units
- Net P&L: -340.97 account-currency units
- Approximate profit factor: 0.81

Treat this as a broad staging aggregate, not a clean model-vs-model attribution dataset. Before drawing conclusions, segment by model/route, instrument, direction, regime, close reason, entry cohort, date, broker, and rollout version where provenance supports it.

### Current M1/multi-model decision observations

Recent decisions show candidate confidence commonly around 0.59–0.738 while the multi-model ensemble score is commonly around 0.40–0.55. Typical execution blockers observed include:

- `MULTIMODEL_PLAN_B_NOT_ADMITTED`
- `MULTIMODEL_GOVERNANCE_BLOCKED`
- `ENSEMBLE_NOT_PAPER_ADMITTED`
- `ENSEMBLE_NOT_PROMOTABLE_ADMISSION`
- `PAPER_NET_EXPECTED_R`
- `DRIFT_OUT_OF_DISTRIBUTION`
- `MULTIMODEL_CONTINUATION_TIMING_NOT_READY`
- `M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED`

Do not recommend simply lowering thresholds. Determine whether blockers are correctly calibrated, redundant, correlated, stale, or masking a feature/data-quality problem.

### Trade-readiness meter incident

A user-visible meter recently stayed around 12–18. This was traced to fail-closed broker market-data readiness states, not a literal 12–18% model probability. The UI intentionally maps broker readiness failures to low scores (for example context unavailable and unusable spread). Runtime logs showed transitions among `BROKER_M1_STALE`, `BROKER_FEATURE_CONTEXT_UNAVAILABLE`, and `BROKER_SPREAD_UNUSABLE`.

At a later runtime check the configured cTrader source had recovered: M1 observations were sub-minute fresh, M5/M15 were within their freshness windows, and all six major pairs had at least the minimum positive spread samples. Review the collector/warmup path for intermittent starvation rather than weakening the fail-closed checks.

## Required analysis from z.ai

Please produce an evidence-backed report before making behavioral changes. For every proposed improvement include:

1. The observed problem and exact code/data evidence.
2. Why the current behavior exists and what safety invariant it protects.
3. The proposed change.
4. Expected impact on trade frequency, win rate, expectancy, profit factor, drawdown, average win/loss, and tail risk.
5. Failure modes / ways the proposal could overfit.
6. How to validate it with walk-forward or out-of-sample evidence.
7. Whether it should stay shadow-only, be DEMO-only, or qualify for promotion.
8. Tests and telemetry required before any rollout.

## Allowed implementation on this branch

You may implement research tooling, diagnostics, offline evaluation, additional telemetry, tests, shadow models, feature flags, and clearly isolated experimental model logic on this branch.

For changes that can affect order admission, direction, position size, SL/TP, exit timing, or execution authority:

- Keep the change disabled by default or shadow-only unless the evidence package proves it is safe.
- Do not alter LIVE authority by default.
- Do not remove final account-risk checks.
- Do not lower safety/risk thresholds merely to increase activity.
- Preserve broker-native evidence requirements for execution.
- Add regression tests for existing invariants.

## Suggested analytical workstreams

- Attribute P&L to route/model/side/regime and identify where negative expectancy originates.
- Compare the chosen side against the counterfactual opposite side for the same decision episodes.
- Calibrate confidence and abstention; report reliability diagrams/Brier/log-loss where applicable.
- Evaluate whether model disagreement is informative enough to become a meta-feature rather than a hard veto.
- Analyze early-transition suppression by pair/side to distinguish temporary bad cohorts from structural route weakness.
- Analyze profit-protection exits: after an early protected close, replay whether price later reached the original TP, original SL, or neither.
- Optimize exits separately from entries so a high win rate does not hide poor payoff ratio.
- Inspect drift diagnostics feature-by-feature and determine whether the current envelope rejects legitimate post-regime-shift opportunities.
- Inspect spread sampling and cTrader history refresh for intermittent readiness starvation.
- Evaluate per-pair and per-session specialists versus a single shared threshold.
- Build a champion/challenger scorecard that requires out-of-sample expectancy and drawdown improvement, not merely classification accuracy.

## Deliverables

Commit all work only to `review/zai-model-productivity-20261102` (or a child branch from it) and provide:

- `ZAI_REVIEW_REPORT.md` with ranked findings and evidence.
- Any new research scripts/notebooks under an isolated research path.
- Tests for any code changes.
- Before/after evaluation artifacts or compact reproducible statistics.
- A concise list of commits that ChatGPT/OpenAI should review before anything is considered for merge.

Do not merge this branch into `main`; the changes will be independently reviewed first.
