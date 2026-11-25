import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { OrderFillEvidenceClass } from './order.enums';

/**
 * OrderFillEvidence — IMMUTABLE per-fill accounting evidence ledger
 * (accounting-integrity correction 2026-11-25, table created by migration
 * 1795564800000).
 *
 * ROOT CAUSE this ledger closes: trading.orders carried ONE
 * provider_deal_id column that every applied fill OVERWROTE
 * (COALESCE($7, provider_deal_id)). After partial fills A then B, the row
 * remembered only B's deal id, so a replayed delivery of fill A was no
 * longer recognized as a duplicate — it was booked a second time and
 * inflated filled_quantity (0.10 + 0.10 + replayed 0.10 = 0.30 instead of
 * 0.20). Deal-grade duplicate detection depended on a single mutable
 * pointer; historical fill identifiers were not retained anywhere.
 *
 * DESIGN — one INSERT-ONLY row per booked fill:
 * - Every applyFill books exactly one evidence row in the SAME transaction
 *   as the order-row quantity update (all-or-nothing; a refused fill leaves
 *   no evidence row).
 * - provider_deal_id is retained PER FILL and never overwritten: replays
 *   of ANY historical fill (not just the latest) are detected through the
 *   partial unique index uq_order_fill_evidence_deal and are idempotent
 *   no-ops — for PROVIDER_DEAL rows a redelivery must MATCH the booked
 *   quantity/price exactly, otherwise it is contradictory evidence and
 *   fails closed (review finding 3).
 * - One native broker deal may be credited to at most ONE internal order:
 *   the same partial unique index is connection-scoped, so cross-order
 *   attribution fails closed (ConflictException), including under
 *   concurrent reconciliation.
 * - quantity/price are NUMERIC (exact decimal) — the ledger preserves the
 *   exact monetary facts that produced each filled_quantity increment.
 * - Fills whose provider evidence carried no native deal id are recorded
 *   with provider_deal_id NULL and their actual evidence_class
 *   (POSITION_FACTS / PROVIDER_RESPONSE / PROVIDER_ORDER_STATE) — missing
 *   evidence is never fabricated into an identifier. Such rows are NOT
 *   replay-detectable: that is the honest limit of unidentified evidence
 *   (callers apply state-based deltas only when the provider is AHEAD).
 * - Append-only is enforced at the DATABASE level: row trigger
 *   trg_order_fill_evidence_append_only refuses UPDATE/DELETE, and the
 *   statement trigger trg_order_fill_evidence_no_truncate (migration
 *   1795628400000) refuses TRUNCATE outside the operator escape — history
 *   cannot be rewritten or bulk-discarded even by privileged paths.
 * - Referential consistency (migration 1795628400000): each row references
 *   its order AND the exact broker connection of that order (pair FK on
 *   (order_id, broker_connection_id) → trading.orders(id,
 *   broker_connection_id)), and broker_connection_id must reference a real
 *   broker.broker_connections row (ON DELETE RESTRICT).
 *
 * ACCOUNTING INVARIANT (review finding 5 — scoped honestly): for
 * LEDGER-MANAGED orders,
 *
 *   orders.filled_quantity = (the single LEGACY_BASELINE row transcribed
 *   once at the first ledger-era fill for mixed-era orders, if any)
 *   + SUM(quantity of the per-fill rows).
 *
 * Orders whose quantity was booked BEFORE the ledger existed and never
 * booked a ledger-era fill have NO ledger rows — the ledger alone does
 * NOT establish their historical total (no backfill, ever). Discrepancies
 * are surfaced by diagnostics, never "corrected" by editing the ledger.
 *
 * NO BACKFILL: historical per-fill identifiers destroyed by the old
 * pointer-overwrite defect are NOT recoverable and are NOT invented. The
 * ONE identifier the order row still retained (the latest-deal pointer) is
 * preserved AS what it is — the retained pointer on a LEGACY_BASELINE row
 * — at the first ledger-era fill, keeping it in the dedup surface forever
 * (review finding 1); a baseline is a summary of already-booked state,
 * never presented as reconstructed per-fill deal evidence.
 */
@Entity({ name: 'order_fill_evidence', schema: 'trading' })
export class OrderFillEvidence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Internal order the fill was booked against. */
  @Column({ name: 'order_id', type: 'uuid' })
  @Index()
  orderId: string;

  /**
   * Broker connection scope of the duplicate-deal guard (denormalized from
   * the order row at fill time, inside the same transaction — consistent
   * by construction).
   */
  @Column({ name: 'broker_connection_id', type: 'uuid' })
  brokerConnectionId: string;

  /** Native broker DEAL id that proved this fill; NULL when the provider
   *  evidence carried none (never fabricated, never inferred). */
  @Column({ name: 'provider_deal_id', type: 'varchar', length: 255, nullable: true })
  providerDealId: string | null;

  /** Native ORDER id carried by the fill evidence, when any. */
  @Column({ name: 'provider_order_id', type: 'varchar', length: 255, nullable: true })
  providerOrderId: string | null;

  /** Native POSITION id carried by the fill evidence, when any. */
  @Column({ name: 'provider_position_id', type: 'varchar', length: 255, nullable: true })
  providerPositionId: string | null;

  /** Fill quantity in lots. Decimal string, > 0. */
  @Column({ name: 'quantity', type: 'numeric', precision: 10, scale: 4 })
  quantity: string;

  /** Fill price. Decimal string, > 0. */
  @Column({ name: 'price', type: 'numeric', precision: 18, scale: 8 })
  price: string;

  /** Evidence grade of this row (see OrderFillEvidenceClass). */
  @Column({ name: 'evidence_class', type: 'varchar', length: 32 })
  evidenceClass: OrderFillEvidenceClass;

  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;
}
