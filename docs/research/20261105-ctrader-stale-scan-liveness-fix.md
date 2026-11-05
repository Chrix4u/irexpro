# cTrader DEMO: distinguish stale scanning from rejected setups — 2026-11-05

## Observed staging evidence (read-only)

At 21:38–21:40 UTC, one cTrader DEMO FULL_AUTO session remained active for approximately 513 minutes, with no broker-authorized new entry during the last hour. In the session-scoped three-pair 60-minute window there were 307 M1 evaluations, 63 non-ABSTAIN candidates, one Plan-B paper-admitted candidate and zero PRIMARY_PLAN_B or broker-authorized entries. The one admitted EURUSD continuation candidate had governance authority path BLOCKED and recorded DRIFT_STRESSED; no order was sent.

Separately, the latest persisted M1 evaluations on AUDUSD, EURUSD and GBPUSD were at approximately 21:30–21:31 UTC, already 9–10 minutes old. Recent cTrader quote collector warnings reported stale matching spot timestamps on all six symbols and provider-native M5 history with last completed bar at 21:25 UTC, over 12–14 minutes old. Four PM2 processes and the website were online. Those service-level process checks did not prove current broker-native market-data freshness. No broker quote was replaced with a synthetic price, and no provider-side outage was conclusively diagnosed.

## Safety-bounded improvement

The existing account-bound, read-only entry-diagnostics SQL now computes seconds since the latest evaluated decision among the three DEMO entry pairs, within the same current session and 60-minute cohort. The timestamp itself, account IDs, broker connection IDs, positions and order IDs are not returned. No query is writable.

A new STALE_SCAN_EVIDENCE diagnostic state takes precedence over scanning and even over historical broker authorization when the last scoped decision is at least 240 seconds old. If no current-session decisions exist in the hour the existing NO_RECENT_SCANS state remains. An inactive session returns null age and NO_ACTIVE_SESSION. Counts remain historical for the past 60 minutes and are not interpreted as live quotes or fresh authority.

The web contract validates the new nullable non-negative age and rejects malformed/missing data. The AI Trading control card flags old scan evidence in plain language, explains that the broker quote feed or scanner may be delayed, and makes clear that fresh provider quotes and all existing approvals are still required. No execution engine, risk limits, commission, lot sizing, session Start/Stop, retry, OOD promotion or safety reset logic changes.

## Validation and remaining work

- Backend Jest covers missing session, normal candidate scanning, older authorized decisions, 240-second stale threshold, missing age, and account/pair-scoped read-only SQL.
- Frontend Jest covers the strict response contract and visible liveness warning.
- CI typecheck/lint and staging verification remain required before calling the fix deployed.
- Do not claim this diagnostic makes trade entry possible; continue investigating why provider-native cTrader timestamps were stale and why new signals fail net-of-fee admission. No automatic order should be placed from old evidence.
