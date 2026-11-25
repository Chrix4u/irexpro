# iRexPro — Reconciliation Unmatched Deals and Evidence Gaps (2026-11-25)

**Status:** unresolved — documented for independent review. **No internal trade
records were manufactured, and none may be.**
**Scope:** read-only findings carried over from the independently executed VPS
audit and the Pepperstone DEMO statement verification; nothing in this
document authorizes a database write.

---

## 1. Verified audit baseline (independently executed, read-only)

| Finding | Count |
| --- | --- |
| Pepperstone DEMO statement deals | 424 |
| Uniquely matched closed trades | 422 |
| Matched P&L calculations verified correct | 422 / 422 |
| Stranded Pepperstone DEMO orders economically matched | 249 / 249 |
| Ambiguous economic matches | 0 |
| Unmatched EURUSD deals | 2 |
| Generic cTrader DEMO orders requiring additional broker evidence | 126 |
| LIVE internal ledger discrepancies | 0 |

The statement verification (`apps/api/scripts/fixtures/pepperstone-demo-statement-verification.json`
shape) independently re-derived the account economics: 424 deals, net
realised `-7045.21`, closing balance `42954.79`, zero balance-chain errors,
deposit + realised = balance. The 424 deals reduce to 423 distinct
fingerprints; the single duplicate fingerprint is the unmatched pair below.

## 2. The two unmatched EURUSD deals

Both closed on **2026-11-10** (the statement's opening day):

| Field | Deal 1 | Deal 2 |
| --- | --- | --- |
| Close time (UTC) | 00:24:41.249 | 00:24:41.950 |
| Direction (opening) | Buy | Buy |
| Entry price | 1.12194 | 1.12194 |
| Exit price | 1.12193 | 1.12193 |
| Quantity | 0.01 lots | 0.01 lots |
| Net result | `-0.07` | `-0.07` |

The two rows are the statement's FIRST transactions (deal 1 is the earliest
row in the CSV), 701 ms apart, with byte-identical economics apart from the
close timestamp.

**Independent database searches found no corresponding EURUSD order or
trade records around those times.** There is no internal `trading.orders`
row, no `trading.trades` row, and no AI-signal lineage attributable to
either deal.

### 2.1 Why no internal record was created

Manufacturing an internal trade record to "complete" the match would be
fabrication: it would invent an order, a fill, a strategy lineage and an
execution authorization that no evidence supports. Per the correction
series' red lines, missing evidence stays explicitly unknown. The two deals
therefore remain recorded ONLY as broker-statement evidence, and the
internal ledger does not pretend to explain them.

### 2.2 What additional evidence would resolve the attribution

Each item below is a READ-ONLY query; none has been executed beyond what the
audit already performed:

1. **cTrader Open API deal records for the Pepperstone DEMO account** for
   2026-11-10 00:24:30–00:25:00 UTC — native deal IDs, originating order
   IDs, position IDs, and the `closingOrderId`/`openingOrderId` linkage.
   This is the authoritative attribution surface: it distinguishes
   (a) platform-originated orders from (b) manual terminal trades from
   (c) another trading application using the same DEMO credentials.
2. **Position lifecycle** for the account at that window — whether one
   position opened and partially closed twice, or two positions opened and
   closed in under a second. 0.01 lots with a 0.00001 price delta and
   `-0.07` net is consistent with a micro-lot scratch pair, but the
   commission/spread split cannot be decomposed without the deal-level
   commission fields.
3. **Account-holder attestation** — whether any manual trading (cTrader
   desktop/mobile terminal) occurred on the Pepperstone DEMO account around
   2026-11-10 00:24 UTC. Statement-deal rows carry no client-tag, so this
   cannot be derived from the CSV alone.
4. **Internal platform logs for the same window** — AI-engine signal
   records and execution-orchestrator dispatch/audit trails. Their absence
   around those timestamps (already searched) is consistent with a
   non-platform origin, but only the broker-side records above can make
   that a positive finding rather than an inference.
5. **Broker support / full statement export with deal IDs** — a
   statement variant that includes the broker deal ID column would let the
   duplicate fingerprint be matched against cTrader deal identifiers
   directly.

### 2.3 Residual risk assessment

- Economic risk of the gap: **$0.14 total** (two × -$0.07), all DEMO, all
  already reflected in the broker-side balance that the statement
  verification reconciled exactly.
