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
> partial-fill replay defect, hardened per the independent review of PR #805
> (findings 1–6). It is stacked on top of the reconciliation correction
> series documented in
> `docs/runbooks/reconciliation-corrections-release-rollback-20261125.md` —
> read that runbook first for the underlying series, then this one for the
> ledger migrations.

---

## 1. What this series changes

- `apps/api/src/modules/execution/orders/order.service.ts` — `applyFill`
  rewritten: single transaction (row lock `SELECT ... FOR UPDATE` → ledger
  dedup read WITH contradictory-evidence defence → legacy pointer check →
  one-time LEGACY_BASELINE capture → append-only evidence INSERT →
  exact-decimal order UPDATE), `findDealOwner` re-contracted to consult the
  COMPLETE historical evidence and report ambiguity, read API
  `findFillEvidenceByOrderId`.
- `apps/api/src/modules/execution/orders/order-fill-evidence.entity.ts` —
  entity (table `trading.order_fill_evidence`), invariant docs corrected.
- `apps/api/src/database/migrations/1795564800000-CreateOrderFillEvidenceLedger.ts`
  — base migration (see §2).
- `apps/api/src/database/migrations/1795628400000-HardenOrderFillEvidenceLedger.ts`
  — hardening migration (see §2).
- `apps/api/src/modules/execution/orders/order.enums.ts` —
  `OrderFillEvidenceClass` incl. `LEGACY_BASELINE`.
- Specs: `order.service.spec.ts` (updated + new mixed-era/contradiction/
  ambiguity/limitation blocks), `1795564800000-*.spec.ts`,
  `1795628400000-HardenOrderFillEvidenceLedger.spec.ts`,
  `order-fill-evidence.schema-reconciliation.spec.ts`,
  `order-fill-evidence.pg-integration.spec.ts` (real-PG, isolated),
  `execution.pg-integration.spec.ts` (fixture chain extended).
- Docs: `docs/IREXPRO_RECONCILIATION_UNMATCHED_DEALS_AND_EVIDENCE_GAPS_20261125.md`
  (unresolved attribution + evidence-grade limitations — informational).

## 2. Database schema (migrations 1795564800000 + 1795628400000)

`up()` — ADDITIVE, schema-only `CREATE TABLE trading.order_fill_evidence`
with:

- partial unique index `uq_order_fill_evidence_deal`
  `(broker_connection_id, provider_deal_id) WHERE provider_deal_id IS NOT
  NULL AND <> ''` — one native deal proves at most ONE internal fill per
  broker connection;
- append-only row trigger `trg_order_fill_evidence_append_only`
  (UPDATE/DELETE raise);
- `order_id ... REFERENCES trading.orders(id) ON DELETE RESTRICT`;
- exact-decimal `quantity numeric(10,4)` / `price numeric(18,8)`;
- CHECK parity between `evidence_class = 'PROVIDER_DEAL'` and a non-NULL
  `provider_deal_id`.

The HARDENING migration `1795628400000` then adds (independent-review
findings 1/3/5/6):

- evidence class `LEGACY_BASELINE` admitted by both CHECKs (parity: only
  PROVIDER_DEAL requires a deal id; LEGACY_BASELINE MAY carry the retained
  legacy latest-deal pointer; weaker classes carry NULL);
- statement trigger `trg_order_fill_evidence_no_truncate` (BEFORE TRUNCATE
  raise) — the row trigger covers UPDATE/DELETE only and NEVER covered
  TRUNCATE; the escape is the session GUC
  `SET irexpro.allow_ledger_truncate = '1'`, intended for the
  operator/maintenance role under the export-first procedure below (and for
  disposable test fixtures). The GUC grants nothing by itself — TRUNCATE
  privilege on the table is still required; role-privilege review is part of
  the release review;
- pair FK `(order_id, broker_connection_id) REFERENCES trading.orders(id,
  broker_connection_id)` via superkey index `uq_orders_id_broker_connection`
  — a ledger row's connection now provably MATCHES the referenced order's
  connection (the order FK alone did not guarantee this);
