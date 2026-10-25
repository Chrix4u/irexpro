# PAPER Realised Route Brake v1 — Design

**Date:** 2026-10-25
**Scope:** IrexPro PAPER only
**Base SHA:** `e7f61b4a4b6e7197f340659a22391b199041354b`

## Problem

The existing continuation reliability layer is intentionally pair/side-led. Aggregate route weakness is diagnostic only, while pair/side shadow episodes must mature before execution can be demoted. On the current PAPER ledger this leaves a gap: the realised champion evidence is already mature at route level while the independent pair/side shadow ledger is still effectively empty for recent candidates.

A read-only audit at `2026-10-25T18:00:33.320Z` found the champion overall provisionally positive at 100 closed trades, +63.89 realised PnL and PF 1.2482. The policy-compatible route partition is materially different:

- `CONFIRMED_REVERSAL`: 16 trades, +34.17, PF 1.9710.
- `EARLY_TRANSITION`: 12 trades, +16.39, PF 1.6913.
- `TREND_CONTINUATION`: 30 trades, -19.17, PF 0.7022.

The compatible continuation evidence is therefore mature enough to justify a conservative PAPER-only brake while preserving the winning routes.

## Decision

Add a separate **realised continuation route reliability** signal. Do not replace the existing synthetic/shadow route reliability or pair/side reliability.

The realised signal is execution-relevant only for normal PAPER continuation. It has no DEMO/LIVE/promotion authority.

### Evidence scope

Use only closed trades that satisfy all of the following:

1. Exact user and broker connection.
2. Broker connection is the PAPER broker already used by the scanner.
3. Trade status `CLOSED` with non-null realised PnL.
4. Trade intent status `EXECUTED`.
5. Timeframe `M5`.
6. Champion model version `external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1`.
7. `signal_source = EXTERNAL_PROVIDER` and provider code is the active ensemble.
8. `plan_b_ensemble_strategy_route = TREND_CONTINUATION`.
9. `decision_policy_version` belongs to `PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS`.

This deliberately excludes legacy/incompatible policy trades.

### Reliability rule

- Fewer than 20 compatible closed continuation trades: `COLLECTING`, no new execution brake.
- At least 20 trades and realised PF < 1.0: `RESEARCH_ONLY`, normal PAPER continuation is demoted.
- At least 20 trades and realised PF >= 1.0: `HEALTHY`.
- If there are losses and no gross profit, PF is 0 and the route is weak.
- If there are no losses and positive gross profit, the route is healthy.

The 20-trade / PF-1.0 boundary matches the existing continuation route reliability semantics rather than creating a new tuned threshold from the observed result.

### Pair/side override

A realised weak route may be overridden only by an existing pair/side decision whose state is `HEALTHY`, which already requires at least 8 independent pair/side episodes and acceptable PF/drawdown. `COLLECTING` pair/side evidence cannot override a mature weak realised route.

This protects genuinely strong continuation sleeves without letting immature sleeves bypass a route-level loss signal.

### Execution behavior

When the realised continuation route is weak and no mature healthy pair/side override exists:

- Set normal PAPER execution false for that continuation candidate.
- Preserve the existing research fallback path, calibration brakes, episode guard and portfolio brakes.
- Do not modify reversal or early-transition execution.
- Do not alter model scores, confidence, entries, SL/TP geometry, broker adapters, DEMO, or LIVE.

### Runtime and failure behavior

- Cache realised route evidence for the same 30-second reliability TTL already used by the collector.
- A data-source/query failure must not invent negative evidence. Treat the signal as unavailable/collecting and log the condition; existing gates remain authoritative.
- The query is read-only and bounded to aggregate values.

## Verification

1. Unit tests for collecting/weak/healthy/no-loss cases.
2. Unit tests for execution composition: weak route + collecting pair/side demotes; weak route + mature healthy pair/side permits; healthy route permits.
3. Collector test proving exact query scoping and current compatible policy versions.
4. Collector test proving continuation normal PAPER is demoted while reversal/early-transition behavior is unchanged.
5. Focused Jest, lint/typecheck, and broader API regression suite as practical.
6. Run the read-only champion audit again and verify current compatible continuation evidence would classify `RESEARCH_ONLY` without changing execution in the audit itself.

## Non-goals

- No retrospective tuning of thresholds.
- No promotion to DEMO/LIVE.
- No model retraining.
- No use of the rejected cross-pair v1 research candidate.
- No deletion of existing shadow reliability telemetry.

## Verification Result — 2026-10-25

The implementation matches this design and passed focused, static, and full API regression gates. The read-only current forward ledger classifies the policy-compatible continuation route as `RESEARCH_ONLY` at 30 trades and PF 0.7021904614, while the overall champion remains provisionally positive. The change is therefore selective: it demotes weak continuation normal-PAPER authority but leaves reversal/early-transition logic unchanged and preserves the controlled PAPER research fallback. No DEMO or LIVE authority is introduced.
