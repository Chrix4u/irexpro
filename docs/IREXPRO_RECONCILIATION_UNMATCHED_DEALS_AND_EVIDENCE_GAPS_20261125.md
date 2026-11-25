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
   quantities both book.
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