- FK `broker_connection_id REFERENCES broker.broker_connections(id) ON
  DELETE RESTRICT` — the connection must exist, and booked evidence blocks
  deleting the connection;
- protective `down()`: REFUSES to run while the ledger holds any row
  (see §3).

**No data rewrite, no backfill:** historical fills are not reconstructed
(rows would be fabricated evidence). Mixed-era orders instead transcribe ONE
`LEGACY_BASELINE` row at their FIRST ledger-era fill (inside the same
transaction): the retained legacy pointer (when the order row still carried
one), the cumulative pre-ledger quantity and the cumulative average price —
a BASELINE SUMMARY of already-booked state, never presented as a
reconstructed per-fill deal, and never counted as a reconstructed
identifier.

`down()` (empty ledger) — drops trigger → function → FKs → restores the
original 4-class CHECKs → drops the superkey index. `down()` (populated) —
refuses (see §3).

Rehearsed up AND down (both migrations, empty AND populated paths) on an
isolated PostgreSQL 16 (real migration chain 1753600000000 → 1795220000000
→ 1795564800000 → 1795628400000) — see the regression evidence in
`order-fill-evidence.pg-integration.spec.ts` and the 21-check rehearsal
`apps/api/scripts/rehearse-order-fill-evidence-ledger.ts`. Production has
NOT been migrated; nothing in this task executed a migration outside the
isolated cluster.

```bash
cd apps/api
pnpm migration:show  -d src/database/data-source.ts   # 1795628400000 must be LAST after deploy
pnpm migration:revert -d src/database/data-source.ts  # reverts ONLY the last migration
```

## 3. Rollback ordering (export-first — ENFORCED, not merely documented)

Revert this series BEFORE the reconciliation correction series if both are
being rolled back (migrations revert newest-first: 1795628400000 →
1795564800000 on top of 1795220000000):

1. (a) quiesce per the operator gate (unchanged from the prior runbook §5);
2. (b) **export the booked accounting evidence and attach it to the change
   record** — a successful empty-schema downgrade is NOT proof that
   populated accounting history can be discarded, and the hardening
   migration's `down()` now ENFORCES exactly that position: it refuses
   while ANY ledger row exists and tells you to export first.

   ```sql
   SELECT * FROM trading.order_fill_evidence ORDER BY recorded_at;
   -- psql: \copy (SELECT * FROM trading.order_fill_evidence ORDER BY recorded_at)
   --        TO 'order_fill_evidence_export_<date>.csv' CSV HEADER
   ```

