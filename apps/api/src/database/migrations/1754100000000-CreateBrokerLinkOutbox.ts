import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 56 correction round 5 — architect issue #332 (P0): durable outbox
 * for post-commit broker-link side effects.
 *
 * Creates broker.broker_link_outbox — the transactional-outbox table that
 * makes BrokerService.createConnection's audit/event work ATOMIC with the
 * connection INSERT (one transaction: connection row + its outbox rows) and
 * delivered asynchronously with retries/backoff by
 * BrokerLinkOutboxService.sweep (scheduled by the broker health-check job).
 *
 * Non-destructive: CREATE TABLE / CREATE INDEX IF NOT EXISTS; down() drops
 * the table and its indexes (the outbox is derived, stateless work — losing
 * it never loses a connection row).
 *
 * DDL notes:
 * - payload jsonb — the delivery work itself (audit/event payloads, no
 *   token material);
 * - attempts + processed_at + updated_at drive the claim-then-deliver retry
 *   schedule (backoff from the last-attempt timestamp);
 * - no FK to broker.broker_connections (mirrors every broker entity — the
 *   outbox must never block or cascade connection lifecycle).
 */
export class CreateBrokerLinkOutbox1754100000000 implements MigrationInterface {
  name = 'CreateBrokerLinkOutbox1754100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS broker.broker_link_outbox (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        connection_id uuid NOT NULL,
        flow_id      varchar(64) NULL,
        event_type   varchar(50) NOT NULL,
        payload      jsonb NOT NULL,
        attempts     integer NOT NULL DEFAULT 0,
        processed_at timestamptz NULL,
        created_at   timestamptz NOT NULL DEFAULT NOW(),
        updated_at   timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    // Sweep lookup: unprocessed rows oldest-first (partial index keeps it
    // tiny as the table accumulates processed history).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_broker_link_outbox_unprocessed
      ON broker.broker_link_outbox (created_at)
      WHERE processed_at IS NULL
    `);

    // Traceability: all side effects of one connection.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_broker_link_outbox_connection
      ON broker.broker_link_outbox (connection_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS broker.idx_broker_link_outbox_connection`);
    await queryRunner.query(`DROP INDEX IF EXISTS broker.idx_broker_link_outbox_unprocessed`);
    await queryRunner.query(`DROP TABLE IF EXISTS broker.broker_link_outbox`);
  }
}
