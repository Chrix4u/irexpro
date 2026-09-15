import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 56 correction round 6 — COMPLETE the execution-authority schema
 * (architect issues #299 / #300 / #301 / #302 / #312 / #362 / #363 / #364 /
 * #365 + task 6-d lease ownership).
 *
 * This is a NEW forward migration (migration discipline §29): no
 * already-applied migration is edited. Every change is additive,
 * NULL-preserving, preflighted, and reversible in down().
 *
 * A. SHARED CONTROL PLANE (issue #363 — cross-replica revisions):
 *   - platform.trading_policy_state            (singleton, monotonic revision)
 *   - platform.trading_policy_revision_logs    (append-only, UNIQUE revision)
 *   - platform.provider_live_verification_state       (singleton)
 *   - platform.provider_live_verification_revision_logs (append-only)
 *   - platform.execution_control_revision_state       (singleton, #299
 *     no-resurrection: activation AND deactivation AND expiry all bump)
 *
 * B. DAILY RISK PERIODS (issue #362):
 *   - trading.daily_risk_periods — one durable loss budget per
 *     (user, logical_account_key, UTC day); baseline from the first trusted
 *     snapshot of the day; session restarts can never reset it. Grants and
 *     trades reference it via risk_period_id provenance.
 *
 * C. AUTHORITY TABLE GUARDS (idempotent, no-op when round 5 already created
 *    them — the shapes are IDENTICAL to 1754000000000):
 *   - identity.trading_authority_generations   (CREATE TABLE IF NOT EXISTS)
 *   - broker.broker_account_snapshots          (CREATE TABLE IF NOT EXISTS)
 *
 * D. TENANT SCOPING (issue #364 — cross-tenant collisions):
 *   - drops the GLOBAL partial uniques
 *       uq_risk_grants_one_active_per_signal (signal_id)
 *       uq_execution_confirmations_one_pending_per_signal (signal_id)
 *     and replaces them with TENANT-SCOPED partial uniques on
 *       (user_id, signal_id) WHERE status = 'ACTIVE' / 'PENDING'.
 *     Two users may now simultaneously hold the same signal id; neither can
 *     read, supersede, invalidate or block the other's authority.
 *
 * E. REFERENTIAL INTEGRITY (issue #363/#13 audit): FKs with deliberate
 *    retention semantics (NO ACTION — never CASCADE on financial/audit
 *    authority history), each preceded by an orphan preflight that FAILS
 *    with actionable diagnostics instead of deleting rows:
 *   - risk_grants: user, session, broker connection, account snapshot*
 *   - execution_confirmations: user, session, broker connection, risk grant*
 *   - ai_signal_identities: user
 *   - trading_authority_generations: user
 *   - broker_account_snapshots: connection
 *   - daily_risk_periods (new table): user, connection, opening snapshot
 *   - trading_sessions: opening snapshot*          (* where populated)
 *
 * F. ROUND-6 COLUMNS:
 *   - trading.risk_profiles.revision                       (#299/#301/§15)
 *   - trading.risk_grants.authority_binding_digest         (#301 canonical
 *     SHA-256 over ALL bound authority facts), .trading_policy_revision and
 *     .provider_verification_revision                      (#363 binding)
 *   - trading.trades immutable provenance (#362): trading_session_id,
 *     logical_account_key, account_currency, risk_period_id — historic
 *     currency/account identity is never re-derived from the mutable
 *     connection; legacy rows stay NULL (never guessed).
 *   - trading.trading_sessions opening-snapshot binding (#297/#312):
 *     account_currency, opening_snapshot_id, opening_snapshot_generation
 *   - trading.orders DISPATCH_COMMITTED support (#365): the status CHECK is
 *     replaced (same constraint name) with the round-6 superset that adds
 *     'DISPATCH_COMMITTED' — the explicit provider-dispatch commitment point.
 *   - broker.broker_accounts.last_snapshot_generation      (#312 monotonic
 *     legacy current-view projection guard)
 *   - broker.broker_connections.credential_refresh_lease_owner varchar(64)
 *     (task 6-d — exact lease ownership; `lease IS NULL` is NEVER ownership)
 */
export class CompleteExecutionAuthorityRound61754300000000 implements MigrationInterface {
  name = 'CompleteExecutionAuthorityRound61754300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ══ A. Shared control plane (issue #363) ══════════════════════════════
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS platform`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS platform.trading_policy_state (
        id                 integer PRIMARY KEY DEFAULT 1,
        current_revision   integer NOT NULL DEFAULT 1,
        policy_fingerprint varchar(64) NOT NULL,
        last_reason        varchar(200),
        last_bumped_at     timestamptz,
        created_at         timestamptz NOT NULL DEFAULT NOW(),
        updated_at         timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_trading_policy_state_singleton CHECK (id = 1),
        CONSTRAINT ck_trading_policy_state_revision CHECK (current_revision >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS platform.trading_policy_revision_logs (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        revision           integer NOT NULL,
        policy_fingerprint varchar(64) NOT NULL,
        reason             varchar(200) NOT NULL,
        description        varchar(500),
        created_at         timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_trading_policy_revision_logs_revision CHECK (revision >= 1),
        CONSTRAINT uq_trading_policy_revision_logs_revision UNIQUE (revision)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS platform.provider_live_verification_state (
        id                  integer PRIMARY KEY DEFAULT 1,
        current_revision    integer NOT NULL DEFAULT 1,
        catalog_fingerprint varchar(64) NOT NULL,
        last_reason         varchar(200),
        last_bumped_at      timestamptz,
        created_at          timestamptz NOT NULL DEFAULT NOW(),
        updated_at          timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_provider_live_verification_state_singleton CHECK (id = 1),
        CONSTRAINT ck_provider_live_verification_state_revision
          CHECK (current_revision >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS platform.provider_live_verification_revision_logs (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        revision            integer NOT NULL,
        catalog_fingerprint varchar(64) NOT NULL,
        reason              varchar(200) NOT NULL,
        description         varchar(500),
        created_at          timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_provider_live_verification_revision_logs_revision
          CHECK (revision >= 1),
        CONSTRAINT uq_provider_live_verification_revision_logs_revision
          UNIQUE (revision)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS platform.execution_control_revision_state (
        id               integer PRIMARY KEY DEFAULT 1,
        current_revision integer NOT NULL DEFAULT 1,
        last_reason      varchar(200),
        last_bumped_at   timestamptz,
        created_at       timestamptz NOT NULL DEFAULT NOW(),
        updated_at       timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_execution_control_revision_state_singleton CHECK (id = 1),
        CONSTRAINT ck_execution_control_revision_state_revision
          CHECK (current_revision >= 1)
      )
    `);

    // ══ B. Daily risk periods (issue #362) ════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.daily_risk_periods (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id               uuid NOT NULL,
        broker_connection_id  uuid NOT NULL,
        logical_account_key   varchar(200) NOT NULL,
        account_currency      varchar(3) NOT NULL,
        risk_period_date      date NOT NULL,
        opening_balance       numeric(20,8) NOT NULL,
        opening_equity        numeric(20,8) NOT NULL,
        opening_snapshot_id   uuid,
        risk_profile_id       uuid,
        risk_profile_revision integer,
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_daily_risk_periods_currency
          CHECK (account_currency ~ '^[A-Z]{3}$'),
        CONSTRAINT uq_daily_risk_periods_scope
          UNIQUE (user_id, logical_account_key, risk_period_date)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_risk_periods_user_day
      ON trading.daily_risk_periods (user_id, risk_period_date)
    `);

    // ══ C. Round-5 authority tables — idempotent existence guards ═════════
    // Shapes are IDENTICAL to migration 1754000000000 (no-op there); this
    // keeps the round-6 contract self-contained for environments that apply
    // the authority wave through this migration.
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

    // ══ D. Tenant-scoped unique indexes (issue #364) ══════════════════════
    // Preflight: rows that would violate the NEW tenant-scoped partial
    // uniques (only possible if the round-5 global indexes were manually
    // dropped) — fail with actionable diagnostics, never silently delete.
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT user_id, signal_id, COUNT(*) AS active_count
      FROM trading.risk_grants
      WHERE status = 'ACTIVE'
      GROUP BY user_id, signal_id
      HAVING COUNT(*) > 1
    `,
      'duplicate ACTIVE RiskGrants per (user, signal)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT user_id, signal_id, COUNT(*) AS pending_count
      FROM trading.execution_confirmations
      WHERE status = 'PENDING'
      GROUP BY user_id, signal_id
      HAVING COUNT(*) > 1
    `,
      'duplicate PENDING ExecutionConfirmations per (user, signal)',
    );

    // Create the tenant-scoped indexes FIRST, then drop the global ones, so
    // there is never a window without single-winner protection.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_grants_one_active_per_user_signal
      ON trading.risk_grants (user_id, signal_id)
      WHERE status = 'ACTIVE'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_confirmations_one_pending_per_user_signal
      ON trading.execution_confirmations (user_id, signal_id)
      WHERE status = 'PENDING'
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS trading.uq_risk_grants_one_active_per_signal`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS trading.uq_execution_confirmations_one_pending_per_signal`,
    );

    // ══ E. Referential-integrity preflights (issue #13 audit) ═════════════
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT g.id AS grant_id, g.user_id
      FROM trading.risk_grants g
      LEFT JOIN identity.users u ON u.id = g.user_id
      WHERE u.id IS NULL
    `,
      'orphan RiskGrants (user missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT g.id AS grant_id, g.session_id
      FROM trading.risk_grants g
      LEFT JOIN trading.trading_sessions s ON s.id = g.session_id
      WHERE s.id IS NULL
    `,
      'orphan RiskGrants (session missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT g.id AS grant_id, g.broker_connection_id
      FROM trading.risk_grants g
      LEFT JOIN broker.broker_connections c ON c.id = g.broker_connection_id
      WHERE c.id IS NULL
    `,
      'orphan RiskGrants (broker connection missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT g.id AS grant_id, g.account_snapshot_id
      FROM trading.risk_grants g
      LEFT JOIN broker.broker_account_snapshots snap ON snap.id = g.account_snapshot_id
      WHERE g.account_snapshot_id IS NOT NULL AND snap.id IS NULL
    `,
      'orphan RiskGrants (account snapshot missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT c.id AS confirmation_id, c.user_id
      FROM trading.execution_confirmations c
      LEFT JOIN identity.users u ON u.id = c.user_id
      WHERE u.id IS NULL
    `,
      'orphan ExecutionConfirmations (user missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT c.id AS confirmation_id, c.session_id
      FROM trading.execution_confirmations c
      LEFT JOIN trading.trading_sessions s ON s.id = c.session_id
      WHERE s.id IS NULL
    `,
      'orphan ExecutionConfirmations (session missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT c.id AS confirmation_id, c.broker_connection_id
      FROM trading.execution_confirmations c
      LEFT JOIN broker.broker_connections bc ON bc.id = c.broker_connection_id
      WHERE bc.id IS NULL
    `,
      'orphan ExecutionConfirmations (broker connection missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT c.id AS confirmation_id, c.risk_grant_id
      FROM trading.execution_confirmations c
      LEFT JOIN trading.risk_grants g ON g.id = c.risk_grant_id
      WHERE c.risk_grant_id IS NOT NULL AND g.id IS NULL
    `,
      'orphan ExecutionConfirmations (risk grant missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT i.id AS identity_id, i.user_id
      FROM trading.ai_signal_identities i
      LEFT JOIN identity.users u ON u.id = i.user_id
      WHERE u.id IS NULL
    `,
      'orphan AiSignalIdentities (user missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT t.id AS generation_id, t.user_id
      FROM identity.trading_authority_generations t
      LEFT JOIN identity.users u ON u.id = t.user_id
      WHERE u.id IS NULL
    `,
      'orphan TradingAuthorityGenerations (user missing)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT s.id AS snapshot_id, s.connection_id
      FROM broker.broker_account_snapshots s
      LEFT JOIN broker.broker_connections c ON c.id = s.connection_id
      WHERE c.id IS NULL
    `,
      'orphan BrokerAccountSnapshots (connection missing)',
    );

    // ══ F. Round-6 columns ════════════════════════════════════════════════

    // risk_profiles: monotonic revision (#299/#301/§15). Existing rows start
    // at revision 1 (the default) — no fabricated history, no data mutation.
    await queryRunner.query(`
      ALTER TABLE trading.risk_profiles
      ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE trading.risk_profiles
      ADD CONSTRAINT ck_risk_profiles_revision
      CHECK (revision >= 1)
    `);

    // risk_grants: complete authority binding (#301 + #363).
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD COLUMN IF NOT EXISTS authority_binding_digest varchar(64)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD COLUMN IF NOT EXISTS trading_policy_revision integer
    `);
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD COLUMN IF NOT EXISTS provider_verification_revision integer
    `);
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD CONSTRAINT ck_risk_grants_shared_revisions
      CHECK (
        (trading_policy_revision IS NULL OR trading_policy_revision >= 1)
        AND (provider_verification_revision IS NULL OR provider_verification_revision >= 1)
      )
    `);

    // trades: immutable session/account/currency/day provenance (#362).
    // Legacy rows stay NULL — historic currency/account identity is NEVER
    // re-derived from the mutable broker connection.
    await queryRunner.query(`
      ALTER TABLE trading.trades
      ADD COLUMN IF NOT EXISTS trading_session_id uuid
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trades
      ADD COLUMN IF NOT EXISTS logical_account_key varchar(255)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trades
      ADD COLUMN IF NOT EXISTS account_currency varchar(3)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trades
      ADD COLUMN IF NOT EXISTS risk_period_id uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_daily_loss_scope
      ON trading.trades (user_id, logical_account_key, account_currency, closed_at)
    `);

    // trading_sessions: opening-snapshot binding (#297/#312). Nullable —
    // legacy sessions have no snapshot lineage; NO synthetic currency.
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS account_currency varchar(3)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS opening_snapshot_id uuid
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS opening_snapshot_generation integer
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD CONSTRAINT ck_trading_sessions_account_currency
      CHECK (account_currency IS NULL OR account_currency ~ '^[A-Z]{3}$')
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD CONSTRAINT ck_trading_sessions_opening_snapshot_generation
      CHECK (opening_snapshot_generation IS NULL OR opening_snapshot_generation >= 1)
    `);

    // broker_accounts: monotonic legacy current-view projection guard (#312).
    await queryRunner.query(`
      ALTER TABLE broker.broker_accounts
      ADD COLUMN IF NOT EXISTS last_snapshot_generation integer
    `);
    await queryRunner.query(`
      ALTER TABLE broker.broker_accounts
      ADD CONSTRAINT ck_broker_accounts_last_snapshot_generation
      CHECK (last_snapshot_generation IS NULL OR last_snapshot_generation >= 1)
    `);

    // broker_connections: exact OAuth refresh-lease ownership (task 6-d).
    // varchar(64) NULL — a fresh unique owner token is minted at every
    // claim/takeover; `lease IS NULL` is NEVER treated as ownership.
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      ADD COLUMN IF NOT EXISTS "credential_refresh_lease_owner" varchar(64) NULL
    `);

    // orders: DISPATCH_COMMITTED support (#365). The status CHECK is
    // replaced (same constraint name) with the round-6 superset — all
    // existing values remain valid, so no row is mutated or rejected.
    await queryRunner.query(`ALTER TABLE trading.orders DROP CONSTRAINT IF EXISTS chk_orders_status`);
    await queryRunner.query(`
      ALTER TABLE trading.orders
      ADD CONSTRAINT chk_orders_status CHECK ("status" IN (
        'CREATED','SUBMITTED','DISPATCH_COMMITTED','ACKNOWLEDGED',
        'PARTIALLY_FILLED','FILLED','REJECTED','CANCELLED','EXPIRED',
        'RECONCILIATION_PENDING'
      ))
    `);

    // ══ E (cont.). Foreign keys — deliberate retention semantics ══════════
    // NO ACTION (the default): financial/audit authority history is never
    // silently CASCADE-deleted; parent deletion is blocked instead.
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD CONSTRAINT fk_risk_grants_user
      FOREIGN KEY (user_id) REFERENCES identity.users (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD CONSTRAINT fk_risk_grants_session
      FOREIGN KEY (session_id) REFERENCES trading.trading_sessions (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD CONSTRAINT fk_risk_grants_broker_connection
      FOREIGN KEY (broker_connection_id) REFERENCES broker.broker_connections (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.risk_grants
      ADD CONSTRAINT fk_risk_grants_account_snapshot
      FOREIGN KEY (account_snapshot_id) REFERENCES broker.broker_account_snapshots (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.execution_confirmations
      ADD CONSTRAINT fk_execution_confirmations_user
      FOREIGN KEY (user_id) REFERENCES identity.users (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.execution_confirmations
      ADD CONSTRAINT fk_execution_confirmations_session
      FOREIGN KEY (session_id) REFERENCES trading.trading_sessions (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.execution_confirmations
      ADD CONSTRAINT fk_execution_confirmations_broker_connection
      FOREIGN KEY (broker_connection_id) REFERENCES broker.broker_connections (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.execution_confirmations
      ADD CONSTRAINT fk_execution_confirmations_risk_grant
      FOREIGN KEY (risk_grant_id) REFERENCES trading.risk_grants (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.ai_signal_identities
      ADD CONSTRAINT fk_ai_signal_identities_user
      FOREIGN KEY (user_id) REFERENCES identity.users (id)
    `);
    await queryRunner.query(`
      ALTER TABLE identity.trading_authority_generations
      ADD CONSTRAINT fk_trading_authority_generations_user
      FOREIGN KEY (user_id) REFERENCES identity.users (id)
    `);
    await queryRunner.query(`
      ALTER TABLE broker.broker_account_snapshots
      ADD CONSTRAINT fk_broker_account_snapshots_connection
      FOREIGN KEY (connection_id) REFERENCES broker.broker_connections (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.daily_risk_periods
      ADD CONSTRAINT fk_daily_risk_periods_user
      FOREIGN KEY (user_id) REFERENCES identity.users (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.daily_risk_periods
      ADD CONSTRAINT fk_daily_risk_periods_broker_connection
      FOREIGN KEY (broker_connection_id) REFERENCES broker.broker_connections (id)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.daily_risk_periods
      ADD CONSTRAINT fk_daily_risk_periods_opening_snapshot
      FOREIGN KEY (opening_snapshot_id) REFERENCES broker.broker_account_snapshots (id)
    `);
    // trading_sessions.opening_snapshot_id is introduced by THIS migration
    // (NULL on every pre-existing row), so no orphan preflight is possible.
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD CONSTRAINT fk_trading_sessions_opening_snapshot
      FOREIGN KEY (opening_snapshot_id) REFERENCES broker.broker_account_snapshots (id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── Reverse the FKs added by this migration (round-5 objects remain) ──
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP CONSTRAINT IF EXISTS fk_trading_sessions_opening_snapshot`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.daily_risk_periods DROP CONSTRAINT IF EXISTS fk_daily_risk_periods_opening_snapshot`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.daily_risk_periods DROP CONSTRAINT IF EXISTS fk_daily_risk_periods_broker_connection`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.daily_risk_periods DROP CONSTRAINT IF EXISTS fk_daily_risk_periods_user`,
    );
    await queryRunner.query(
      `ALTER TABLE broker.broker_account_snapshots DROP CONSTRAINT IF EXISTS fk_broker_account_snapshots_connection`,
    );
    await queryRunner.query(
      `ALTER TABLE identity.trading_authority_generations DROP CONSTRAINT IF EXISTS fk_trading_authority_generations_user`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.ai_signal_identities DROP CONSTRAINT IF EXISTS fk_ai_signal_identities_user`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.execution_confirmations DROP CONSTRAINT IF EXISTS fk_execution_confirmations_risk_grant`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.execution_confirmations DROP CONSTRAINT IF EXISTS fk_execution_confirmations_broker_connection`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.execution_confirmations DROP CONSTRAINT IF EXISTS fk_execution_confirmations_session`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.execution_confirmations DROP CONSTRAINT IF EXISTS fk_execution_confirmations_user`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP CONSTRAINT IF EXISTS fk_risk_grants_account_snapshot`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP CONSTRAINT IF EXISTS fk_risk_grants_broker_connection`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP CONSTRAINT IF EXISTS fk_risk_grants_session`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP CONSTRAINT IF EXISTS fk_risk_grants_user`,
    );

    // ── Reverse the orders status CHECK (remove DISPATCH_COMMITTED) ───────
    await queryRunner.query(`ALTER TABLE trading.orders DROP CONSTRAINT IF EXISTS chk_orders_status`);
    await queryRunner.query(`
      ALTER TABLE trading.orders
      ADD CONSTRAINT chk_orders_status CHECK ("status" IN (
        'CREATED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED',
        'REJECTED','CANCELLED','EXPIRED','RECONCILIATION_PENDING'
      ))
    `);

    // ── Reverse the round-6 columns ────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "broker"."broker_connections"
      DROP COLUMN IF EXISTS "credential_refresh_lease_owner"
    `);
    await queryRunner.query(`
      ALTER TABLE broker.broker_accounts
      DROP CONSTRAINT IF EXISTS ck_broker_accounts_last_snapshot_generation
    `);
    await queryRunner.query(`
      ALTER TABLE broker.broker_accounts
      DROP COLUMN IF EXISTS last_snapshot_generation
    `);
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP CONSTRAINT IF EXISTS ck_trading_sessions_opening_snapshot_generation`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP CONSTRAINT IF EXISTS ck_trading_sessions_account_currency`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP COLUMN IF EXISTS opening_snapshot_generation`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP COLUMN IF EXISTS opening_snapshot_id`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.trading_sessions DROP COLUMN IF EXISTS account_currency`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS trading.idx_trades_daily_loss_scope`);
    await queryRunner.query(`ALTER TABLE trading.trades DROP COLUMN IF EXISTS risk_period_id`);
    await queryRunner.query(`ALTER TABLE trading.trades DROP COLUMN IF EXISTS account_currency`);
    await queryRunner.query(`ALTER TABLE trading.trades DROP COLUMN IF EXISTS logical_account_key`);
    await queryRunner.query(`ALTER TABLE trading.trades DROP COLUMN IF EXISTS trading_session_id`);
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP CONSTRAINT IF EXISTS ck_risk_grants_shared_revisions`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP COLUMN IF EXISTS provider_verification_revision`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP COLUMN IF EXISTS trading_policy_revision`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.risk_grants DROP COLUMN IF EXISTS authority_binding_digest`,
    );
    await queryRunner.query(
      `ALTER TABLE trading.risk_profiles DROP CONSTRAINT IF EXISTS ck_risk_profiles_revision`,
    );
    await queryRunner.query(`ALTER TABLE trading.risk_profiles DROP COLUMN IF EXISTS revision`);

    // ── Restore the round-5 GLOBAL partial uniques (tenant scoping off) ───
    // Preflight: if cross-tenant same-signal authority rows exist (legal
    // under round 6), the global indexes cannot be restored — fail with
    // actionable diagnostics instead of an opaque index error.
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT signal_id, COUNT(DISTINCT user_id) AS user_count
      FROM trading.risk_grants
      WHERE status = 'ACTIVE'
      GROUP BY signal_id
      HAVING COUNT(DISTINCT user_id) > 1
    `,
      'cross-tenant ACTIVE RiskGrants share a signal id (legal under round 6; the round-5 global unique cannot be restored)',
    );
    await this.preflightOrphans(
      queryRunner,
      `
      SELECT signal_id, COUNT(DISTINCT user_id) AS user_count
      FROM trading.execution_confirmations
      WHERE status = 'PENDING'
      GROUP BY signal_id
      HAVING COUNT(DISTINCT user_id) > 1
    `,
      'cross-tenant PENDING ExecutionConfirmations share a signal id (legal under round 6; the round-5 global unique cannot be restored)',
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_grants_one_active_per_signal
      ON trading.risk_grants (signal_id)
      WHERE status = 'ACTIVE'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_confirmations_one_pending_per_signal
      ON trading.execution_confirmations (signal_id)
      WHERE status = 'PENDING'
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS trading.uq_execution_confirmations_one_pending_per_user_signal`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS trading.uq_risk_grants_one_active_per_user_signal`,
    );

    // ── Drop the round-6 tables (round-5 authority tables remain — this
    //    migration only added FKs to them, reversed above) ─────────────────
    await queryRunner.query(`DROP INDEX IF EXISTS trading.idx_daily_risk_periods_user_day`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.daily_risk_periods`);
    await queryRunner.query(`DROP TABLE IF EXISTS platform.execution_control_revision_state`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS platform.provider_live_verification_revision_logs`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS platform.provider_live_verification_state`);
    await queryRunner.query(`DROP TABLE IF EXISTS platform.trading_policy_revision_logs`);
    await queryRunner.query(`DROP TABLE IF EXISTS platform.trading_policy_state`);
  }

  /**
   * Fail-closed preflight: run `sql`, and when it returns ANY row, abort the
   * migration with actionable diagnostics. Never deletes or mutates data.
   */
  private async preflightOrphans(
    queryRunner: QueryRunner,
    sql: string,
    diagnostic: string,
  ): Promise<void> {
    const rows = await queryRunner.query(sql);
    if (Array.isArray(rows) && rows.length > 0) {
      const sample = rows
        .slice(0, 10)
        .map((r: Record<string, unknown>) => JSON.stringify(r))
        .join('; ');
      throw new Error(
        `CompleteExecutionAuthorityRound6 migration preflight FAILED: ${diagnostic} ` +
          `(${rows.length} rows). Deterministic remediation required BEFORE this ` +
          `migration: reconcile or archive the offending rows explicitly — this ` +
          `migration never deletes data. Offending rows: ${sample}`,
      );
    }
  }
}
