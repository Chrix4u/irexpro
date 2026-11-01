# Route-Aware Profit Protection v2 Design

## Intent
Reduce premature profit-protection exits on Confirmed Reversal trades without weakening protection on routes where early exits are already economically useful.

## Evidence
The durable 4-hour counterfactual cohort contains 62 profit-protection exits. Confirmed Reversal: 10/11 later hit TP before SL, average counterfactual improvement +0.795R; among realised profits >0 and <=6, 6/6 later hit TP with +1.221R average delta. Early Transition: 27/36 TP-first with +0.419R average delta. Trend Continuation: 7/15 TP-first and -0.287R average delta, so loosening that route would have reduced historical payoff.

## Decision
- Confirmed Reversal profit lock must remain disarmed until peak favorable excursion reaches 1.00R.
- Early Transition remains disarmed until 0.75R, matching the already deployed route-aware v1 policy.
- Trend Continuation and unknown routes keep the existing M1 rescue / standard arming rules: 0.395R M1 rescue and 0.50R standard floor.
- Once a route is armed, keep the existing retention ladder unchanged.
- Stop-loss catch-up, broker SL/TP authority, and adverse-thesis exits remain unchanged.
- This applies consistently to PAPER and cTrader DEMO because both consume evaluatePaperProfitLock().

## Goals
- Give Confirmed Reversal winners more room to reach their original TP.
- Preserve current loss containment for Trend Continuation.
- Keep behavior deterministic and covered by direct unit tests plus live-demo integration tests.

## Non-goals
- No change to lot sizing, entry confidence, take-profit geometry, stop-loss geometry, daily-loss suspension, or route qualification.
- No automatic policy learning or threshold mutation from the report.
- No LIVE-account promotion.

## Safety constraints
- A Confirmed Reversal peak below 1.00R never arms profit protection.
- A Confirmed Reversal peak at or above 1.00R uses the existing retention tier for that peak.
- Early Transition still arms at 0.75R.
- Trend Continuation keeps existing behavior.
- Invalid or non-positive initial risk fails closed with no automatic profit-lock exit.
