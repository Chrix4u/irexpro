import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * October UAT hardening (WS2 — LIVE reconciliation-health hard gate).
 *
 * Extends the reconciliation discrepancy-type CHECK constraint with
 * PROTECTIVE_ORDER_DIVERGENCE: the protective-order reconciliation loop
 * (per-trade SL/TP verify/repair) now persists its operator-actionable
 * failures (REPAIR_FAILED / INTERNAL_UNPROVABLE) as first-class OPEN
 * discrepancies so the LIVE new-exposure reconciliation-health gate can
 * fail closed on unprotected positions.
 *
 * The constraint is dropped and re-created with the FULL type list (the
 * original nine directive §25 categories + the new protective class) —
 * no other column, index, or semantic changes.
 */
export class AddProtectiveOrderDivergence1754900000000 implements MigrationInterface {
  name = 'AddProtectiveOrderDivergence1754900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reconciliation"."discrepancies"
      DROP CONSTRAINT IF EXISTS "chk_reconciliation_discrepancy_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "reconciliation"."discrepancies"
      ADD CONSTRAINT "chk_reconciliation_discrepancy_type" CHECK ("discrepancy_type" IN (
        'MISSING_INTERNAL_ORDER','UNKNOWN_PROVIDER_ORDER','MISSING_PROVIDER_ORDER',
        'UNKNOWN_PROVIDER_POSITION','STALE_ORDER_STATE','POSITION_CLOSED_EXTERNALLY',
        'DUPLICATE_PROVIDER_ID','UNRESOLVED_EXECUTION_RESULT','ACCOUNT_STATE_MISMATCH',
        'PROTECTIVE_ORDER_DIVERGENCE'
      ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fail-closed down-migration: refuse when protective divergence rows
    // exist (deleting live discrepancy history silently is never safe).
    const [{ count }] = (await queryRunner.query(`
      SELECT COUNT(*)::int AS count FROM "reconciliation"."discrepancies"
      WHERE "discrepancy_type" = 'PROTECTIVE_ORDER_DIVERGENCE'
    `)) as Array<{ count: number }>;
    if (count > 0) {
      throw new Error(
        `Cannot downgrade: ${count} PROTECTIVE_ORDER_DIVERGENCE row(s) exist — ` +
          'resolve them first (the down-migration never deletes discrepancy history).',
      );
    }
    await queryRunner.query(`
      ALTER TABLE "reconciliation"."discrepancies"
      DROP CONSTRAINT IF EXISTS "chk_reconciliation_discrepancy_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "reconciliation"."discrepancies"
      ADD CONSTRAINT "chk_reconciliation_discrepancy_type" CHECK ("discrepancy_type" IN (
        'MISSING_INTERNAL_ORDER','UNKNOWN_PROVIDER_ORDER','MISSING_PROVIDER_ORDER',
        'UNKNOWN_PROVIDER_POSITION','STALE_ORDER_STATE','POSITION_CLOSED_EXTERNALLY',
        'DUPLICATE_PROVIDER_ID','UNRESOLVED_EXECUTION_RESULT','ACCOUNT_STATE_MISMATCH'
      ))
    `);
  }
}
