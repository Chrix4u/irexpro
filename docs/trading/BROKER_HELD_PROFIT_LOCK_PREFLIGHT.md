# Broker-held profit lock — non-executing stop proposal preflight v1

**Status:** SHADOW / NOT DEPLOYED / NO BROKER WRITES. This artifact is based on
PR #707 and does not itself create a trading strategy, REST API, scheduler,
adapter call, stop-loss amendment, close order or live trading authority.

## Why

Pepperstone tracks the trade's favorable peak, but still has no AI authority to
move its broker-held SL. It can therefore surrender meaningful floating P&L
even while two other strong trades eventually reach TP. A naive +0.5R trailing
exit failed historical after-cost simulation on the 10 November sample.
Consequently a **structurally valid** stop is not an economically **qualified**
profit-protection rule. These are separate release gates.

## Structural checks

Function `validateBrokerStopProposal` takes a current account-owned DEMO
position snapshot and a verified, current *same-account* broker-native bid/ask
quote. It refuses proposals for LIVE accounts, mismatched users, instruments,
broker positions or volumes, non-open positions, unverified broker symbol
precision/tick/minimum-distance metadata, stale quotes, negative spread,
widening the current stop, changing the original TP, already-crossed TP,
or stops too close to the current executable side.

It uses fixed-point decimal comparisons and a positive verified price buffer
for commission/slippage, so a suggested protective SL must be *beyond*
estimated fee-inclusive breakeven. The buffer is **not** assumed correct merely
because a caller supplied it; cost provenance must be independently verified
before any eventual broker integration.

A structurally valid result contains a **candidate only**, explicitly
`executionAuthority: NONE`, `brokerWriteAuthorized: false`,
`brokerStopConfirmed: false`, `autoPromotionEnabled: false`.
No adapter is imported, and no broker order payload is sent.

Function `verifyBrokerStopReadback` separately requires an independently
authenticated broker position read AFTER a successful amendment acknowledgement,
matching exact account and position IDs, the proposed stop, preserved original
TP and open status. It rejects stale or pre-ack snapshots, rejection/timeouts,
mismatched readbacks and closed positions. It never fetches the broker itself.

## Further barriers before a DEMO canary

1. Prove quote and symbol metadata *freshly* originated from the connected
   cTrader broker and cannot be substituted with research/other-account quotes.
2. Verify the exact adapter's position amendment semantics: a missing TP field
   may **not** be a safe way to preserve the TP. Always preserve original TP
   and confirm it read-after-write.
3. Require a separate frozen, prospective strategy with independent after-fee
   evidence, retention of TP runners and auditable drawdown improvement.
4. Serialize proposal/ack/readback with independent close/reconcile events.
   Concurrent close or stop adjustment must fail safely and never widen.
5. Add operator-controlled account-specific enablement with rollback, dry-run
   telemetry, maximum amendment frequency, minimum broker symbol precision,
   hard SL, kill switch and loss-limit invariants.
6. Confirm that broker-held SL protects *net P&L after fees* at executable
   bid/ask, not gross peak alone. Include commissions, swap, slippage, spread,
   stop minimum distances and partial-fill possibility.
7. Validate using isolated DEMO canaries **only after active sessions and
   positions are flat for deployment**. Do not auto-enable for LIVE.

These functions do not authorize any present or future broker write.
