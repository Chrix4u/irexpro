# Short-Horizon Opportunity Model Design

## Problem
The current engine can remain silent for long periods, but replay shows that simply lowering static confidence/EV/consensus gates does not create a profitable high-frequency stream. A Friday replay of the current pulse scout found only four extra candidates and they resolved 1W/3L (-2.11R). A Monday-Thursday grid across 4,032 static gateway combinations found no configuration with 20+ opportunities, PF >= 1.15, and positive average R.

## Decision
Build a shadow-only multi-horizon challenger that predicts opportunity and direction directly at 5, 20, and 60 minutes. Reuse the existing causal MTF feature contract, event/barrier labels, nested purged walk-forward evaluation, XGBoost models, and hybrid payoff-risk architecture.

Each horizon uses the fixed event-barrier hybrid payoff-risk candidate:
- pooled opportunity probability,
- independent BUY-vs-rest and SELL-vs-rest probabilities,
- train-only expected upside/downside regressors,
- BUY/SELL/ABSTAIN decision,
- fixed confidence floor 0.60,
- payoff ratio floor 1.15.

The challenger has no PAPER, DEMO, or LIVE authority in this change.

## Horizons and participation targets
- 5 minutes: >= 24 non-overlapping opportunity periods per active FX validation day.
- 20 minutes: >= 12 per active FX validation day.
- 60 minutes: >= 6 per active FX validation day.

These are research qualification requirements, never forced-trade quotas. A model that cannot find enough qualified opportunities fails the participation objective; a model that trades frequently but fails economics/risk gates also fails.

## Governance
- Fully causal features only; `available_at` contract unchanged.
- Future prices are label/evaluation data only.
- Purge and embargo equal the horizon.
- Existing research thresholds remain unchanged.
- No confidence-floor reduction below 0.60.
- No weak-pair/fold deletion.
- No production authority.
