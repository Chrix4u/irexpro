# PAPER Research Requalification Shadow v1 — Design

**Date:** 2026-10-25
**Base SHA:** `7b3d7a241de2fbcd935710989316e4d3ae4ae716`
**Scope:** PAPER evidence collection only

## Problem

The research-throughput family is correctly quarantined from execution after the Oct 20–22 deterioration cohort. Its realised cross-pair portfolio brake is also currently active at 3 losses in the latest 5 research trades. Because the execution lane is quarantined, that realised last-five window cannot acquire new trades and therefore cannot prove recovery by itself.

At the same time, current-policy pair/side evidence is heterogeneous. `AUDUSD SELL` has 10 current-policy v11 closes, 8 wins / 2 losses, realised average `+0.262745R`, and realised PF about `2.31`, while several other pair/sides are negative or too sparse. Reopening the whole research lane would therefore be unsafe, and reopening AUDUSD SELL immediately would still rely on stale realised samples whose latest close was 2026-10-20.

## Decision

Add a **shadow-only requalification telemetry path**. It observes fresh research-throughput candidates that would be locally executable except for the stale/cross-pair portfolio brake and the global Oct-19 execution boundary. It never creates an order and never changes the existing portfolio brake or global control.

### Candidate requirements

A requalification shadow candidate must pass all of these current gates:

1. `evaluatePaperResearchThroughput(...).eligible === true`.
2. Existing pair/side reliability is eligible.
3. Existing episode guard is eligible.
4. Broad calibration brake is clear.
5. Current PAPER execution cost is usable through the existing cost-aware evaluator and its action is `ENTER_NOW`.

The realised portfolio brake is recorded but does **not** veto shadow collection. This is the only gate relaxed, and only for observation. The global `isOct19ProvenM5PaperExecutionAllowed` boundary remains unchanged and still blocks every research route from creating orders.

### Persisted annotation

Persist `components.paperResearchRequalificationShadow` on the already-created `trading.ensemble_shadow_decisions` row for the opportunity. The annotation contains:

- artifact/version,
- `candidate`,
- reason,
- `executionAuthority: NONE`,
- `modifiesExecution: false`,
- `qualificationEvidence: false`,
- whether the realised portfolio brake was blocked,
- pair/side sample count and realised-average-R where available,
- cost-aware action and reason.

The existing first-hit outcome resolver will later add `components.outcome` to the same decision. No new market-data or outcome path is introduced.

### Requalification scorecard

A read-only audit groups annotated candidates by pair/side, collapses overlapping observations with the existing `collapseEnsembleOutcomeEpisodes`, and summarizes them with `summarizeEnsembleSleeveOutcomes`.

Status is informational only:

- fewer than 8 fresh non-overlapping resolved episodes: `COLLECTING`;
- at least 8 and all of the existing system-quality thresholds pass: `RECOVERY_SIGNAL`;
- otherwise: `WEAK`.

The informational recovery thresholds reuse existing IrexPro gates rather than tuning new values from the current result:

- profit factor >= `1.15` (or no losses with positive net R),
- Sharpe >= `1.0`,
- max drawdown <= `0.12`,
- net R > `0`.

A `RECOVERY_SIGNAL` still has `executionAuthority: NONE`, `productionEligible: false`, and `qualificationEvidence: false`. A later, separately reviewed change would be required to permit any canary execution.

## Failure behavior

- Missing data source or annotation failure never changes execution.
- Cost evidence unavailable or non-`ENTER_NOW` => not a requalification candidate.
- Calibration, pair/side, or episode failure => not a candidate.
- Audit query is repeatable-read/read-only and scoped to the exact PAPER user, PAPER connection, active engine, current artifact, and current outcome version.
- Existing normal-PAPER execution, continuation realised-route brake, reversal reliability, extension-exhaustion quarantine, DEMO, and LIVE remain unchanged.

## Verification

- TDD for pure shadow candidate evaluator and informational scorecard.
- Collector tests prove the portfolio brake is diagnostic-only for the annotation but still blocks real research execution.
- Collector test proves cost-aware non-entry rejects the shadow candidate.
- Persistence test proves the annotation cannot set execution authority.
- Read-only audit runner tests exact scope and overlap collapse.
- Focused Jest, build, lint, `git diff --check`, then broader API regression before any merge.
