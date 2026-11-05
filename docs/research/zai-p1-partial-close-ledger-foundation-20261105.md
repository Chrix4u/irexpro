# z.ai P1 DEMO partial-close ledger foundation — November 5, 2026

## Status: foundation only; no order dispatch

The selected historical z.ai experiment is a 50% close at an already-triggered full profit-protection exit, leaving 50% protected by the **original broker TP/SL**. Its +0.319R result on 14 resolved historical cases is a narrow hypothetical comparison, not verified account profitability. The user has authorized an expedited cTrader DEMO pilot, not LIVE execution.

This changeset creates an **unused**, additive `trading.demo_partial_close_legs` ledger and pure provider reconciliation proof. It does not modify `ExecutionService.closeTrade()`, any broker adapter, existing P&L reports, risk authorization, AI trading session, or LIVE behavior. Staging migrations must not be run as an execution promotion.

## Durable contract

- Broker fixed to `ctrader`, account type to `DEMO`; broker account ownership and exact account currency must be checked by the future service before inserts.
- Globally unique `client_order_id` prevents replay as another leg, and unique `(broker_connection_id, provider_deal_id)` prevents duplicate provider fills.
- At most one `RESERVED`, `DISPATCHING`, or `RECONCILIATION_PENDING` attempt for the same trade; ambiguous outcomes remain reserved until independently reconciled.
- `CONFIRMED` requires provider deal ID, verified filled lots, pre/post broker volumes and exact conservation. No assumption that a timeout means rejection.
- Account-currency P&L, commission and swap remain nullable until **each** is proven. `economics_complete` cannot be set without all three; historical reporting must exclude incomplete legs rather than substitute zero.
- Volume arithmetic uses 10,000 scaled lots, not floating-point. A successful provider proof is not trade authorization.

## Next implementation gates before a DEMO broker command

1. Wire the new ledger to `ExecutionOrchestrator` reservation/dispatch with transactional account/trade lock, stable idempotency and exact order response mapping.
2. Reconcile broker position before and after, and prove provider deal ID, volume, commission, swap, gross realised P&L; ensure provider sign normalization, account-currency and FX conversion are correct.
3. Update `Trade` remaining lot exposure, stop/TP monitoring, standard full-close quantity (including emergency Stop/kill switch), return/restart path, and race against manual provider close.
4. Integrate each **proven** partial leg once into all realized cards, daily/portfolio risk, trade history, win-rate denominator policy and fee totals, without counting the same economic result on final close.
5. Test simulated failures (duplicate calls, pending/timeout, crash, broker-rejected close, stale quote, partial provider fill, unrelated account, missing fees and DB retries). Then test an isolated **0.02 → 0.01 + 0.01** trade on cTrader DEMO only.
6. Run monitored, small-size A/B accounting for commissions and swaps. Permit a pilot only after all invariants pass; never start an ended AI session automatically.

**Do not represent this ledger foundation as a deployed executable z.ai partial-exit strategy.**
