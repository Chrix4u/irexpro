# M1 Provisional Scout v7 Design

## Goal
Increase short-horizon PAPER participation without enabling the historically losing M1 trend-continuation route or weakening mature early-transition reliability.

## Evidence
Stored 15-minute shadow outcomes show M1 trend continuation is negative overall (-25.53R, PF 0.577), so it remains shadow-only. Early transition is mixed overall but has strong pair-side sleeves. Production v6 currently arms mature early-transition sleeves only when >=6 samples meet PF >=1.5, avg >=0.10R, positive fraction >=0.40, and latest-three net R >0. Exact current evidence arms EURUSD SELL at 0.10; GBPUSD SELL and USDJPY SELL have only 3 resolved samples each but strong provisional payoff.

## v7 Authority
- Route: M1_EARLY_TRANSITION only.
- Mature tier: existing meaningful reliability unchanged, 0.10 lot cap.
- Provisional tier: 3-5 valid recent outcomes, PF >=2.0, average >=+0.20R, positive fraction >=0.50, latest-three total R >0; cap 0.05 lots.
- At >=6 samples, provisional authority is disabled; mature evaluator decides.
- Trend continuation and confirmed reversal remain shadow-only.
- Existing route net-R floor (0.20), generic governance, drift/local-impulse rules, event risk, execution-cost, active PAPER session, sizing/risk and duplicate-signal protections remain authoritative.

## Fail Closed
Sparse <3, stale/future, low PF, low average R, low positive fraction, recent degradation, unsupported route, or unavailable evidence => no provisional execution.
