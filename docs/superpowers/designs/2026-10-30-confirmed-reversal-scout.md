# Confirmed-Reversal Adaptive PAPER Scout Design

## Intent
Increase iRexPro participation when the M5 engine has already classified a setup as `CONFIRMED_REVERSAL`, without weakening the normal 6-of-7 ensemble admission rule for trend or full-size execution.

## Current State
`scorePlanBMultimodelShadow()` requires 6 of 7 votes for normal PAPER admission. The existing `evaluatePaperOpportunityScout()` can rescue selected positive-edge trend-continuation setups at research size, but rejects every `CONFIRMED_REVERSAL` as `ROUTE_NOT_SCOUTABLE`. Confirmed reversal itself is already gated by confidence >= 0.64, gross expected R >= 0.18, extension <= 1.15 ATR, volatility <= 0.55, and aligned short-horizon momentum between 0.5 and 1.5 ATR.

## Goals
- Allow strong confirmed reversals to enter a PAPER-only research lane when soft ensemble votes miss.
- Keep the normal ensemble threshold unchanged.
- Preserve event-risk, execution-cost, portfolio, adaptive calibration, realised-payoff, entry-alignment, sizing, and downstream risk controls.
- Use 0.20 lot as the ceiling for strong 5+/6 confirmed-reversal scouts and 0.10 for exceptional 4/6 micro scouts; final PositionSizingService may reduce either ceiling.

## Non-goals / Anti-goals
- No DEMO or LIVE authority change.
- No global consensus reduction from 6.
- No bypass of high-impact event, unusable execution cost, OOD drift, portfolio, post-loss, calibration, realised-payoff, or account-risk gates.
- No change to trend-continuation scout behavior.

## Approaches Considered
1. Lower global consensus from 6 to 5. Rejected: broadens every route and weakens full-size governance.
2. Extend the existing PAPER scout with a route-specific confirmed-reversal branch. Chosen: smallest change, reuses existing research sizing/payoff brakes, and isolates relaxation to a route that already has strong structural prerequisites.
3. Add a separate reversal execution service. Rejected for now: duplicates scout/risk plumbing without adding evidence value.

## Chosen Behavior
A confirmed-reversal scout must have exact route/regime, clear event risk, usable execution cost, portfolio quality >= 0.35, confidence >= 0.64, aligned momentum in [0.5, 1.5] ATR, and drift not `OUT_OF_DISTRIBUTION`.

For consensus >= 5, require net expected R >= 0.10 and direction/trade/exit quality each >= 0.35. Return `CONFIRMED_REVERSAL_SCOUT` with a 0.20-lot research ceiling.

For consensus == 4, require a premium micro setup: `NORMAL` drift, confidence >= 0.70, net expected R >= 0.18, aligned momentum in [0.60, 1.20] ATR, and direction/trade/exit quality each >= 0.40. Return `CONFIRMED_REVERSAL_MICRO_SCOUT` with a 0.10-lot ceiling.

Anything weaker remains shadow-only. Existing downstream scout realised-payoff authority and adaptive/risk gates continue to apply unchanged.

Confirmed-reversal scout trades use a new v11 scout model identity so their realised-payoff evidence is isolated from the older trend-only v10 scout cohort. Trend scouts keep their existing model identity and history unchanged.
