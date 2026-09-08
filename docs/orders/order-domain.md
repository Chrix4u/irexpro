# Order & Position Domain — Sprint 50 PR-2 + PR-3

Normalized order/position domain: **order model, state machines, idempotency**
(Directive PHASE C) — now **orchestrated end-to-end** by the execution
orchestration slice (Directive PHASE D + F, PR-3): every provider dispatch
flows through `ExecutionOrchestrator` → idempotent order reservation →
adapter dispatch → response mapping → machine-guarded transitions.
User/admin HTTP surface arrives in PR-5/PR-6.

## The problem this slice solves

Before PR-2, `trading.trades` conflated two lifecycles in one row:

| Concern | Conflated location |
| --- | --- |
| ORDER routing (intent → submit → ack → fills) | `trades.status` mutated by scattered raw `repo.update()` calls |
| POSITION exposure (open → manage → close) | same row, same column |
| Client idempotency for manual orders | none — idempotency existed only for signal-scoped keys |
| Provider identifiers | one `external_order_id` for both order AND position |
| Partial fills / avg fill price | none |
| Commission / swap | none |

## The model

### `trading.orders` — the ORDER lifecycle record

```
CREATED ──→ SUBMITTED ──→ ACKNOWLEDGED ──→ PARTIALLY_FILLED ──→ FILLED ✓
   │            │             │                  │
   │            ├── REJECTED ✓ ├─ REJECTED ✓     ├── REJECTED ✓
   │            ├── CANCELLED ✓├─ CANCELLED ✓    ├── CANCELLED ✓ (remainder)
   │            ├── EXPIRED ✓  ├─ EXPIRED ✓      ├── EXPIRED ✓
   │            └── RECONCILIATION_PENDING ──┬────┘
   ├── REJECTED ✓                            (resolves to any observed state)
   └── CANCELLED ✓
```

✓ = terminal (no outgoing transitions; enforced by `OrderStateMachine`).

- **Identifiers**: `client_order_id` (caller-supplied), `provider_order_id`
  (broker-side), `idempotency_key` = SHA-256(`userId:clientOrderId`), UNIQUE.
- **Terms**: `order_kind` (MARKET/LIMIT/STOP/STOP_LIMIT), `time_in_force`
  (GTC/DAY/IOC/FOK), quantity/price — price-argument rules enforced in the
  service AND as the `chk_orders_price_kind` DB CHECK.
- **Fill accounting**: `filled_quantity ≤ requested_quantity`,
  `avg_fill_price` present iff filled > 0 — both DB CHECK constraints.

### `trading.trades` — the POSITION aggregate (evolved)

New nullable columns (conservative NULL backfill): `external_position_id`
(provider position identifier, distinct from order id),
`commission`, `swap`.

### `TradeStateMachine` — centralized position transitions

```
PENDING → OPEN | REJECTED | CANCELLED | RECONCILIATION_PENDING
OPEN → CLOSED | RECONCILIATION_PENDING
RECONCILIATION_PENDING → OPEN | CLOSED
```

All previously-scattered status updates in `execution.service.ts` and
`trade-reconciliation.job.ts` now pass through
`TradeStateMachine.assertTransition()` — an illegal transition throws
instead of silently corrupting state. `isPositionOpen()` is fail-closed
(only OPEN counts as market exposure).

## Idempotency (exactly-once submission)

`OrderService.submitOrder` mirrors the Sprint 32 Gate 3 trade-slot
reservation:

1. Single short transaction: `pg_advisory_xact_lock(user)` →
   SELECT by idempotency key → INSERT `CREATED` order.
2. SQLSTATE `23505` on INSERT → re-SELECT → `DUPLICATE_EXISTING`.
3. Broker network I/O happens AFTER the transaction returns — never inside.

Same `clientOrderId` → same key → the duplicate call returns the existing
order. Different users never collide (key includes `userId`).

## Decimal safety

`applyFill` computes the volume-weighted `avg_fill_price` **inside
PostgreSQL** using exact `numeric` arithmetic — never in JS floats.
Overfills fail closed (`WHERE filled_quantity + $qty <= requested_quantity`).

## DB CHECK constraints (migration 1753600000000)

Even if application logic is bypassed, the database rejects:
out-of-enum statuses/kinds/TIFs/directions, non-positive quantities,
`filled_quantity > requested_quantity`, avg-price/fill inconsistency,
price arguments that don't match the order kind, and fills on never-submitted
orders.

## Test coverage

- `order-state-machine.spec.ts` — exhaustive transition table
- `trade-state-machine.spec.ts` — exhaustive transition table
- `order.service.spec.ts` — idempotency (incl. 23505 race), fail-closed
  validation, terminal guards, optimistic concurrency, overfill rejection
- `order.schema-reconciliation.spec.ts` — entity ↔ migration consistency

## Roadmap (later PRs)

- ~~**PR-3**: execution orchestration routes through the order domain~~
  **DONE** — `ExecutionOrchestrator` (modules/execution/orchestration/):
  fail-closed pre-dispatch gates (emergency control plane + LIVE
  authorization), exactly-once dispatch per `clientOrderId`, pure
  provider-response mapping, `order.*` events + `ORDER_*` audit trail,
  close-position orchestration, and reconciliation-resolution of linked
  orders. Signal path: `sig-{signalId}`; close path: `close-{tradeId}[-n]`.
- **PR-5**: user-facing order APIs (place/cancel/list) using
  `clientOrderId`.
- **PR-6**: admin/observability projections.
