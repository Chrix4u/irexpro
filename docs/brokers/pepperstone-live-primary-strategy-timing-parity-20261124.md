# Pepperstone LIVE — DEMO primary strategy-timing parity

Owner intent: LIVE trading should use the same *primary strategy* definitions
as the successful DEMO connection, rather than lose legitimate signals
only because source labels contain DEMO.

## Verified

The protected Pepperstone LIVE account is certified, connected, enabled,
with an ACTIVE FULL_AUTO session. The 2026-11-24 08:23 USDJPY BUY
showed PRIMARY_PLAN_B + M1_TREND_CONTINUATION but was rejected as
SIGNAL_INVALID by an old DEMO-only external-provider gate. That
categorical rejection was repaired and deployed in the parent commit
71f39e9d at 08:29 UTC (API-only).

The original primary Plan-B model supports:
- TREND_CONTINUATION + M1_TREND_CONTINUATION
- EARLY_TRANSITION + M1_EARLY_TRANSITION
- CONFIRMED_REVERSAL + M1_CONFIRMED_REVERSAL
- CONFIRMED_REVERSAL + M1_EARLY_TRANSITION only when the model's
  independent broker-native expert gives unanimous same-side votes
- CONFIRMED_REVERSAL + M1_TREND_CONTINUATION only when the model's
  strict same-snapshot M1/M5 reversal timing bridge is eligible,
  with same-side unanimous fresh native-expert corroboration.

The first LIVE version of the downstream source gate accepted only the
first three identical-label tuples. This update maintains the same
server-owned immutable signal provenance and permits the two **primary**
confirmed reversal handoffs with the original Plan-B authority plus
additional explicit LIVE expert proof: at least three unanimous native
votes, same direction, confidence >=0.70, age 0–120 seconds and the
strict upstream reversalTimingBridge flag for the M1 continuation case.
The timing evidence is computed in the in-process M1 scheduler before
submitting the signal. Externally provided JSON cannot set the
unserializable source proof.

## Not copied from DEMO

DEMO alternative pilot paths, rescue by overridden model veto, M1 ABSTAIN
entries, expired timeboxed trials and multi-lot discretionary DEMO sizing
remain unavailable for LIVE. Historical evidence makes blind promotion
unreasonable: over the last five days DEMO recorded 121 CLOSED
CONFIRMED_REVERSAL + M1 ABSTAIN orders with -$754.50 reported P&L,
36 EARLY_TRANSITION + M1 ABSTAIN CLOSED trades with +$378.88 reported
P&L, and 21 PRIMARY TREND_CONTINUATION + aligned M1 CLOSED trades
with -$261.46 reported P&L. These are raw recorded amounts from highly
variable and often multiple-lot DEMO positions, not proof of positive
risk-adjusted performance or LIVE predictability.

This patch neither increases order count artificially nor changes
entry admission, broker verification, lot caps, margin, quote freshness,
risk, portfolio protection, position concentration, stop-loss sizing
or stop/start controls. All required checks remain in the original
RiskService, broker-snapshot, allocation and final dispatch chain.

As a result, the LIVE account can **evaluate and accept the same
qualified primary route combinations**, but does not necessarily place
an immediate trade. It may reject signals after risk/position sizing,
or wait for new eligible market conditions.

## Tests and release

Run all server signal-origin matrix tests and the central orchestrator
suite. Typecheck/build and verify API compile. Deploy API alone only
with exact-account no-open/no-inflight/no-discrepancy preflight,
durable backup and rollback. Do not place a forced real order for
verification. Release status must be recorded separately from source.
