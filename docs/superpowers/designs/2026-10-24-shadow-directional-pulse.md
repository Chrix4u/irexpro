# Shadow Directional Pulse Design

## Problem

The adaptive edge matrix learns only from executed PAPER trades. When execution is sparse, pair/direction evidence stays sparse, which keeps adaptive ranking cautious even though `trading.ensemble_shadow_decisions` already contains thousands of causally resolved BUY/SELL counterfactual outcomes.

The result is a learning catch-22: few trades -> sparse executed evidence -> cautious ranking -> few trades.

## Goal

Use recent, already-resolved shadow outcomes as a fast pair-side ranking signal so the scanner can prefer the direction that is paying now without granting new execution authority or bypassing any safety gate.

## Design

Add `adaptive-shadow-directional-pulse-v1` as a read-only ranking component.

For each pair and candidate direction:

- Read only shadow outcomes whose `resolvedAt < evaluatedAt`; future/unresolved outcomes are ignored.
- Use the latest 10 resolved outcomes per side.
- Require at least 4 resolved outcomes for the candidate side and 4 for the opposite side; otherwise return neutral quality `0.5` and `INSUFFICIENT`.
- Compute exponentially weighted mean realised R with decay `0.65`, newest outcome weight `1.0`.
- Compute directional advantage = candidate weighted R - opposite weighted R.
- Convert advantage to a bounded quality score around neutral `0.5`; this signal affects ranking only.
- Persist pulse metrics in adaptive intelligence metadata for later attribution.

The pulse must never:

- turn a hard-blocked candidate executable;
- change net expected R;
- change event-risk, drift, cost, post-loss, entry-alignment, portfolio or broker authority;
- change SL/TP;
- independently increase lot size.

## Opportunity score integration

Add a small `shadowDirectionalPulseQuality` component with 5% weight. Rebalance existing soft ranking weights so total remains exactly 1.0. A strong recent side can break ties and improve ranking, while insufficient evidence is neutral.

Hard blockers remain the sole authority for `executionEligible` in `scoreAdaptiveOpportunity`.

## Causality and rollout

All outcome rows are filtered by resolution time before the current evaluation time. This is a PAPER-only adaptive ranking enhancement and does not change DEMO/LIVE authority.
