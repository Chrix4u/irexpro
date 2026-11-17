# AUDUSD BUY 1.72-lot DEMO closing settlement still unverified — 17 Nov 2026

Owner-reported screenshot at 02:48 UTC shows a CLOSED AUDUSD BUY with 0.67383000 entry, 1.72 lots, +$49.88 peak floating P&L, no exit price, no realized P&L, no commission, no swap, and generic BROKER CLOSE reason.

## Verified execution chronology

- Original broker-native position opened 02:31:19.405 UTC.
- After tiered DEMO profit protection deployed, the owner-scoped service logged a 65% broker-net peak retention close decision at 02:38:00 UTC: observed peak $49.88 (0.58R against $86 initial risk), threshold $32.422, current floating mark $30.96, conservative extra fee reserve $10.32, and `legacy55WouldClose=false`.
- At 02:38:02.727 UTC, `TRADE_CLOSE_REQUESTED` persisted with `closeReason=PROFIT_PROTECTION`.
- At 02:38:05 UTC, an independent state-reconciliation service marked the trade CLOSED with `closeReason=BROKER_CLOSE`; the provider returned no uniquely matched closed-deal economic settlement. Close-order status was `RECONCILIATION_PENDING` and linked audit stated `Provider reported FILLED without a fill price — outcome cannot be recorded`.
- Audit notes `closeTrade:UNKNOWN` and a later guarded CAS `PRESERVED_NEWER_TRUTH`. This is an uncertain close-dispatch resolution, not evidence that broker rejected the close or executed at a particular price.
- At 02:51 UTC, exit_price, realised_pnl, commission and swap remained **NULL**. **Do not count as net profit, show $0, infer a P&L from a peak mark, or label the generic BROKER_CLOSE as provider-proven SL/TP/manual.**

## Existing recovery and exact UI improvement

`StateReconciliationService` already inspects `CLOSED` Pepperstone cTrader DEMO positions with all three economic fields NULL for delayed provider settlement (throttled per connection), attempts an exact position id recovery from a broker-native FILLED entry order, then only performs a NULL-only guarded financial update if exactly one full-volume provider deal has matching position ID, entry price, timing and complete signed commission/swap. A provider deal has **not yet been confirmed** for this example. The periodic reconciliation remains running; no synthetic update was performed.

The `/trade` completed-position view now clearly distinguishes `Broker settlement pending` on a CLOSED position whose exit/final financial fields remain missing, shows `Awaiting broker` for absent realized P&L, and explains that recorded peak P&L is floating, not settled profit. The full trade data and existing generic close-reason attribution remain intact; no existing API/account/trading/risk/broker orders change.

Verification: pure UI null/zero/stale-state tests plus production trader regression suite. A production Next.js build and web process restart are required to publish. Keep this issue open until broker-verified close price, realized P&L and charges have been reconciled, or an explicit provider-unavailable reason is displayed to the owner.
