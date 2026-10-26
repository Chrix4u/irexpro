# Short-Horizon Opportunity Model Design

## Problem
The current engine can remain silent for long periods, but replay shows that simply lowering static confidence/EV/consensus gates does not create a profitable high-frequency stream. A Friday replay of the old pulse scout found only four extra candidates and they resolved 1W/3L (-2.11R). A Monday-Thursday grid across 4,032 static gateway combinations found no configuration with enough opportunity density while preserving PF >= 1.15 and positive average R.

A broader replay of the later local-impulse M1 pattern also showed why participation cannot be manufactured by relaxing permission gates: the independent episodes were approximately PF 1.009 at 5 minutes, PF 0.409 at 20 minutes, and PF 1.075 at 60 minutes. That lane therefore remains a selective reduced-risk scout rather than the primary frequency engine.

## Decision
Build a shadow-only multi-horizon challenger that predicts opportunity, direction, and economic payoff quality directly at 5, 20, and 60 minutes. Reuse the existing causal MTF feature contract, event/barrier labels, nested purged walk-forward evaluation, XGBoost models, and research gates.

The fixed experiment matrix is:
1. locked baseline,
2. retained pooled hybrid payoff-risk v1,
3. retained two-stage pair-expert v2 control,
4. pair-specific hybrid payoff-risk v3 challenger.

### Why v2 is retained only as a control
The v2 `two_stage_event_pair_experts` family was already represented in retained research. At 5 minutes it produced attractive aggregate PF but concentrated 58 of 62 trades into one fold, leaving positive-fold fraction at 20% and positive-instrument fraction at 16.7%. It therefore did not solve the engine's breadth/regularity problem.

### v3 architecture
v3 combines the useful breadth and economic-filtering ideas without pooling pair-specific direction/payoff behavior:
- one pooled event/opportunity probability model,
- independent LONG-vs-rest and SHORT-vs-rest classifiers **per instrument**,
- train-only expected upside and downside regressors **per instrument and side**,
- exact instrument-identity routing with no cross-pair fallback,
- BUY / SELL / ABSTAIN decision,
- fixed confidence floor 0.60,
- fixed payoff/risk ratio floor 1.15.

The architecture is derived from the previously successful USDJPY v10 hybrid payoff-risk family, whose retained qualification evidence passed the research gates with BA 0.5224, PF 2.682, Sharpe 5.596, positive-fold fraction 100%, and positive-instrument fraction 100%. v3 tests whether that structure generalizes across all six pairs when direction/payoff specialists are isolated per pair.

## Horizons and participation targets
- 5 minutes: >= 24 non-overlapping opportunity periods per active FX validation day.
- 20 minutes: >= 12 per active FX validation day.
- 60 minutes: >= 6 per active FX validation day.

These are research qualification requirements, never forced-trade quotas. A model that cannot find enough qualified opportunities fails the participation objective; a model that trades frequently but fails economics/risk gates also fails.

## Evidence sequence
The research sequence is deliberately fail-fast:
1. run exact-head unit/CI verification,
2. run a cheap 5-minute one-fold six-pair screen,
3. reject v3 immediately if one-fold economics/participation are not credible,
4. only then run multi-fold 5-minute qualification,
5. only after 5-minute evidence survives, extend qualification to 20 and 60 minutes.

The one-fold screen uses the sealed 474,700-row causal feature cache plus freshly rebuilt forward labels from the immutable six-pair corpora. The protected research cutoff remains `2026-09-02T19:59:00+00:00`, with the five-minute screen ending no later than 19:53 UTC so the full outcome horizon stays before the cutoff.

## Governance
- Fully causal features only; `available_at` contract unchanged.
- Future prices are label/evaluation data only.
- Purge and embargo equal the horizon.
- Existing research thresholds remain unchanged.
- No confidence-floor reduction below 0.60.
- No weak-pair/fold deletion.
- Missing pair experts fail closed.
- No production model selection in this change.
- PAPER authority: false.
- DEMO authority: false.
- LIVE authority: false.
