import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 56 correction round 5 — the NEW-EXPOSURE EXECUTION AUTHORITY schema
 * wave (architect issues #295 / #298 / #299 / #300 / #301 / #302 / #312).
 *
 * Creates:
 *   - trading.trading_sessions.execution_mode + authority_generation
 *   - FKs TradingSession.userId -> identity.users,
 *     TradingSession.brokerConnectionId -> broker.broker_connections
 *   - partial unique index: at most ONE ACTIVE session per user
 *   - trading.risk_grants (durable single-use risk approval authority)
 *   - trading.execution_confirmations (SEMI_AUTO one-time user confirmation)
 *   - identity.trading_authority_generations (per-user monotonic authority)
 *   - trading.ai_signal_identities (immutable signal identity / idempotency)
 *   - broker.broker_account_snapshots (versioned monotonic financial truth)
 *
 * Migration preflight (fail with actionable diagnostics, never silently
 * delete production rows):
 *   - duplicate ACTIVE sessions per user;
 *   - orphan sessions (missing user or missing broker connection).
 */
export class CreateExecutionAuthoritySchema1754000000000 implements MigrationInterface {
  name = 'CreateExecutionAuthoritySchema1754000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Preflight: duplicate ACTIVE TradingSessions per user (#295) ────────
    const duplicateActive = await queryRunner.query(`
      SELECT user_id, COUNT(*) AS active_count
      FROM trading.trading_sessions
      WHERE status = 'ACTIVE'
      GROUP BY user_id
      HAVING COUNT(*) > 1
    `);
    if (Array.isArray(duplicateActive) && duplicateActive.length > 0) {
      const sample = duplicateActive
        .slice(0, 10)
        .map((r: { user_id: string; active_count: string }) => `user ${r.user_id} has ${r.active_count} ACTIVE sessions`)
        .join('; ');
      throw new Error(
        `ExecutionAuthoritySchema migration preflight FAILED: duplicate ACTIVE TradingSessions detected (${duplicateActive.length} users). ` +
          `Deterministic remediation required BEFORE this migration: explicitly end all but the intended session for each user. ` +
          `Offending users: ${sample}`,
      );
    }

    // ── Preflight: orphan sessions (missing user / missing connection) ────
    const orphanUsers = await queryRunner.query(`
      SELECT s.id AS session_id, s.user_id
      FROM trading.trading_sessions s
      LEFT JOIN identity.users u ON u.id = s.user_id
      WHERE u.id IS NULL
    `);
    if (Array.isArray(orphanUsers) && orphanUsers.length > 0) {
      const sample = orphanUsers
        .slice(0, 10)
        .map((r: { session_id: string; user_id: string }) => `session ${r.session_id} references missing user ${r.user_id}`)
        .join('; ');
      throw new Error(
        `ExecutionAuthoritySchema migration preflight FAILED: orphan TradingSessions (user missing). ` +
          `Reconcile or archive these rows explicitly — this migration never deletes data. ${sample}`,
      );
    }
    const orphanConnections = await queryRunner.query(`
      SELECT s.id AS session_id, s.broker_connection_id
      FROM trading.trading_sessions s
      LEFT JOIN broker.broker_connections c ON c.id = s.broker_connection_id
      WHERE c.id IS NULL
    `);
    if (Array.isArray(orphanConnections) && orphanConnections.length > 0) {
      const sample = orphanConnections
        .slice(0, 10)
        .map((r: { session_id: string; broker_connection_id: string }) => `session ${r.session_id} references missing broker connection ${r.broker_connection_id}`)
        .join('; ');
      throw new Error(
        `ExecutionAuthoritySchema migration preflight FAILED: orphan TradingSessions (broker connection missing). ` +
          `Reconcile or archive these rows explicitly — this migration never deletes data. ${sample}`,
      );
    }

    // ── trading.trading_sessions: execution mode + authority generation ────
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS execution_mode varchar(20) NOT NULL DEFAULT 'PAPER_ONLY'
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD CONSTRAINT ck_trading_sessions_execution_mode
      CHECK (execution_mode IN ('PAPER_ONLY', 'SEMI_AUTO', 'FULL_AUTO'))
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS authority_generation integer NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD CONSTRAINT ck_trading_sessions_authority_generation_nonnegative
      CHECK (authority_generation >= 1)
    `);

    // ── FKs: session authority is referentially bound (#295) ───────────────
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD CONSTRAINT fk_trading_sessions_user
      FOREIGN KEY (user_id) REFERENCES identity.users (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD CONSTRAINT fk_trading_sessions_broker_connection
      FOREIGN KEY (broker_connection_id) REFERENCES broker.broker_connections (id)
    `);

    // ── Partial unique: at most ONE ACTIVE session per user (#295) ────────
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_trading_sessions_one_active_per_user
      ON trading.trading_sessions (user_id)
      WHERE status = 'ACTIVE'
    `);

    // ── trading.risk_grants (#301) ─────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.risk_grants (
        id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                           uuid NOT NULL,
        signal_id                         varchar(100) NOT NULL,
        signal_payload_digest             varchar(64) NOT NULL,
        session_id                        uuid NOT NULL,
        session_generation                integer NOT NULL,
        execution_mode                    varchar(20) NOT NULL,
        broker_connection_id              uuid NOT NULL,
        provider_broker_identity          varchar(100),
        provider_verification_fingerprint varchar(128),
        risk_profile_id                   uuid,
        risk_profile_version              integer,
        risk_profile_hash                 varchar(64),
        account_snapshot_id               uuid,
        account_snapshot_generation       integer,
        account_snapshot_observed_at      timestamptz,
        authority_generation              integer NOT NULL,
        kill_switch_generation            integer,
        execution_control_revision        integer,
        order_payload_digest              varchar(64) NOT NULL,
        order_payload                     jsonb NOT NULL,
        quote_ref                         jsonb,
        issued_at                         timestamptz NOT NULL DEFAULT NOW(),
        expires_at                        timestamptz NOT NULL,
        consumed_at                       timestamptz,
        invalidated_at                    timestamptz,
        invalidation_reason               varchar(200),
        status                            varchar(30) NOT NULL DEFAULT 'ACTIVE',
        created_at                        timestamptz NOT NULL DEFAULT NOW(),
        updated_at                        timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_risk_grants_status
          CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'INVALIDATED')),
        CONSTRAINT ck_risk_grants_session_generation
          CHECK (session_generation >= 1),
        CONSTRAINT ck_risk_grants_authority_generation
          CHECK (authority_generation >= 1),
        CONSTRAINT ck_risk_grants_execution_mode
          CHECK (execution_mode IN ('PAPER_ONLY', 'SEMI_AUTO', 'FULL_AUTO'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_risk_grants_user_id ON trading.risk_grants (user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_risk_grants_session_id ON trading.risk_grants (session_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_risk_grants_signal_id ON trading.risk_grants (signal_id)`,
    );
    // At most ONE ACTIVE grant per signal (issuance race single-winner)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_grants_one_active_per_signal
      ON trading.risk_grants (signal_id)
      WHERE status = 'ACTIVE'
    `);

    // ── trading.execution_confirmations (#298 SEMI_AUTO) ───────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.execution_confirmations (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id               uuid NOT NULL,
        session_id            uuid NOT NULL,
        session_generation    integer NOT NULL,
        signal_id             varchar(100) NOT NULL,
        broker_connection_id  uuid NOT NULL,
        risk_grant_id         uuid,
        order_payload_digest  varchar(64) NOT NULL,
        instrument            varchar(50) NOT NULL,
        direction             varchar(10) NOT NULL,
        quantity              numeric(18,8) NOT NULL,
        stop_loss             numeric(18,8),
        take_profit           numeric(18,8),
        expires_at            timestamptz NOT NULL,
        consumed_at           timestamptz,
        revoked_at            timestamptz,
        status                varchar(30) NOT NULL DEFAULT 'PENDING',
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_execution_confirmations_status
          CHECK (status IN ('PENDING', 'CONSUMED', 'EXPIRED', 'REVOKED')),
        CONSTRAINT ck_execution_confirmations_session_generation
          CHECK (session_generation >= 1)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_exec_confirmations_user_id ON trading.execution_confirmations (user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_exec_confirmations_session_id ON trading.execution_confirmations (session_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_exec_confirmations_signal_id ON trading.execution_confirmations (signal_id)`,
    );
    // At most ONE PENDING confirmation per signal (concurrent approve single-winner)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_confirmations_one_pending_per_signal
      ON trading.execution_confirmations (signal_id)
      WHERE status = 'PENDING'
    `);

    // ── identity.trading_authority_generations (#300) ──────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS identity.trading_authority_generations (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         uuid NOT NULL,
        generation      integer NOT NULL DEFAULT 1,
        last_reason     varchar(200),
        last_bumped_at  timestamptz,
        created_at      timestamptz NOT NULL DEFAULT NOW(),
        updated_at      timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_trading_authority_generations_generation
          CHECK (generation >= 1),
        CONSTRAINT uq_trading_authority_generation_user UNIQUE (user_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_trading_authority_generations_user_id
      ON identity.trading_authority_generations (user_id)
    `);

    // ── trading.ai_signal_identities (#302) ────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.ai_signal_identities (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id             uuid NOT NULL,
        signal_id           varchar(100) NOT NULL,
        payload_digest      varchar(64) NOT NULL,
        material_fields     jsonb NOT NULL,
        generated_at        timestamptz NOT NULL,
        received_at         timestamptz NOT NULL DEFAULT NOW(),
        first_processed_at  timestamptz,
        status              varchar(30) NOT NULL DEFAULT 'RECEIVED',
        created_at          timestamptz NOT NULL DEFAULT NOW(),
        updated_at          timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_ai_signal_identities_status
          CHECK (status IN ('RECEIVED', 'PROCESSED')),
        CONSTRAINT uq_ai_signal_identity_user_signal UNIQUE (user_id, signal_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_signal_identity_user_id
      ON trading.ai_signal_identities (user_id)
    `);

    // ── broker.broker_account_snapshots (#297/#312) ────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS broker.broker_account_snapshots (
        id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        connection_id              uuid NOT NULL,
        generation                 integer NOT NULL,
        provider_observed_at       timestamptz,
        accepted_at                timestamptz NOT NULL DEFAULT NOW(),
        balance                    numeric(20,8),
        equity                     numeric(20,8),
        margin                     numeric(20,8),
        free_margin                numeric(20,8),
        margin_level               numeric(20,8),
        leverage                   integer,
        open_positions_count       integer,
        currency                   varchar(3),
        source                     varchar(30) NOT NULL,
        provider_account_identity  varchar(200),
        created_at                 timestamptz NOT NULL DEFAULT NOW(),
        updated_at                 timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_broker_account_snapshots_generation
          CHECK (generation >= 1),
        CONSTRAINT uq_broker_account_snapshot_connection_generation
          UNIQUE (connection_id, generation)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_broker_account_snapshots_connection_id
      ON broker.broker_account_snapshots (connection_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_broker_account_snapshots_connection_accepted
      ON broker.broker_account_snapshots (connection_id, accepted_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS broker.broker_account_snapshots`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.ai_signal_identities`);
    await queryRunner.query(`DROP TABLE IF EXISTS identity.trading_authority_generations`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.execution_confirmations`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.risk_grants`);
    await queryRunner.query(`DROP INDEX IF EXISTS trading.uq_trading_sessions_one_active_per_user`);
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP CONSTRAINT IF EXISTS fk_trading_sessions_broker_connection`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP CONSTRAINT IF EXISTS fk_trading_sessions_user`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP CONSTRAINT IF EXISTS ck_trading_sessions_authority_generation_nonnegative`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP CONSTRAINT IF EXISTS ck_trading_sessions_execution_mode`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP COLUMN IF EXISTS authority_generation`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP COLUMN IF EXISTS execution_mode`,
    );
  }
}
