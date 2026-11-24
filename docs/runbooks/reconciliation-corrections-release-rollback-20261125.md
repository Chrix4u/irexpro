# Reconciliation Corrections — Release & Rollback Runbook (2026-11-25)

**Candidate branch:** `fix/stranded-close-order-convergence-20261125`
**Correction series base:** `b2631183` (`diagnostics(reconciliation): separate live and demo ledger integrity counts` — the last commit of the pre-correction line)
**Status:** release candidate for independent GitHub CI and release review. **No production reconciliation or deployment has occurred.** The operational hold `DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt` remains armed; it is removed only through the operator review step (see §5).

> This runbook corrects the rollback commands published in the earlier
> engineering report: the documented range `git revert a40bfe4..b5b1419`
> was **incorrectly ordered and reverted an empty set** (b5b1419 is an
> ancestor of a40bfe4, so `a40bfe4..b5b1419` excludes every commit — the
> command was a no-op). The ranges below were validated by mechanically
> applying them to the candidate in a scratch worktree before publication.

---

## 1. Source-code rollback (Git)

The correction series is every commit in `b2631183..<candidate HEAD>`.
Roll back the whole series (newest → oldest, git revert orders a range
automatically):

```bash
# 1. Confirm the exact series and that the working tree is clean:
git log --oneline b2631183..HEAD
git status --porcelain        # must be empty

# 2. Revert the entire correction series as one reviewable change:
git revert --no-commit b2631183..HEAD
git commit -m "revert: reconciliation correction series (rollback to b2631183 code state)"

# 3. Alternative for a hard rollback (single-authoritative ref, discards history):
#    git revert is preferred for an audited release; reset is for local scratch only:
#    git reset --hard b2631183        # NEVER on the shared branch
```

Validation performed for this runbook: `git revert --no-commit b2631183..HEAD`
applied to the candidate in a scratch worktree with **no conflicts**, and the
resulting tree matched the base code state for every file the series touched.

Do **not** use ranges with the newer commit first (`git revert <new>..<old>`
is empty); always `git revert <base>..<candidate>`.

## 2. Database schema rollback (migration revert)

`1795220000000-AddOrderProviderNativeIdentifiers` is additive and reversible;
rehearsed up AND down on an isolated PostgreSQL (15/15 checks): existing rows
untouched, columns + CHECK + partial unique index created/dropped cleanly,
re-run idempotent.

```bash
cd apps/api
pnpm migration:show  -d src/database/data-source.ts   # confirm 1795220000000 is the LAST applied
pnpm migration:revert -d src/database/data-source.ts  # reverts ONLY the last migration (down() drops the two columns + index)
```

Ordering rule: **schema revert before/with source revert, never after the old
code is already redeployed and running reconciliation.** The reverted code
runs safely against a schema that still has the two nullable columns
(additive, NULL-safe); the reverse is not true once `provider_order_id`
semantics changed (native ORDER id instead of POSITION id for cTrader MARKET
fills). Rollback sequence: (a) quiesce (§5), (b) `migration:revert`, (c)
source revert (§1), (d) redeploy the previous candidate.

If later migrations land on top of 1795220000000, reverting only the orders
identifier migration requires reverting the later ones first —
`migration:revert` walks backward one migration per call.

## 3. Previously committed reconciliation writes (data, NOT reverted by §1/§2)

Code and schema rollback do **not** undo reconciliation writes that were
already applied by the recovery/convergence paths before the rollback. Those
writes are order-row fills booked through the guarded `applyFill` CAS and
NULL-only settlement backfills; each one is individually enumerable and
re-derivable:

```sql
-- Enumerate every recovery-booked close-order fill (auditable, reversible):
SELECT id, trade_id, provider_order_id, provider_position_id, provider_deal_id,
       filled_quantity, avg_fill_price, status, updated_at
FROM trading.orders
WHERE provider_deal_id IS NOT NULL OR provider_position_id IS NOT NULL;
```

Properties that bound any remediation:

