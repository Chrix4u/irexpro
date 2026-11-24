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

The tool checks the configured owner's unique Pepperstone LIVE account and
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

## Bridge-aware diagnostic (24 November 2026 update)

After LIVE primary timing parity, a Confirmed Reversal Plan-B candidate
may be professionally confirmed by M1 Early Transition or an explicitly
confirmed M1 Trend Continuation reversal bridge. Exact model and M1
labels alone are not the entire primary-model execution policy.

The operator script now reports separate counters for direct strategy
route label matches, model-authorized reversal bridges, persisted
PRIMARY_PLAN_B model authority, actual BROKER_NATIVE decisions, and
subsequent signal/risk/execution rejections. It does not infer a valid
bridge merely from a similar M1 label: the stored primary-model
authorityPath and (for M1 continuation) reversalTimingBridge proof
must already be present. Outcome reasons are bounded and sourced from
the exact owner's decision record; no provider credentials, account ID
or access tokens are displayed.

Observed at 08:57 UTC: 232 recent LIVE decisions, 27 Plan-B-paper
admitted, zero approved model timing bridges, zero direct strategy
matches, zero PRIMARY_PLAN_B approvals, zero BROKER_NATIVE
authorities, no LIVE orders. This is NOT the prior external-provider
rejection: no new fully approved signal reached that boundary in this
window. Quote/spread evidence is fresh and the model records specific
weaknesses such as low EMA separation, low MTF strength and higher-
timeframe conflict, rather than a missing LIVE market-data source.

Minimum-lot diagnostic (not a broker trade test): Current M1 stop
geometry is 0.0005 for EURUSD/AUDUSD/USDCAD and 0.05 for USDJPY,
corresponding to approximately five pips. At $49.93 equity and 0.01
lot, the existing pepperstone-live-micro-risk budget ($0.9986 for 2%)
projects conservative cost-inclusive risks of $0.88 for EURUSD/AUDUSD,
$0.698 for USDCAD and $0.657 for USDJPY. All four pass the policy's
illustrative cost-reserve screen and nominal 30x leverage check. These
calculations do NOT assert provider margin requirements, realized
commission, final RiskService approval, order feasibility or profit.
Do not lift existing risk limits on this evidence alone.
