# z.ai P1 cTrader DEMO reservation gate — 2026-11-05

## Scope and current execution status

This change adds a **non-dispatching**, transaction-safe server-side candidate reservation for one exact **0.0200 lot** confirmed-reversal cTrader DEMO position, intending 0.0100/0.0100 for future pilot testing.

The service is an injectable, internal capability; **no API route, AI decision, broker adapter, orchestrator or execution timer calls it**. A successful reservation returns `canDispatchOrder: false` unconditionally. Existing profit-protection full-close and Stop/kill-switch paths remain untouched; no partial execution is currently enabled.

## Admission and invariant checks

The reservation transaction locks the owned open trade row and checks current joined broker account, immutable trade provenance, strategy metadata derived from the original TradeIntent, and its trading session:

- Broker exactly `ctrader` with DEMO account, non-deleted broker connection and matching user.
- Trade `OPEN` with a broker position reference, original position exactly 0.0200 lot; only exact 0.0100/0.0100 split admitted.
- The immutable logical account identity must be present and match the current connection, with account currency consistent across trade, broker and session. It does not infer missing identity.
- Session must still be `ACTIVE` and `FULL_AUTO`; ended or changed sessions fail closed.
- The independently persisted intent metadata must prove `CONFIRMED_REVERSAL`, not merely a claimed route string from the caller.
- The deterministic clientOrderId is bound to the trade. A duplicate returns the same record without dispatch; a conflicting prior record or uniqueness collision is a hard error.
- On database failure there is no fallback and no broker action.

This reservation **is not** permission to order: at future dispatch, broker account, current position volume, original stop/take-profit, fresh reversal trend, commission-inclusive expected R, session generation and emergency control authority must all be verified anew.

## Required before a pilot may place any broker order

1. Add durable transition from RESERVED through committed dispatch to RECONCILIATION_PENDING/CONFIRMED, with exactly one order per ledger ID, no resend of ambiguous attempts.
2. Pre/post broker volume verification and broker **deal ID**, actual gross P&L, commission, swap and currency proof. cTrader's current `ORDER_ACCEPTED` response can be reconciliation-based without an identifiable final deal, and must **not** be treated as ledger-confirmed economics.
3. Add atomic partial-realized account-currency cash ledger, open remainder exposure and provider stop/TP consistency; prevent original full-close using stale original lot volume.
4. Ensure emergency Stop, manual close, adverse-thesis exits, restart/recovery and 5-second profit-protection use verified **remaining** provider lots. Never leave an uncertain position unprotected.
5. Test failures, races, stale reads, partial fills, broker timeout, position drift and reconciling a closed position; run an isolated verified cTrader DEMO 0.02-lot pilot then after-cost A/B testing.

LIVE, MT5, PAPER, larger lots, higher trade frequency and profit claims are explicitly out of scope.
