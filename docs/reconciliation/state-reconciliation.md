# State Reconciliation — Internal State vs Provider State

**Sprint 50 PR-4 · Directive PHASE G + §25/§26/§29/§30**

Production live-account systems require reconciliation between what iRexPro
believes and what the broker actually holds. This document describes the
single authoritative reconciliation loop, its discrepancy taxonomy, its
resolution policy, and its concurrency model.

```
scheduled worker (BullMQ, 60s, stable job identity)
        │
        ▼
candidate connections (any connection with non-terminal orders,
                       live/pending trades, or a stored account snapshot)
        │  sequential per connection (stateful adapters)
        ▼
StateReconciliationService.runForConnection(connection)
        │
        ├─ 1. persist RUNNING run row                (§29 visibility)
        ├─ 2. connect adapter (decrypt → connect → ZERO credentials)
        ├─ 3. read provider state: listOrders + getOpenPositions + getAccountInfo
        │      (failure → run FAILED + CRITICAL audit — never fabricate)
        ├─ 4. read internal state: non-terminal orders, live trades,
        │      STORED account snapshot (pre-sync — drift is observed before
        │      it is converged)
        ├─ 5. pure comparator diff                   (all §25 categories)
        ├─ 6. persist discrepancies (OPEN-row dedup) + surface NEW findings
        │      (user events + WARNING/CRITICAL audits — never hidden)
        ├─ 7. safe auto-resolution (see policy below) + resolve rows
        ├─ 8. sync the account snapshot from provider truth
        └─ 9. finalize the run row + publish reconciliation.run.completed
```

## Discrepancy taxonomy (exactly Directive §25)

| Type | Severity | Meaning | Auto-resolves? |
|---|---|---|---|
| `MISSING_INTERNAL_ORDER` | CRITICAL | Provider holds a working order we have no record of (externally placed) | No — importing would fabricate history |
| `UNKNOWN_PROVIDER_ORDER` | WARNING | Provider reported an order state we cannot classify | No — fail-closed on ambiguity |
| `MISSING_PROVIDER_ORDER` | WARNING | Internal non-terminal order the provider reports nothing about | Only via stable-identifier lookup (§26); if unfound, stays OPEN |
| `UNKNOWN_PROVIDER_POSITION` | CRITICAL | Provider open position with no internal record | No — surfaced for review |
| `STALE_ORDER_STATE` | WARNING | Internal order state lags the provider-reported state | Yes — provider is authoritative (§24) |
| `POSITION_CLOSED_EXTERNALLY` | WARNING | Internal position OPEN; provider no longer holds it | Yes — trade converges to CLOSED with best-effort provider economics |
| `DUPLICATE_PROVIDER_ID` | CRITICAL | Two internal records claim the same provider identifier | No — requires investigation |
| `UNRESOLVED_EXECUTION_RESULT` | WARNING | RECONCILIATION_PENDING beyond grace (5 min) without resolution — including the previously silent case of records WITHOUT an external id | Yes when the provider lookup succeeds; otherwise stays OPEN |
| `ACCOUNT_STATE_MISMATCH` | WARNING (CRITICAL if structural) | Stored account snapshot diverges from provider account info beyond tolerance | Yes — snapshot re-synced (drift converged) |

Tolerances: monetary account fields compare with a 0.5% relative tolerance
plus a 0.01 absolute floor (market movement between sync and read);
currency/leverage mismatches are structural (no tolerance).

## Resolution policy (fail-closed, provider-authoritative but never reckless)

**Auto-resolves** only when provider truth is unambiguous:

- full external position close → trade `OPEN/RECONCILIATION_PENDING → CLOSED`
  (guarded update; linked entry order resolved `FILLED`)
- `RECONCILIATION_PENDING` trade whose position exists → recovered `OPEN`
- order resolution by stable identifier (Directive §26): `getOrderById`
  queries the provider (open set first, then history by ticket). Terminal
  provider states (`FILLED`/`CANCELLED`/`REJECTED`/`EXPIRED`) are applied
  through the `OrderStateMachine`; missed fill deltas flow through
  `OrderService.applyFill` (exact-decimal, overfill fail-closed). MetaAPI
  history still synchronizing → "not found yet" (null) — retried next run,
  never guessed.

**Never auto-resolves** (surfaced, awaiting human/admin action — PR-5/6
expose them): externally-placed activity (`MISSING_INTERNAL_ORDER`,
`UNKNOWN_PROVIDER_POSITION`), duplicate identifiers, unknown provider
states, missing provider orders that cannot be looked up, unresolved
executions without stable identifiers.

