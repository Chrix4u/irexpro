import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Round 6 live-execution completion (§20) — TRADE → AUTHORITY LINKAGE:
 * completes the audit reconstruction chain
 *   AI decision → intent → allocation → sizing → RISK GRANT → ORDER →
 *   provider dispatch → trade outcome → reconciliation
 * with direct, immutable provenance columns on the executed trade:
 *
 *   trading.trades.risk_grant_id  — the RiskGrant whose atomic consumption
 *     at the provider-dispatch commitment authorized THIS trade's exposure.
 *     Before §20 the linkage was signalId-only (indirect, replay-dependent).
 *
 *   trading.trades.order_id       — the internal Order row that carried the
 *     provider lifecycle (reservation → SUBMITTED → DISPATCH_COMMITTED →
 *     outcome). Before §20 the linkage required a clientOrderId join.
 *
 * Migration discipline §29: forward-only, ADDITIVE (both columns NULLABLE —
 * legacy rows keep NULL), no data rewrite, no index changes, reversible in
 * down(). Both columns are provenance-only (NO foreign keys — financial
 * history retains its rows even if authority rows are archived; the chain
 * is reconstructed by id, never enforced by CASCADE).
 */
export class AddTradeAuthorityLinkage1754400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE trading.trades ADD COLUMN IF NOT EXISTS risk_grant_id uuid NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trades ADD COLUMN IF NOT EXISTS order_id uuid NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE trading.trades DROP COLUMN IF EXISTS order_id`);
    await queryRunner.query(`ALTER TABLE trading.trades DROP COLUMN IF EXISTS risk_grant_id`);
  }
}
