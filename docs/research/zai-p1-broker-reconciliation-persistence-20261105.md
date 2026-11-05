# z.ai P1 DEMO broker reconciliation persistence — 2026-11-05

This is a **non-executing incremental foundation**, following PR #625's reserved-only exact 0.02-lot cTrader DEMO pilot. No module/controller/AI decision invokes a partial-close broker command. The live trading session is not started, and existing full profit-protection, kill switch, risk, and financial cards are unchanged.

## Reconciliation persistence

A new internal, injectable `DemoPartialCloseReconciliationService` persists a broker-observation result only for a previously `DISPATCHING` or `RECONCILIATION_PENDING` ledger leg. It never transitions a merely `RESERVED` candidate into a reported fill. It acquires a database transaction and row locks on the same user-owned trade and partial-leg records. It verifies:

- cTrader DEMO broker; same persisted broker connection, logical account identity and immutable trade/account currency
- exactly matching original provider-position ID, without inferring a new account or silently using a different position
- independent provider deal ID; exact original 0.0200-lot before size, 0.0100 broker fill, 0.0100 remaining
- gross realized P&L, commission and swap all present with decimal precision (missing cost is never imputed as zero)

Incomplete or inconsistent observations persist `RECONCILIATION_PENDING` and a bounded reason, never economic results. A provider-confirmed complete observation persists `CONFIRMED` and the leg's deal, volumes and financial evidence atomically. Repetition with exactly matching evidence is idempotent; a contradictory already-confirmed deal is rejected without mutation. The new additive migration stores `reconciliation_reason` and `last_reconciled_at`, and tightens the existing table check so `CONFIRMED` requires `economics_complete`.

Importantly, this **does not yet prove where a calling service obtained an observation**. The future cTrader adapter reconciliation must independently read actual cTrader deal history and live broker positions; an optimistic `ORDER_ACCEPTED` response alone cannot be used. This internal service has no REST endpoint or scheduled caller, no ability to dispatch, and all results expose `canDispatchOrder: false`.

## Remaining production blockers before an isolated broker DEMO test

1. Transactionally commit dispatch through `ExecutionOrchestrator`, holding the existing platform controls and broker-account lease. Link the resulting order ID to the reserved ledger ID; no resend after an unknown outcome.
2. Verify broker position and deal evidence from independent read endpoints, including fee/swap sign and currency normalization. Mark uncertain outcomes for durable restart reconciliation.
3. Correct original-vs-remaining lot exposure in existing `Trade`, standard full-close request, emergency Stop, stop-loss/take-profit checks and in-flight race handling. Ensure no stale full-volume close.
4. Aggregate each confirmed partial leg once into realized P&L, costs, daily risk, portfolio allocation and financial cards, **without** double counting its final close. Keep incomplete economic legs out of reported profit.
5. Failure injection, PostgreSQL concurrency, manual broker close and restart tests; only then isolated 0.02 → 0.01/0.01 cTrader DEMO end-to-end UAT. LIVE remains blocked.

No increase in lot sizes, trading frequency or claims of profitability.