## Persistence (§25 "persist or surface")

- `reconciliation.runs` — one row per pass per connection: status
  (`PENDING/RUNNING/COMPLETED/COMPLETED_WITH_WARNINGS/FAILED`), comparison
  counters, outcome counters, bounded error summary, safe metadata.
- `reconciliation.discrepancies` — one row per finding with identity refs
  (internal ref, provider ref, client order id), safe details
  (expected vs observed — decimal strings, enums), and lifecycle
  (`first_detected_at`, `last_seen_at`, `resolved_at`, `resolution`,
  `resolved_by`).
- Dedup: partial unique index on
  `(connection, type, COALESCE(internal_ref_id,''), COALESCE(provider_ref,''))`
  over OPEN rows. Re-detection refreshes `last_seen_at`/details; a resolved
  drift that reappears opens a fresh row (honest history).
- CHECK constraints reject out-of-enum values and inconsistent OPEN/RESOLVED
  row shapes at the database level.

## Surfacing

- Audit: `RECONCILIATION_RUN_STARTED/COMPLETED/FAILED`,
  `RECONCILIATION_DISCREPANCY_DETECTED/RESOLVED`,
  `RECONCILIATION_ACCOUNT_SYNCED`; trade/order convergence reuses
  `TRADE_CLOSED`, `TRADE_RECONCILED`, `ORDER_RECONCILED` with
  `metadata.source: 'state-reconciliation'`.
- Realtime (frontend-safe payloads only): `reconciliation.run.completed`,
  `reconciliation.discrepancy.detected`, `reconciliation.discrepancy.resolved`
  forwarded to `user:{userId}` rooms. PR-4 also wires the previously
  defined-but-unforwarded `trade.reconciliation_pending` event.

## Concurrency model (§30)

| Race | Protection |
|---|---|
| Execution racing reconciliation on the same order | Order mutations go through `OrderService` optimistic transitions (`WHERE status = expected`) — a racing execution fails loudly or the resolution no-ops |
| Racing trade mutations | Conditional `UPDATE ... WHERE status = expected`, rowCount-gated; state-machine asserted before mutation |
| Duplicate provider event | Discrepancy resolution is a guarded `WHERE status = 'OPEN'` update — the second event no-ops; plus the OPEN-row dedup index |
| Reconciliation racing reconciliation | Discrepancy persistence/resolution batches run inside `pg_advisory_xact_lock(connectionId)` short transactions |
| Duplicate scheduling | BullMQ repeatable job identity (one run per 60s; producers strip stale repeatables on boot) |
| Stateful adapter sessions | The worker processes connections SEQUENTIALLY (MetaTrader adapter sets `currentAccountId` per connect — the previous concurrent per-trade fan-out could interleave sessions) |

Provider network I/O never happens inside a persistence transaction.

## Queue / worker semantics (§29)

- Stable job identity: `trade-reconciliation` queue / `reconcile-open-trades`
  job (repeatable, 60s). Restart-safe: producers remove stale repeatables on
  module init; runs are idempotent (guarded mutations + dedup), so a worker
  restart never duplicates effects.
- Failures are distinguishable: provider read failures → run `FAILED` +
  CRITICAL audit + error summary; per-item resolution errors → counted,
  summarized, retried next run (run still completes).

## Provider read contract additions

`IBrokerAdapter.listOrders()` — provider working orders normalized to
`BrokerOrderState` (fill math = requested − remaining; unrecognized states →
`UNKNOWN`, fail-closed). `IBrokerAdapter.getOrderById(id)` — single order by
stable identifier including completed/history orders (null when unknown or
history still synchronizing). MetaTrader implements both via
`getOrders()`/`getHistoryOrdersByTicket`; the paper broker tracks its
simulated fills/orders/positions in memory so paper connections reconcile
truthfully (previously every OPEN paper trade looked broker-closed).

## Account snapshot sync

The run compares the STORED snapshot (pre-sync) against provider account
info, then converges via `BrokerService.applyProviderAccountSnapshot` —
which, unlike the health check's balance/equity-only upsert, also refreshes
margin, freeMargin, marginLevel, leverage, currency, and open-positions
count.

## Related

- `docs/orders/order-domain.md` — the order/position domain PR-4 converges onto
- Directive §24 — provider acknowledgement is authoritative for
  provider-side state
- Migration `1753700000000-CreateStateReconciliation`
