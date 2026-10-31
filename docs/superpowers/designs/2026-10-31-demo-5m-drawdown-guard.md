# cTrader DEMO 5-Minute Drawdown Guard Design

## Problem
cTrader DEMO has 117 closed trades with 64 wins, 52 losses and -127.49 EUR net realised P&L. The dominant economic drag is loss size: broker-side closes account for roughly -411.25 EUR, while profit protection already locks positive trades effectively.

Minute-1 telemetry is too noisy for execution: eventual winners frequently show temporary early drawdown. The broker-native 5-minute checkpoint separates severe deterioration more cleanly.

## Evidence
Use only READY broker-native v8.5 checkpoint observations from the connected cTrader DEMO account.

Threshold selection is causal by date:
- Training: trades opened 2026-10-28 through 2026-10-29.
- Holdout: trades opened 2026-10-30.
- Candidate rule family: current R at the 5-minute checkpoint only.
- Selection rule: choose the least severe threshold with at least 80% loss precision in training.

`currentR <= -0.40` is the least severe qualifying threshold:
- Training: 11 triggered, 9 eventual losses / 2 eventual wins = 81.8% loss precision.
- Untouched Oct-30 holdout: 4 triggered, 4 losses / 0 wins = 100% loss precision.
- Approximate linear checkpoint counterfactual: triggered cohort final P&L -107.73 EUR vs about -77.78 EUR at the 5-minute checkpoint, about +29.95 EUR improvement.

After accounting for the persistent exact-sleeve quarantine already deployed:
- Training residual: 10 triggers, 8 losses / 2 wins; approx +8.67 EUR counterfactual improvement.
- Oct-30 holdout residual: 2 triggers, 2 losses / 0 wins; approx +9.88 EUR counterfactual improvement.

The counterfactual is approximate because it derives checkpoint cash P&L from realised price/P&L geometry. It is evidence for a DEMO guard, not proof of future profitability.

## Decision
Add a new independent post-entry drawdown guard with these hard boundaries:
1. cTrader-family broker connection only.
2. `account_type = DEMO` only. LIVE is structurally excluded in SQL.
3. OPEN iRexPro multimodel ensemble trade only.
4. Exact 5-minute broker-native v8.5 causal checkpoint. Execution requires READY state, the exact v8.5 artifact, shadow-only source authority, and `market_data_sources.M1='broker'`.
5. `current_r <= -0.40` triggers a full close through existing `ExecutionService.closeTrade()`.
6. The action must occur no later than 7 minutes after entry. After that, the 5-minute signal is stale and cannot close the trade.
7. Close reason remains `AI_CLOSE_SIGNAL`; the dedicated observation artifact records that it was the drawdown guard.
8. Existing ExecutionService idempotency, provider close semantics, CAS transition and reconciliation handling remain authoritative.

## Non-goals
- No LIVE authority.
- No lot-size changes.
- No stop-loss widening.
- No global confidence/consensus changes.
- No minute-1 exit authority.
- No modification of the v8.5 profit-protection classifier.

## Audit artifact
`plan-b-v89-demo-5m-drawdown-guard-v1`

Each evaluation persists its checkpoint state/action/current R and uses `execution_authority=DEMO_ONLY`. No-action observations remain non-mutating; close observations record the close result without storing credentials or broker secrets.
