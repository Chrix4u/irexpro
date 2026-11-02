# DEMO Profitability Reliability Gates — Design

## Context

PRIMARY_PLAN_B currently evaluates Plan-B admission/governance, trained-expert state and M1 timing, but it does not consume the M1 route reliability or early-transition pair-side reliability that the scheduler has already calculated. Historical DEMO evidence shows this is materially unsafe: EARLY_LOSS_STREAK was 0W/3L (-18.74), weak/degraded pair-side states were 2W/9L (-53.62), and M1_EARLY_TRANSITION was 8W/12L (-36.52), while M1_TREND_CONTINUATION was 7W/4L (+3.47).

## Goals

- DEMO-only hard execution veto when M1 route reliability is `EARLY_LOSS_STREAK`.
- DEMO-only veto for `M1_EARLY_TRANSITION` when pair-side evidence is explicitly weak/degraded or otherwise ineligible with a negative reliability reason.
- Preserve healthy early-transition and trend-continuation execution paths.
- Preserve shadow decision/outcome collection when broker execution is vetoed.
- Preserve the existing confirmed-reversal conflict handling and existing 5-minute drawdown guard.
- Persist explicit blocker telemetry so every suppressed entry is auditable.
- Leave LIVE execution behavior unchanged.

## Non-goals

- No permanent USDJPY or other pair ban.
- No blind opposite-direction flipping.
- No universal tighter stop loss.
- No lot-size increase.
- No retuning of the existing 5-minute DEMO drawdown guard in this change.

## Considered approaches

### A. Expand `evaluateMultimodelDemoAuthority`
Feed M1 reliability and pair-side evidence directly into the core multimodel authority function. This centralizes all gating, but broadens a currently generic contract and makes a DEMO profitability experiment harder to isolate.

### B. Add a scheduler-level DEMO profitability overlay — chosen
Apply a pure reliability overlay after `reliability`, `shadowPairSideReliability`, and `multimodelDemo` are all available in `persistCandidate()`. The scheduler already owns these inputs and is explicitly in the professional DEMO phase. This avoids duplicate evidence queries, keeps LIVE untouched, and provides a clean TDD seam.

### C. Change generic M1 governance
This would affect research/scout paths and risks unintentionally changing non-DEMO behavior. Rejected for this iteration.

## Decision rules

1. `EARLY_LOSS_STREAK` is a hard DEMO broker-execution veto across primary Plan-B and fallback/rescue paths. The candidate is still recorded and can continue shadow outcome collection.
2. For `M1_EARLY_TRANSITION`, explicit weak/degraded pair-side states veto broker execution. Initial negative reasons include `WEAK_MEANINGFUL_EXPECTANCY`, `RECENT_MEANINGFUL_DEGRADATION`, `WEAK_PROVISIONAL_EXPECTANCY`, and `RECENT_PROVISIONAL_DEGRADATION`. An explicitly ineligible early-transition reliability decision with a non-positive/degradation reason is treated conservatively.
3. `M1_TREND_CONTINUATION` is not blocked by the early-transition pair-side overlay. Existing generic governance and risk controls remain authoritative.
4. No new automatic reversal is introduced. Existing confirmed-reversal logic remains responsible for closing an opposite open position and deferring the new entry.
5. Existing lot caps, fast-stop brakes, loss-streak brakes, currency exposure checks, and 5-minute drawdown management remain in force.

## Observability

Record a `demoProfitabilityReliabilityGate` object in decision governance and add explicit blocker codes:
- `M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK`
- `M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED`

The gate must not prevent the decision from being persisted.

## Safety / promotion

This change is DEMO-only. It is not a LIVE promotion. Promotion requires prospective evidence showing improved expectancy and acceptable drawdown without materially degrading healthy trend-continuation performance.