- The gap does NOT interact with any LIVE ledger (0 LIVE discrepancies).
- The internal DEMO ledger is aware of the account's realised total through
  the matched 422 trades; the unmatched $0.14 is outside the internal
  ledger by construction — it is not "missing money", it is an attribution
  question about two statement rows.

## 3. The 126 generic cTrader DEMO orders

The audit also counted **126 historical generic cTrader DEMO orders**
needing additional broker evidence before any internal convergence. These
are NOT Pepperstone-statement-backed orders: they lack a reciprocal
economic match in the verified statement corpus and must not be converged
on inference.

Required evidence (same read-only discipline):

1. Account-scoped cTrader deal lists (native deal/order/position IDs,
   volume, price, commission, swap) for the DEMO login(s) involved.
2. Internal rows' `broker_connection_id`-scoped reconciliation against
   those deal lists — reusing the reciprocal matching discipline from the
   Pepperstone verification (match only when BOTH sides agree exactly on
   economics; anything partial stays `RECONCILIATION_PENDING`).
3. The existing guards apply to any future convergence: one deal → one
   internal order, deal-grade evidence only, no identifier fabrication
   (see `order.service.ts` and the immutable fill ledger).

## 4. Standing decision

- **Do not create internal records** for the two EURUSD deals or the 126
  generic orders. Attribution requires broker-native deal evidence as
  listed above.
- The immutable per-fill accounting evidence ledger (migrations
  1795564800000 + hardening 1795628400000) records evidence per booked fill
  going forward; it does not backfill history — a mixed-era order's
  pre-ledger cumulative state is transcribed ONCE as an honest
  `LEGACY_BASELINE` row (retained pointer + cumulative quantity + average
  price — a baseline summary, never reconstructed per-fill evidence) at
  its first ledger-era fill, and unknown attribution stays unknown.
- If/when the evidence in §2.2/§3 arrives, convergence decisions go through
  the reviewed reconciliation paths (`applyFill` with deal-grade
  identifiers), never through manual record insertion.

## 5. Evidence-grade limitations that cannot be resolved conclusively (independent-review finding 4)

Documented honestly — synthetic fixtures demonstrate each case in
`order.service.spec.ts` and the real-PG suite; no guard is weakened and no
identifier is invented to close them:

1. **Unidentified fills (NULL deal id) are not replay-detectable.** Each
   delivery of the same unidentified event books as a new accounting event
   (its ledger row records that fact). Repeated ambiguous deliveries CAN
   accumulate; the caller-side discipline (state-based deltas only when the
   provider is AHEAD) bounds it, but the ledger cannot deduplicate evidence
   that carries no identifier. Contradictory unidentified evidence is
   equally undetectable — two NULL-deal deliveries with different
   quantities both book. **2026-11-25 continuation — the CONCURRENT case is
   now closed:** state-derived unidentified deliveries (provider-order-state
   deltas, stranded-order convergence, dispatch responses without a native
   deal id) are fenced on the `expectedFilledQuantity` premise the caller
   observed when deriving the fill (`ApplyFillOptions` in
   `order.service.ts`): under the row lock a stale premise no-ops
   idempotently instead of double-booking, with NO identifier fabricated.
   The remaining honest limit: an unidentified redelivery whose premise is
   still fresh (nothing else moved the accounting) still books — only a
   native deal id can distinguish a genuine repeat from a duplicate.
2. **Pre-ledger per-fill identifiers are unrecoverable.** The identifiers
   destroyed by the historical pointer-overwrite defect cannot be
   reconstructed; only the one RETAINED pointer survives (transcribed as
   LEGACY_BASELINE at the first ledger-era fill). Replays of any OTHER
   pre-ledger deal cannot be deduplicated.
3. **LEGACY_BASELINE economics are cumulative, not per-deal.** A replay of
   the retained legacy deal is deduplicated on IDENTITY only — its
   original per-deal quantity/price were never recorded, so a redelivery's
   economics cannot be verified against the baseline (the documented
   insufficiency of pre-ledger evidence).
4. **Contradictory evidence detection requires an identifier.** The
   contradiction defence compares a redelivery against the BOOKED
   PROVIDER_DEAL row — without a deal id there is nothing to compare
   against.