3. (c) `pnpm migration:revert` reverts `1795628400000`: on a populated
   ledger it throws the protective refusal unless the operator — AFTER the
   export — sets `IREXPRO_DESTROY_LEDGER_EVIDENCE=1` in the migration
   process environment (the refusal message names both the export and the
   override). With the override the hardening's protections are dropped
   WITHOUT attempting the impossible 4-class CHECK restoration (LEGACY_BASELINE
   rows would violate it; the chain's next step drops the table anyway);
   the next `pnpm migration:revert` then reverts `1795564800000` and drops
   the ledger table itself. Order rows and their cumulative quantities are
   untouched by every step;
4. (d) source revert of THIS series only:
   `git revert --no-commit 6d3a652c..<this-series HEAD>` then commit;
5. (e) redeploy the previous candidate.

Rolling back this series alone (keeping the reconciliation series): after
the export the ledger rows booked in the interim are accounted-for
broker-evidence-backed records; the order rows keep their cumulative
quantities, which remain correct either way. If any fills were booked
through the ledger before rollback and the ledger is NOT restored, the
per-deal evidence survives ONLY in the export — that is why step (b) is
mandatory and now enforced.

**After a rollback, duplicate-deal protection is REDUCED to the order-row
pointer state** (latest deal only) plus the export's evidentiary record —
double booking of a redelivered earlier partial fill becomes possible
again (it was possible for the whole pre-ledger life of the system). This
runbook does NOT claim duplicate accounting is impossible: see §6.

## 4. Data written by the new path

Every `applyFill` from this series on books ledger rows in the same
transaction as the quantity increment:

- one per-fill row per fill (including fills with NULL deal ids, recorded
  with their derived evidence class);
- ONE `LEGACY_BASELINE` row, once, at the first ledger-era fill of every
  mixed-era order (quantity booked before the ledger existed).

No other writer touches the table; diagnostics may only read. The
accounting invariant is **era-scoped** (independent-review finding 5):

```
orders.filled_quantity =
    (pre-ledger cumulative quantity — transcribed as the single
     LEGACY_BASELINE row at the first ledger-era fill, when applicable)
  + SUM(quantity of the per-fill rows)
```

- NEW orders (ledger-managed from birth): `filled_quantity ==
  SUM(per-fill rows)` exactly.
- MIXED-ERA orders: `filled_quantity == baseline + SUM(per-fill rows)`
  from the first ledger-era fill onward.
- UNTOUCHED LEGACY orders (pre-ledger quantity, never re-filled since): the
  ledger has ZERO rows for them — the ledger alone does NOT establish
  their historical total (no backfill, by design); their quantity lives
  only on the order row.

## 5. Source-code rollback (Git)

The series is every commit in `6d3a652c..<candidate HEAD>` (validated the
same way as the prior runbook — scratch-worktree revert applies cleanly):

```bash
git log --oneline 6d3a652c..HEAD
git status --porcelain        # must be empty
git revert --no-commit 6d3a652c..HEAD
git commit -m "revert: partial-fill accounting evidence ledger series (rollback to 6d3a652c code state)"
```

## 6. What is guaranteed — and what is NOT (review finding 6 correction)

Earlier documentation claimed the duplicate-deal guards "make double-booking
impossible." That unconditional claim was WRONG and is withdrawn:

- Deal-grade evidence (native deal id present): the partial unique index
  makes replays idempotent and cross-order attribution fail-closed — for
  identifiers the ledger retains, duplicate booking is impossible in
  normal operation. A redelivery with DIFFERENT quantity/price is refused
  as contradictory evidence, not booked.
- Unidentified evidence (NULL deal id): NO replay protection exists — each
  delivery books (the honest limit of evidence without an identifier; the
  caller-side guard applies state-based deltas only when the provider is
  AHEAD). Repeated ambiguous deliveries CAN double-book, and are surfaced
  by the ledger rows themselves (each row records the fact of its own
  booking).
- Pre-ledger history: only the RETAINED latest-deal pointer is preserved
  (LEGACY_BASELINE); the per-fill identifiers destroyed by the old
  pointer-overwrite defect are NOT recoverable — replays of those cannot
  be deduplicated, only replays of the retained pointer can.
- After a ledger rollback (§3): duplicate-deal protection falls back to
  the pointer-only state — see §3.

Immutability qualification: the row trigger refuses UPDATE/DELETE and the
statement trigger refuses TRUNCATE by default — but a privileged session
that sets the escape GUC (and holds TRUNCATE privilege) can still discard
the table; that is an operator decision under this runbook's export-first
procedure, and the protective `down()` refusal keeps the migration path
from reaching the drop accidentally. Append-only is enforced to the full
extent PostgreSQL triggers allow; it is not a substitute for access
control on the database role that owns these objects (role/privilege
review is part of the independent release review).

## 7. Safeguards (unchanged)

- LIVE authority, risk controls, broker verification: untouched by this
  series — it changes accounting persistence only.
- The DEMO-only recovery sweeps and their exclusions are untouched.
- No new real-money execution authority; no strategy changes; no
  production writes; deploy hold remains armed.
- Existing tests were not weakened: the pre-existing `applyFill` mock specs
  were adapted to the new statement sequence with their assertions
  preserved or strengthened; every new assertion is additive.
