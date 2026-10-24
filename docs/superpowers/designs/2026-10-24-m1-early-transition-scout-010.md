# M1 Early-Transition 0.10 PAPER Scout Design

## Goal
Create a separate short-horizon PAPER participation sleeve instead of weakening the M5 gate. Only evidence-qualified M1 early-transition pair/sides may execute at 0.10 lots; M1 trend-continuation and confirmed-reversal stay shadow-only.

## Evidence boundary
The active M1 shadow engine already settles causal 15-minute outcomes by pair/direction/route. Meaningful-size execution requires at least 6 observable independent shadow episodes from the last 7 days, profit factor >= 1.50, average net R >= +0.10R, positive fraction >= 40%, and latest-three cumulative net R > 0. Sparse 3-sample sleeves remain shadow-only.

## Execution boundary
Add rollout `m1-tactical-rollout-v6-early-transition-scout-010` with phase `PAPER_EARLY_TRANSITION_SCOUT_010` and 0.10-lot cap. Only `M1_EARLY_TRANSITION` can execute in this phase. The existing +0.20R route payoff floor stays unchanged.

## Hard safety
Standard M1 governance must be PAPER-eligible. Unlike the legacy 0.01 micro lane, V6 cannot rescue an OOD-only blocker. Event risk, execution costs, actual-trade reliability, session binding, allocation, margin, drawdown, stop/target geometry, broker checks, and RiskService remain authoritative.

## Sizing provenance
M1 V6 signals carry `m1_evidence_qualified_scout_eligible=true` plus the evidence artifact/metrics. StrategyOrchestrator accepts the 0.10 PAPER minimum only when that flag is true AND timeframe is `M1` AND strategy code is `external-irexpro-m1-tactical`. Normal external-provider PAPER stays at the 0.20 product minimum. M5 retains its separate `paper_opportunity_scout_eligible` authority.

## Initial evidence
Current causal evidence suggests EURUSD SELL early-transition is mature enough (6 episodes, PF ~4.70, +1.285R total, latest-three net positive). Strong 3-sample GBPUSD/USDJPY sleeves remain shadow until they mature. No pair is hard-coded; qualification is recalculated causally at every decision.