5. **The two unmatched EURUSD deals (§2) and the 126 generic orders (§3)**
   remain outside every one of these mechanisms: attribution unknown until
   the enumerated broker-native evidence arrives.

## 6. Terminal-state redelivery classification (2026-11-25 continuation)

A duplicate delivery of an ALREADY-BOOKED deal arriving after the order
reached a TERMINAL state (FILLED included) was previously refused as a
fake "not fillable" conflict before the dedup classification could run.
Corrected in `order.service.ts`: the ledger/pointer dedup classification
now runs BEFORE the fillable gate, so a redelivered booked deal is an
idempotent no-op on ANY order status (broker event redelivery on
reconnect, repeated or concurrent reconciliation), while a genuinely NEW
deal on a terminal state still fails closed with a typed Conflict, and a
contradictory redelivery (same deal id, different economics) is refused
stating both facts. Proven by mock specs (`applyFill — duplicate deal
delivery after a terminal state`) and the real-PG suite (tests 13).

## 7. Historical reconciliation completion (2026-11-25, repository evidence)

The attribution investigation of §2/§3 was completed against the genuine
broker evidence available IN THIS REPOSITORY
(`apps/api/scripts/fixtures/pepperstone-demo-deal-fingerprints.csv`, the
424 verified Pepperstone DEMO statement deals). Every number below is
recomputed exactly from those rows by
`apps/api/scripts/audit-unmatched-deal-historical-reconciliation.cjs`
(pinned by its companion `.test.cjs`); nothing was fabricated:

1. **The pair is the corpus's ONLY duplicate fingerprint.** 424 deals →
   423 distinct fingerprints; the single duplicated fingerprint is exactly
   the two unmatched EURUSD rows (2026-11-10T00:24:41.249Z / .950Z,
   701 ms apart, identical economics).
2. **The pair's economics are closed, not open.** The balance chain is
   exact through all 424 rows (opening balance 50,000 derived from row 1;
   closing 42,954.79; net −7,045.21; zero chain errors) — the pair's
   −$0.14 is fully reflected in the broker-side balance. What remains open
   is ATTRIBUTION, not money.
3. **Corpus-derived context (facts, not attribution):** the pair is the
   statement's FIRST two transactions; the next corpus deal is 7 minutes 30
   seconds later; their −6 USD/lot residual matches the corpus commission
   family exactly. Micro-lot (0.01) size is NOT distinguishing evidence —
   11 other 0.01-lot deals exist in the corpus and all were matched to
   internal records by the independent audit (422/424).
4. **The labelled inference (explicitly not a positive finding):** a
   same-second repeated micro scratch pair as the account's first-ever
   transactions, with no internal order/trade/signal lineage (per the VPS
   audit's database searches), is MOST CONSISTENT with a non-platform
   origin (manual terminal or a third-party application on the same DEMO
   credentials) — but attribution remains formally UNKNOWN until the
   §2.2 native evidence (cTrader deal records with deal/order/position
   IDs) arrives. The standing decision of §4 is unchanged: no internal
   records are created for the pair.
5. **The 126 generic cTrader records — documented negative.** The
   repository holds NO broker-native deal evidence for the generic
   cTrader DEMO accounts: the verified corpus is Pepperstone-account
   scoped and cannot speak for them. Their convergence still requires the
   §3 evidence list (account-scoped cTrader deal lists); until it arrives
   they stay RECONCILIATION_PENDING. No records were created for them,
   none may be.

## 8. pgcrypto exception closed in a properly configured disposable environment (2026-11-25)

The real-PostgreSQL suite's single historical local failure
(`performance-fee-policy.pg-integration.spec.ts` — `CREATE EXTENSION IF
NOT EXISTS pgcrypto`) was an environment artifact, not a product defect:
the embedded disposable PostgreSQL (pip `pgserver`, PostgreSQL 16.2)
ships NO contrib extension files, while GitHub CI runners use the
official postgres images that do. `gen_random_uuid()` itself is CORE in
PostgreSQL 13+, so only that one CREATE EXTENSION statement failed.
Re-provisioned disposable environment: pgcrypto compiled from the
OFFICIAL PostgreSQL 16.2 source against the same bundled engine (PGXS),
relinked against system OpenSSL, installed into the embedded pginstall —
after which the FULL real-PG suite passes locally: **11/11 suites,
97/97 tests** (the same result CI produces), closing independent-review
finding 7's pgcrypto question.
