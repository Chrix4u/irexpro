# Pepperstone LIVE entry funnel — account-scoped, read-only

A valid Pepperstone cTrader LIVE connection and ACTIVE FULL_AUTO session
permit entry evaluation, not automatic execution of every Plan-B signal.

The mobile AI Trading page formerly said "Executable-pair focus" even
while a setup was blocked. It now displays "Setup under evaluation"
unless the normal readiness classifier actually expects a trade, while
preserving "Research-only focus" for excluded scan pairs.

## Read-only operator diagnostic

From the VPS:

    cd /home/lightworld/webapps/irexpro-staging/apps/api
    node scripts/validation/pepperstone-live-entry-gates-ro.cjs

The tool checks exact Pepperstone LIVE account 49506270, exact owner and
connection, active session, last 30 minutes of M1 decisions and recorded
order counts. It distinguishes independent Plan-B admission, M1 route
qualification, their co-occurrence, exact matching strategy route,
broker-native execution authority and submitted orders.

A Plan-B CONFIRMED_REVERSAL proposal with an M1_EARLY_TRANSITION
impulse is not full route agreement. The model must independently
authorize the decision before a zero-order result implies broken dispatch.

The separately configured legacy trained-shadow expert may still
observe a historical DEMO source. Its read-only observations do not
replace the active LIVE M1 scanner and have no broker-order authority.

Example at 2026-11-24 07:25 UTC: 230 LIVE M1 decisions, 33 Plan-B
admitted, 38 with an M1 route, 6 with both in one decision, zero exact
strategy-route matches, zero final execution-authority grants, zero
LIVE orders. Counts change as the rolling window advances.

The audit uses BEGIN READ ONLY and ROLLBACK. No market orders,
database mutations, LIVE activation changes or gate relaxations.
