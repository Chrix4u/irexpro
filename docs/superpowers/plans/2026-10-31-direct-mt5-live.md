# Direct MT5 Native LIVE Capability Implementation Plan

Spec: `docs/superpowers/designs/2026-10-31-direct-mt5-live.md`

## Task 1 — Protocol v2 and terminal environment identity
- RED: tests require accountType on protocol, client pairing/heartbeat, settings, and account identity.
- GREEN: detect MT5 trade_mode DEMO/REAL; refuse CONTEST; bind accountType everywhere; bump protocol to v2.

## Task 2 — Server pairing, persistence, and execution authorization
- RED: tests for LIVE pairing environment match, LIVE heartbeat no auto-authorization, environment switch suspension, and LIVE PLACE_ORDER lease authorization.
- GREEN: add connector account_type migration, bind it in pairing/auth/heartbeat/commands, make adapter DEMO/LIVE with observed-mode cross-check, preserve fail-closed authorization.

## Task 3 — Complete Windows MT5 broker surfaces
- RED: tests for normalized account snapshot, price, symbols, OHLCV, positions/orders, order lookup, history, close-all, and server payload mapping.
- GREEN: implement all server-declared protocol commands with decimal-string normalized outputs and exactly-once mutation journal unchanged.

## Task 4 — Catalog and certification readiness
- RED: registry tests expect Direct MT5 DEMO+LIVE technical capability but NOT production-LIVE eligibility.
- GREEN: update catalog/docs; add operator-only Direct MT5 certification entrypoint/documentation without changing productionLiveVerification.

## Task 5 — Verification and deploy
- Run focused API + Python connector tests, broader broker/execution regressions, migrations/build.
- Self-review whole branch (no subagent tool available), fix Important/Critical findings via RED→GREEN.
- Cherry-pick to deploy branch, run migration, restart staging API, verify health and git sync.

## Global constraints
- Never enable production LIVE without durable real-provider certification evidence.
- Never store/log broker passwords or connector tokens.
- Never allow old connector protocol versions to dispatch LIVE commands.
- Preserve idempotency/uncertain-outcome behavior and risk-reducing exit paths.
