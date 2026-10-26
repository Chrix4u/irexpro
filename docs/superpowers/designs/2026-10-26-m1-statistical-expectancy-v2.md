# M1 Statistical Expectancy V2 Design

## Intent
Stop treating the fixed M1 reward/risk target as if it were statistical edge. Preserve stop/target geometry, but make execution/ranking depend on an expectancy estimate that changes with predictive quality and causal pair/side payoff evidence.

## Problem
`M1TacticalCandidate.grossExpectedR` currently equals `policy.targetR` (normally 1.6R) for every candidate. Generic governance subtracts execution cost from that constant, so most M1 candidates report ~1.5R net expected value regardless of actual quality. Confidence is also a heuristic score, not a calibrated probability. This leaves drift/reliability gates doing nearly all selection and makes the displayed expected-R field misleading.

## Chosen approach
Add a pure M1 expectancy estimator and keep geometry separate from edge.

1. `targetR` / existing `grossExpectedR` remains the intended TP/SL geometry only.
2. A new statistical expectancy decision derives a conservative prior from candidate confidence + direction quality, shrunk toward the target-R breakeven probability rather than treating confidence as a calibrated probability.
3. When causal executed pair/side evidence contains at least 5 valid realised-R samples, blend the prior toward actual average realised R using a fixed prior weight of 5 samples.
4. When the latest-five payoff average is available, apply a 25% recency weight so fresh decay immediately reduces the estimate. Existing `EARLY_LOSS_STREAK`, `RECENT_NEGATIVE_PAYOFF`, and other reliability vetoes remain authoritative.
5. Generic M1 governance receives this statistical expectancy as ensemble `expectedR`; route payoff floors therefore compare against an evidence-aware number, not the fixed TP multiple.
6. Persist the expectancy artifact/source/prior/evidence values into decision governance and signal metadata.

## Prior mapping
For target R `T`, breakeven probability is `1 / (1 + T)`. Candidate heuristic quality is `(confidence + directionQuality) / 2`. Convert it conservatively into an implied probability:

`p = breakeven + 0.5 * (heuristicQuality - 0.5)`

clamped to `[breakeven - 0.10, breakeven + 0.20]`.

Prior expected R is `p*T - (1-p)`.

This deliberately makes a neutral quality score produce ~0R instead of +1.6R. A strong heuristic setup can earn a modest positive prior, but mature realised evidence has increasing authority.

## Goals
- Two candidates with identical TP/SL geometry but different predictive quality get different expected R.
- Mature positive realised-R sleeves can earn positive expectancy and continue trading.
- Mature negative or freshly decaying sleeves get lower/negative expectancy in addition to existing reliability vetoes.
- Sparse evidence remains conservative instead of optimistic.
- Hard event/drift/cost/currency-exposure/broker/risk controls stay unchanged.

## Non-goals
- No new DEMO/LIVE authority.
- No lowering of route payoff floors merely to increase trade count.
- No replacement of the existing reliability brakes.
- No claim that heuristic confidence is a calibrated probability.

## Approaches considered
- **Keep fixed target-R as EV and rely on blockers:** rejected because it is semantically wrong and non-discriminative.
- **Use raw confidence directly as win probability:** rejected because M1 confidence is heuristic/capped and not calibrated.
- **Conservative prior + causal realised-R shrinkage (chosen):** improves discrimination immediately while allowing local causal evidence to dominate as it matures.
