# PAPER Participation Diagnostics Design

## Intent
Make low trade cadence observable without changing execution authority. The system must explain whether recent inactivity came from no qualified market opportunity, soft evidence quality, hard safety, route policy, or portfolio/capacity controls.

## Approach
Extend the existing read-only external-provider diagnostics with a combined M5 + M1 participation snapshot. Reuse persisted adaptive scan summaries, ensemble shadow blockers, M1 tactical decisions, and the last signal-driven trade. Do not write new execution state and do not alter any gate, sizing rule, route, or broker action.

## Semantics
- Observation window: 30 minutes.
- Target is an observation target, not a forced-trade SLA.
- M5 reports latest adaptive scan, evaluated candidates, executable winners, and recent blocker counts.
- M1 reports decision count, non-ABSTAIN route count, PAPER-executable count, and recent blocker counts.
- Blockers are classified as HARD_SAFETY, EVIDENCE_QUALITY, ROUTE_POLICY, CAPACITY, or UNKNOWN.
- Overall state is EXECUTABLE_OPPORTUNITY, RECENT_TRADE, QUALIFIED_BUT_BLOCKED, NO_QUALIFIED_OPPORTUNITY, or NO_RECENT_EVIDENCE.
- Diagnostics are read-only and user-scoped.

## Non-goals
No threshold relaxation, no forced trade cadence, no M1 trend/reversal promotion, no cross-timeframe position lock, and no DEMO/LIVE authority change.
