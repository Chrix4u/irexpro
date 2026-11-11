# iRexPro — Fix false zero six-pair scan diagnostics after broker switching

**11 November 2026 | read-only operational reporting only**

## Root cause
The already-deployed `audit-demo-six-pair-cadence.cjs` report on 11 November
14:18 UTC incorrectly showed **zero evaluations**. A scoped repeatable-read
database query confirmed that the *current* active user-owned
`pepperstone-ctrader` DEMO FULL_AUTO connection had recorded **1,000 M1
decisions in the preceding 90 minutes**. The diagnostic still used the old
`M1_TACTICAL_MARKET_DATA_CONNECTION_ID` environment variable, which
pointed to a different historical connection with zero recent decisions.
The old research-only report additionally allowed only `broker_id='ctrader'`,
excluding the active Pepperstone cTrader family.

This was a **reporting/observability defect**; it did not stop or start the
actual scanner, place any trade, or change its admission rules.

## Corrected scope
Within the SAME bounded `REPEATABLE READ READ ONLY` PostgreSQL transaction:

1. Select the most recent active FULL_AUTO session belonging to the exact
   requested user, joined to a matching un-deleted DEMO broker connection of
   either `ctrader` or `pepperstone-ctrader`.
2. Resolve the broker connection ID from that authorized active session, not
   a stale environment variable or historical broker ID.
3. Apply the existing rollout-policy-v2 pin, six-pair whitelist,
   per-minute aggregation and 60-minute/10-minute cadence windows.
4. If there is no active user-owned cTrader-family DEMO session, fail
   clearly instead of issuing a plausible but false zero-scan report.

No account IDs, credentials, session IDs or raw broker data are included in
the report. Every original validation for overlapping reasons and decision
cadence remains unchanged.

## Actual read-only validation
Running the fixed `runAudit` implementation against the real active
Pepperstone DEMO connection at approximately **15:37 UTC, 11 November 2026**
produced:

- **666** saved M1 evaluations in the prior hour, not zero.
- **60** observed minute slots, with all six pairs in **33** slots.
- **0** broker-authorized entries in that hour.
- Significant out-of-distribution flags across all six pairs.
- EURUSD had fewer observed evaluations than the other five; this warrants
  independent market-data/session analysis, not assumed broker order failure.

Counts reflect **per-candidate scanner evaluations**, not distinct executable
trade opportunities. The OOD and Plan B reasons may overlap. The next
improvement should explicitly distinguish high OOD incidence, Plan B
model admission, broker readiness, and *verified executable* proposals.

## Guardrails
Unit tests check correct user/session/broker joining, current-session
authority order, rollback on absent scope, ignoring a stale configured
connection, and no changes to trading or model state. This change adds no
risk gate, no broker order, no lot-size change, no model promotion, no new
service dependency and no paid provider subscription.