- Re-running the sweeps after a rollback re-derives the same fills or fails
  closed; the duplicate-deal guards (idempotent `applyFill`, ownership
  pre-check, partial unique index `uq_orders_provider_deal_id`) make
  double-booking impossible.
- The convergence paths never mutate trades, balances, realised P&L,
  commissions or swaps of already-closed trades; the only trade-side write is
  the pre-existing NULL-only settlement backfill (guarded CAS on
  `realisedPnl/commission/exitPrice IS NULL`).
- Manual reversal of a booked fill is an operator action performed per-row
  from the query above under change control — it is NOT automated, because
  automated reversal of economically-correct broker evidence would itself be
  an unaudited accounting adjustment.

## 4. Historical evidence preservation (must survive every rollback)

None of the following may be deleted or rewritten by any rollback step:

- The operator statement fixtures: `apps/api/scripts/fixtures/pepperstone-demo-deal-fingerprints.csv`
  (424 statement deals; line endings normalized 2026-11-25, values byte-identical)
  and `pepperstone-demo-statement-verification.json`.
- The `audit_log` entries written by the convergence/recovery paths
  (artifacts such as `PROVIDER_CLOSED_DEAL_EXACT_QUANTITY_AND_PRICE`,
  `stranded-convergence-ambiguity-surfaced-v1`, and the reconciliation
  discrepancy/resolution rows in `trading.reconciliation_*`).
- The broker evidence codes and deal fingerprints backing any booked fill.

`git revert` only touches source files; `migration:revert` only drops the
two nullable columns and their index — none of the artifacts above are
affected. The unique partial index is re-created on re-migration without
touching NULL rows.

## 5. Operational release approval (operator-gated)

- The deploy hold `DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt` (documented in
  `docs/brokers/pepperstone-live-readiness-evidence-report.md`) stays in
  place through this release candidate. It is removed only through the
  operator review step, never by this branch's tooling.
- Release sequence for the independent reviewer: GitHub CI green on the
  candidate → operator review of §3 enumeration (empty at candidate time —
  no production reconciliation has run) → staging quiescence guard
  (`scripts/deployment/staging-quiescence.cjs`) → operator approval →
  deploy.
- Emergency stop: re-arm the hold by restoring the file (it is re-armed by
  policy — removed only through operator review) and re-run the quiescence
  guard before any redeploy.
- LIVE safeguards are unchanged by this series: independent LIVE
  authorization, risk controls and broker verification gates remain in
  force; the DEMO-only recovery sweeps still exclude LIVE accounts;
  no new real-money execution authority was introduced.

---

## Appendix — correction series (validated rollback scope)

```
b2631183  base: live/demo ledger integrity diagnostics (end of prior line)
b5b1419   fix(reconciliation): converge stranded linked orders from provider close evidence
41cd758   fix(demo-ledger): recover aged stranded DEMO close orders across the cTrader family
02614a9   fix(orders): persist native broker order, position and deal identifiers separately
10a5312   feat(diagnostics): verify stranded DEMO close orders against owner statement evidence
a40bfe4   style(api): normalize reconciliation correction formatting with Prettier
453efd5   test(ai): make pending-initial-scan cancellation deterministic
12376f38  fix(orders): prevent duplicate broker deal attribution on fills
4f8c0511  fix(reconciliation): separate closing and opening native identifier attribution
2b0aa4af  test(execution): align the real-PG orders fixture with migration 1795220000000
d14a39f5  style(fixtures): normalize statement CSV fixture to LF line endings
efa08ee0  docs(runbooks): validated release and rollback runbook
77405911  test(migrations): assert the duplicate-deal index in the identifier migration spec
b5cf9152  style(api): normalize duplicate-deal and identifier attribution code with Prettier
```

`git revert --no-commit b2631183..HEAD` (run at any later candidate that still
carries exactly this series on top of b2631183) reverts the series newest
first, conflict-free; validation on this candidate confirmed the reverted
working tree is content-identical to b2631183.
