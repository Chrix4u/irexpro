import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 56 correction round 2 — architect finding 2: replica-safe OAuth
 * authorization-state store.
 *
 * BrokerOAuthService previously kept flow state in a process-local Map —
 * incorrect in production with multiple API replicas or restarts (a flow
 * started on replica A could not be completed on replica B; every deploy
 * invalidated in-flight consents). This migration creates the shared store:
 * broker.broker_oauth_flows in the SAME PostgreSQL database as every other
 * entity (this repo has no Redis cache).
 *
 * Design (adversarially tested in broker-oauth.cross-instance.spec.ts):
 * - server-generated opaque uuid flow id, bound to user + broker + redirect;
 * - explicit state machine PENDING → AUTHORIZED → LINKING → CONSUMED with
 *   conditional (compare-and-set) UPDATEs — single-use everywhere;
 * - hard TTLs (PENDING 10 min, AUTHORIZED 5 min, handoff 120 s);
 * - access/refresh tokens AES-256-GCM encrypted at rest (token_* columns are
 *   NULL until AUTHORIZED and are zeroed on CONSUME);
 * - accounts column carries the sanitized discovery list only (no tokens);
 * - handoff_token_hash stores ONLY the SHA-256 digest of the one-time
 *   handoff token, never the token itself;
 * - no FK constraints (mirrors broker.broker_connections);
 * - bounded storage: consumed/expired rows are inert and lazily swept.
 */
export class CreateBrokerOAuthFlowStore1753800000000 implements MigrationInterface {
  name = 'CreateBrokerOAuthFlowStore1753800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The broker schema is created by the baseline migration; guard anyway so
    // this migration stays idempotent when run against a partial environment.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS broker`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS broker.broker_oauth_flows (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "broker_id" varchar(50) NOT NULL,
        "redirect_uri" varchar(500) NOT NULL,
        "state" varchar(20) NOT NULL,
        "state_changed_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "token_ciphertext" text NULL,
        "token_iv" varchar(32) NULL,
        "token_tag" varchar(48) NULL,
        "token_key_id" varchar(255) NULL,
        "access_token_expires_at" timestamptz NULL,
        "accounts" jsonb NULL,
        "handoff_token_hash" varchar(64) NULL,
        "handoff_expires_at" timestamptz NULL,
        "completed_at" timestamptz NULL,
        "consumed_at" timestamptz NULL,
        CONSTRAINT "pk_broker_oauth_flows" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_broker_oauth_flows_user_id
        ON broker.broker_oauth_flows (user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_broker_oauth_flows_expires_at
        ON broker.broker_oauth_flows (expires_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_broker_oauth_flows_redirect_uri
        ON broker.broker_oauth_flows (redirect_uri)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS broker.broker_oauth_flows`);
  }
}
