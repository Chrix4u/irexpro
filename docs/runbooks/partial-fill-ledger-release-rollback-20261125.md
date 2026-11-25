# Partial-Fill Accounting Evidence Ledger — Release & Rollback Runbook (2026-11-25)

**Candidate branch:** `fix/partial-fill-accounting-evidence-ledger-20261125`
**Series base:** `6d3a652c` (`fix(audit): apply explicit UTC statement window boundaries` —
the verified baseline with 28/28 GitHub CI workflows green and PR #804 open)
**Status:** release candidate for independent review. **No production
reconciliation, deployment or data write has occurred.** The operational
hold `DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt` remains armed and is removed
only through the operator review step (see §5 of the prior runbook
`reconciliation-corrections-release-rollback-20261125.md`).

> This series is the accounting-integrity correction for the confirmed
> partial-fill replay defect. It is stacked on top of the reconciliation
> correction series documented in
> `docs/runbooks/reconciliation-corrections-release-rollback-20261125.md` —
> read that runbook first for the underlying series, then this one for the
> ledger migration.

---

## 1. What this series changes

- `apps/api/src/modules/execution/orders/order.service.ts` — `applyFill`
  rewritten: single transaction (row lock `SELECT ... FOR UPDATE` → ledger
  dedup read → append-only evidence INSERT → exact-decimal order UPDATE),
  ledger-based replay detection for ANY historical fill identifier, legacy
  pointer check for the pre-ledger population, read API
  `findFillEvidenceByOrderId`.
- `apps/api/src/modules/execution/orders/order-fill-evidence.entity.ts` —
  new entity (table `trading.order_fill_evidence`).
- `apps/api/src/database/migrations/1795564800000-CreateOrderFillEvidenceLedger.ts`
  — new migration (see §2).
- `apps/api/src/modules/execution/orders/order.enums.ts` — new
  `OrderFillEvidenceClass` enum.
- Specs: `order.service.spec.ts` (updated + new ledger regression block),
  `1795564800000-CreateOrderFillEvidenceLedger.spec.ts`,
  `order-fill-evidence.schema-reconciliation.spec.ts`,
  `order-fill-evidence.pg-integration.spec.ts` (real-PG, isolated).
- Docs: `docs/IREXPRO_RECONCILIATION_UNMATCHED_DEALS_AND_EVIDENCE_GAPS_20261125.md`
  (unresolved attribution — informational, no operational change).

## 2. Database schema (migration 1795564800000)

`up()` — ADDITIVE, schema-only `CREATE TABLE trading.order_fill_evidence`
with:

- partial unique index `uq_order_fill_evidence_deal`
  `(broker_connection_id, provider_deal_id) WHERE provider_deal_id IS NOT
  NULL AND <> ''` — one native deal proves at most ONE internal fill per
  broker connection;
- append-only trigger `trg_order_fill_evidence_append_only` (UPDATE/DELETE
  raise);
- `order_id ... REFERENCES trading.orders(id) ON DELETE RESTRICT`;
- exact-decimal `quantity numeric(10,4)` / `price numeric(18,8)`;
- CHECK parity between `evidence_class = 'PROVIDER_DEAL'` and a non-NULL
  `provider_deal_id`.

**No data rewrite, no backfill:** historical fills are not reconstructed
(rows would be fabricated evidence). Pre-ledger fills stay replay-protected
by the order-row pointer check in `applyFill`.

`down()` — drops trigger → function → table (indexes go with the table).
Order rows and their identifiers are untouched by both directions.

Rehearsed up AND down on an isolated PostgreSQL 16 (real migration chain
1753600000000 → 1795220000000 → 1795564800000 applied to an empty schema)
and re-run idempotently — see the regression evidence in
`order-fill-evidence.pg-integration.spec.ts` ("migration rollback
rehearsal"). Production has NOT been migrated; nothing in this task
executed a migration outside the isolated cluster.

```bash
cd apps/api
pnpm migration:show  -d src/database/data-source.ts   # 1795564800000 must be LAST after deploy
pnpm migration:revert -d src/database/data-source.ts  # reverts ONLY the last migration
```

## 3. Rollback ordering

Revert this series BEFORE the reconciliation correction series if both are
being rolled back (migrations revert newest-first; 1795564800000 sits on
top of 1795220000000):

1. (a) quiesce per the operator gate (unchanged from the prior runbook §5);
2. (b) `pnpm migration:revert` — drops the ledger table (additive; the
   running pre-revert code tolerates the table's absence only after source
   revert, so do (c) immediately after);
3. (c) source revert of THIS series only:
   `git revert --no-commit 6d3a652c..<this-series HEAD>` then commit;
4. (d) redeploy the previous candidate.

Rolling back this series alone (keeping the reconciliation series): the
ledger rows booked in the interim are accounting evidence — dropping the
table destroys append-only history. If any fills were booked through the
ledger before rollback, the operator must enumerate them first:

```sql
SELECT * FROM trading.order_fill_evidence ORDER BY recorded_at;
```

...and attach the export to the change record (the rows are
broker-evidence-backed per-fill records; the order rows keep their
cumulative quantities, which remain correct either way).

## 4. Data written by the new path

Every `applyFill` from this series on books exactly one ledger row in the
same transaction as the quantity increment (including fills with NULL deal
ids, recorded with their derived evidence class). No other writer touches
the table; diagnostics may only read. The accounting invariant is
`orders.filled_quantity = SUM(order_fill_evidence.quantity)` per order.

## 5. Source-code rollback (Git)

The series is every commit in `6d3a652c..<candidate HEAD>` (validated the
same way as the prior runbook — scratch-worktree revert applies cleanly):

```bash
git log --oneline 6d3a652c..HEAD
git status --porcelain        # must be empty
git revert --no-commit 6d3a652c..HEAD
git commit -m "revert: partial-fill accounting evidence ledger series (rollback to 6d3a652c code state)"
```

## 6. Safeguards (unchanged)

- LIVE authority, risk controls, broker verification: untouched by this
  series — it changes accounting persistence only.
- The DEMO-only recovery sweeps and their exclusions are untouched.
- No new real-money execution authority; no strategy changes; no
  production writes; deploy hold remains armed.
- Existing tests were not weakened: the pre-existing `applyFill` mock specs
  were adapted to the new statement sequence (row lock → ledger read →
  INSERT → UPDATE) with their assertions preserved or strengthened.
