# PAPER confirmed-reversal pair-side reliability design

## Intent
Protect PAPER profitability without suppressing every reversal signal. The current NORMAL_PAPER reliability gate only covers TREND_CONTINUATION, while the same active policy has produced a negative confirmed-reversal cohort. The goal is to close that blind spot using the same independent episode evidence and mature pair-side thresholds already trusted for continuation trades.

## Evidence
- Post-14:29:08 UTC control is healthy on SHA c77bc474.
- First new trade is USDJPY BUY via NORMAL_PAPER, not a quarantined research lane.
- Historical NORMAL_PAPER confirmed-reversal closes under the same policy: 5 trades, 2 wins, 3 losses, about -1.32R total.
- This is too small for a blanket route ban, and USDJPY BUY itself has positive local history.

## Goals
- Apply pair-side reliability to CONFIRMED_REVERSAL as well as TREND_CONTINUATION.
- Use the existing 8-independent-episode maturity threshold, PF >= 1.0, and max DD <= 12% rules.
- Keep insufficient local evidence executable; do not infer weakness from route-wide losses alone.
- Leave EARLY_TRANSITION unchanged.
- Do not change LIVE/DEMO authority, model admission, net-R, drift, event-risk, sizing, broker permissions, or the currently open trade.

## Approaches considered
1. Blanket-ban confirmed reversals from the recent route loss cluster. Rejected: overfits five executed samples and would suppress locally positive sleeves such as USDJPY BUY.
2. Route-wide confirmed-reversal reliability brake with local overrides. Rejected for now: larger behavioral surface and more policy complexity than the evidence justifies.
3. Extend the existing pair-side reliability gate to confirmed reversals. Chosen: smallest fail-closed change, reuses proven episode collapsing/metrics, and only demotes mature weak local sleeves.

## Design
- Keep the existing reliability artifact and thresholds for continuity.
- Treat TREND_CONTINUATION and CONFIRMED_REVERSAL as pair-side reliability-gated routes.
- Parameterize the collector's pair-side reliability evidence query by strategy route.
- Run route-wide trend reliability only for TREND_CONTINUATION; for CONFIRMED_REVERSAL it remains not applicable/diagnostic-neutral.
- When a confirmed-reversal pair-side reaches 8 independent episodes and is weak by PF or drawdown, demote NORMAL_PAPER execution so downstream research handling may evaluate it under existing rules.
- Snapshot/API telemetry remains continuation-oriented for now to avoid changing its route-less response shape.

## Non-goals
- No threshold relaxation.
- No new route-wide reversal block.
- No change to v11 research throughput.
- No change to extension-exhaustion, rejected-edge canary, or paired-reversal quarantine.
- No change to the open USDJPY trade.
