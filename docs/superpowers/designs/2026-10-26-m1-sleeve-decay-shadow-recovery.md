# M1 Sleeve Decay + Shadow Recovery Design

## Intent
Keep M1 frequent when an exact pair/direction/route sleeve is paying, but remove PAPER authority quickly when fresh realized payoff decays and keep blocked sleeves learning counterfactually so they can earn recovery.

## Evidence
On 2026-10-26 the active M1 early-transition SELL sleeves diverged sharply. USDJPY SELL remained positive over the day (+8.766R) but its latest 5 averaged -0.999R; GBPUSD SELL remained positive over the day (+2.821R) but its latest 5 averaged -0.128R; EURUSD SELL was negative over the full day (-2.589R). The existing three-loss brake catches USDJPY and full-window payoff catches EURUSD, but GBPUSD can remain live after its current edge has already turned negative.

The resolved 15-minute M1 shadow ledger contains 175 independent episodes but stops on 2026-10-23 because the resolver only recognizes the old global SHADOW blocker shape. Active-rollout route-shadow and reliability-demoted candidates therefore stopped producing fresh counterfactual outcomes.

## Chosen approach
1. Add a five-trade realized-R recency window to exact route/pair/side reliability. If the full window remains positive but the latest 5 average is strictly worse than -0.10R, demote with `RECENT_NEGATIVE_PAYOFF`. Require valid original-stop risk for all five recent trades; do not substitute older trades when a recent risk value is unavailable. Preserve the faster three-loss brake and full-window negative-expectancy precedence.
2. Persist `shadowOutcomeEligible` on structurally valid non-executed M1 decisions. Reliability/rollout demotion does not stop learning. Hard event, execution-cost, policy/HTF and unrelated drift failures remain excluded. The explicit local-impulse early-transition drift exception remains eligible for counterfactual learning only.
3. Extend the resolver to select `shadowOutcomeEligible=true` while retaining legacy SHADOW rows.

## Safety
No entry threshold, stop, target, lot cap, DEMO/LIVE authority, event-risk rule, broker control, or currency-exposure limit is loosened. Shadow settlement cannot grant execution authority by itself.
