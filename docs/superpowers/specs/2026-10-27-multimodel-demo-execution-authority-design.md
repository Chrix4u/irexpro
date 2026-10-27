# Multi-Model DEMO Execution Authority Design

## Intent
Restore the intended iRexPro architecture for broker-connected DEMO trading: the multi-model ensemble is the primary strategy authority, while M1 Tactical is a specialist for short-horizon timing and trade geometry rather than the final route gate.

## Goals
- Keep exactly one scheduler capable of dispatching broker orders for a session.
- Use the active cTrader FULL_AUTO DEMO connection as the exact market-data and execution binding.
- Require broker-native Plan-B v4 three-expert XGBoost consensus for DEMO promotion.
- Require the existing Plan-B multi-model policy and ensemble governance to admit the same direction.
- Use M1 Tactical features/candidates for entry timing, SL/TP geometry, volatility and short-horizon evidence.
- Preserve macro-event, spread, drift, allocation, currency-exposure, position-sizing, margin and broker safety gates.
- Allow qualified continuation, reversal or transition opportunities; M1 route phase restrictions must no longer be the final DEMO authority.
- Make execution metadata/status identify the primary engine as `irexpro-multimodel-ensemble-v1` and M1 as a timing specialist.

## Non-goals
- No LIVE-money authority changes.
- No model retraining or threshold retuning.
- No weakening of downstream risk or broker verification gates.
- No second competing order scheduler.
- No promotion of the v8.5 post-entry challenger to execution authority in this change.

## Constraints
- DEMO-only promotion must remain fail-closed.
- The trained challenger must use its frozen 128-feature contract and broker-native OHLCV from the exact active connection.
- If the trained challenger is unavailable, stale, non-native, abstains, or conflicts with the candidate direction, the candidate cannot execute.
- The deterministic Plan-B policy must be `paperAdmitted` and generic ensemble governance must be execution-eligible after real spread/event/drift checks.
- The exact FULL_AUTO broker connection must match at final dispatch.
- PositionSizingService remains authoritative for final lot size; the scheduler only supplies a maximum volume cap.

## Approaches considered
1. **Flip the old PAPER scanner to FULL_AUTO.** Rejected: it is tightly coupled to Twelve Data/PAPER ownership and would risk using the wrong market authority on cTrader.
2. **Run a second multi-model DEMO scheduler alongside M1.** Rejected: two schedulers could compete for the same session and duplicate signals/orders.
3. **Promote the multi-model decision inside the existing broker-native M1 dispatcher.** Chosen: preserves one execution owner, uses cTrader-native data already proven healthy, and changes only the strategy authority boundary.

## Architecture
For FULL_AUTO DEMO, each completed M1 decision uses the broker-native M1/M5/M15/H1/H4 snapshot. M1 builds both BUY and SELL timing candidates. Each candidate is converted into the existing Plan-B feature semantics and scored by `scorePlanBMultimodelShadow`, while the frozen Plan-B v4 three-expert challenger independently scores the same broker connection through the Python AI engine. Generic ensemble governance applies spread/event/drift/EV rules. A pure DEMO authority decision requires Plan-B admission, governance eligibility, and a fresh trained-model `CONFIRM` in the same direction.

M1 route classification, reliability and shadow outcomes continue to be recorded for learning and diagnostics, but `M1_PHASE_ROUTE_SHADOW` no longer blocks a DEMO candidate that wins the multi-model quorum. Historical PAPER rollout behavior remains unchanged.

The existing M1 dispatcher remains the only component that calls `AiSignalService.receiveSignal`, so all existing execution orchestration, risk, sizing, allocation, margin and broker adapter controls remain downstream and authoritative.

## UI/observability
The M1 tactical status endpoint should expose the active primary engine and latest multi-model quorum details so the AI Trading cockpit can say `Multi-model ensemble · ACTIVE` and show trained-model votes/confirmation instead of implying M1 Tactical is the sole model.
