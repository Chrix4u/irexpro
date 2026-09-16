import * as fs from 'fs';
import * as path from 'path';

/**
 * Execution Authority schema reconciliation (Sprint 56 correction round 5).
 *
 * Verifies that every column mapped by the new authority entities
 * (RiskGrant, ExecutionConfirmation, AiSignalIdentity,
 * TradingAuthorityGeneration, BrokerAccountSnapshot) and the new
 * TradingSession columns exists in the Round-5 authority migration, and
 * that the critical safety constraints (one ACTIVE session per user,
 * one ACTIVE grant per signal, one PENDING confirmation per signal,
 * monotonic snapshot generation, signal identity uniqueness, migration
 * preflight diagnostics) are actually present.
 */
describe('Execution authority schema reconciliation (round 5)', () => {
  const root = path.resolve(__dirname, '../modules');
  const migrationPath = path.resolve(
    __dirname,
    './migrations/1754000000000-CreateExecutionAuthoritySchema.ts',
  );
  // Round 5 task 50-c: the final-dispatch fencing columns
  // (risk_grants.credential_generation, trades.dispatch_certainty) live in a
  // follow-up migration — the entity↔migration coverage below searches the
  // CONCATENATED sources of both authority migrations.
  const fencingMigrationPath = path.resolve(
    __dirname,
    './migrations/1754200000000-AddFinalDispatchFencingColumns.ts',
  );
  // Round 6 (R6-A): the complete-authority wave — shared control-plane
  // tables, daily_risk_periods, tenant-scoped uniques, FKs, and the round-6
  // entity columns (risk_grants authority binding, trading_sessions opening
  // snapshot binding, …) live in the round-6 migration; the coverage below
  // searches the CONCATENATED sources of all three authority migrations.
  const round6MigrationPath = path.resolve(
    __dirname,
    './migrations/1754300000000-CompleteExecutionAuthorityRound6.ts',
  );

  const entityPaths = {
    riskGrant: path.resolve(root, 'execution/entities/risk-grant.entity.ts'),
    confirmation: path.resolve(root, 'execution/entities/execution-confirmation.entity.ts'),
    signalIdentity: path.resolve(root, 'execution/entities/ai-signal-identity.entity.ts'),
    authorityGeneration: path.resolve(
      root,
      'users/entities/trading-authority-generation.entity.ts',
    ),
    accountSnapshot: path.resolve(root, 'broker/entities/broker-account-snapshot.entity.ts'),
    tradingSession: path.resolve(root, 'execution/entities/trading-session.entity.ts'),
  };

  let migrationSource: string;
  const entitySources: Record<string, string> = {};

  beforeAll(() => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    migrationSource = fs.readFileSync(migrationPath, 'utf-8');
    expect(fs.existsSync(fencingMigrationPath)).toBe(true);
    migrationSource += '\n' + fs.readFileSync(fencingMigrationPath, 'utf-8');
    expect(fs.existsSync(round6MigrationPath)).toBe(true);
    migrationSource += '\n' + fs.readFileSync(round6MigrationPath, 'utf-8');
    for (const [key, p] of Object.entries(entityPaths)) {
      expect(fs.existsSync(p)).toBe(true);
      entitySources[key] = fs.readFileSync(p, 'utf-8');
    }
  });

  function extractEntityColumnNames(source: string): string[] {
    const names: string[] = [];
    // multi-line-safe: match @Column-decorator blocks and pull the name: option
    const columnBlockRegex =
      /@(?:Column|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|PrimaryGeneratedColumn)\(\s*\{[^}]*?\}/gs;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = columnBlockRegex.exec(source)) !== null) {
      const nameMatch = blockMatch[0].match(/name:\s*['"]([^'"]+)['"]/);
      if (nameMatch && nameMatch[1]) {
        names.push(nameMatch[1]);
      }
    }
    return names;
  }

  it('migration file exists and is named CreateExecutionAuthoritySchema1754000000000', () => {
    expect(migrationSource).toContain('CreateExecutionAuthoritySchema1754000000000');
  });

  // ── Entity → migration column coverage ─────────────────────────────────────

  it('every RiskGrant entity column exists in the authority migration', () => {
    const cols = extractEntityColumnNames(entitySources.riskGrant);
    expect(cols.length).toBeGreaterThanOrEqual(25);
    for (const col of cols) {
      expect(migrationSource).toContain(col);
    }
  });

  it('every ExecutionConfirmation entity column exists in the authority migration', () => {
    const cols = extractEntityColumnNames(entitySources.confirmation);
    expect(cols.length).toBeGreaterThanOrEqual(18);
    for (const col of cols) {
      expect(migrationSource).toContain(col);
    }
  });

  it('every AiSignalIdentity entity column exists in the authority migration', () => {
    const cols = extractEntityColumnNames(entitySources.signalIdentity);
    expect(cols.length).toBeGreaterThanOrEqual(9);
    for (const col of cols) {
      expect(migrationSource).toContain(col);
    }
  });

  it('every TradingAuthorityGeneration entity column exists in the authority migration', () => {
    const cols = extractEntityColumnNames(entitySources.authorityGeneration);
    expect(cols.length).toBeGreaterThanOrEqual(6);
    for (const col of cols) {
      expect(migrationSource).toContain(col);
    }
  });

  it('every BrokerAccountSnapshot entity column exists in the authority migration', () => {
    const cols = extractEntityColumnNames(entitySources.accountSnapshot);
    expect(cols.length).toBeGreaterThanOrEqual(15);
    for (const col of cols) {
      expect(migrationSource).toContain(col);
    }
  });

  it('TradingSession entity carries execution_mode and authority_generation', () => {
    const cols = extractEntityColumnNames(entitySources.tradingSession);
    expect(cols).toContain('execution_mode');
    expect(cols).toContain('authority_generation');
    // and the migration adds both
    expect(migrationSource).toMatch(/ADD COLUMN IF NOT EXISTS execution_mode/);
    expect(migrationSource).toMatch(/ADD COLUMN IF NOT EXISTS authority_generation/);
  });

  // ── Safety constraints ─────────────────────────────────────────────────────

  it('enforces at most ONE ACTIVE TradingSession per user (partial unique)', () => {
    expect(migrationSource).toContain('uq_trading_sessions_one_active_per_user');
    expect(migrationSource).toMatch(
      /CREATE UNIQUE INDEX[^;]*\(user_id\)[^;]*WHERE status = 'ACTIVE'/s,
    );
  });

  it('enforces at most ONE ACTIVE RiskGrant per signal (partial unique)', () => {
    expect(migrationSource).toContain('uq_risk_grants_one_active_per_signal');
    expect(migrationSource).toMatch(
      /CREATE UNIQUE INDEX[^;]*\(signal_id\)[^;]*WHERE status = 'ACTIVE'/s,
    );
  });

  it('enforces at most ONE PENDING confirmation per signal (partial unique)', () => {
    expect(migrationSource).toContain('uq_execution_confirmations_one_pending_per_signal');
    expect(migrationSource).toMatch(
      /CREATE UNIQUE INDEX[^;]*\(signal_id\)[^;]*WHERE status = 'PENDING'/s,
    );
  });

  it('enforces immutable signal identity uniqueness (user_id, signal_id)', () => {
    expect(migrationSource).toContain('uq_ai_signal_identity_user_signal');
  });

  it('enforces monotonic snapshot generations (unique connection+generation, CHECK >= 1)', () => {
    expect(migrationSource).toContain('uq_broker_account_snapshot_connection_generation');
    expect(migrationSource).toMatch(
      /ck_broker_account_snapshots_generation[\s\S]*?CHECK \(generation >= 1\)/,
    );
  });

  it('enforces execution mode domain via CHECK constraint', () => {
    expect(migrationSource).toMatch(
      /ck_trading_sessions_execution_mode[\s\S]*?CHECK \(execution_mode IN \('PAPER_ONLY', 'SEMI_AUTO', 'FULL_AUTO'\)\)/,
    );
  });

  it('binds sessions to users and broker connections with FKs', () => {
    expect(migrationSource).toContain('fk_trading_sessions_user');
    expect(migrationSource).toContain('fk_trading_sessions_broker_connection');
    expect(migrationSource).toContain('REFERENCES identity.users (id)');
    expect(migrationSource).toContain('REFERENCES broker.broker_connections (id)');
  });

  // ── Migration preflight (fail closed, no silent deletion) ──────────────────

  it('prefails on duplicate ACTIVE sessions with actionable diagnostics', () => {
    expect(migrationSource).toContain('duplicate ACTIVE TradingSessions');
    expect(migrationSource).toContain('this migration never deletes data');
  });

  it('prefails on orphan sessions (user and connection)', () => {
    expect(migrationSource).toContain('orphan TradingSessions (user missing)');
    expect(migrationSource).toContain('orphan TradingSessions (broker connection missing)');
  });

  it('down migration reverses all authority objects safely', () => {
    const downStart = migrationSource.indexOf('public async down');
    const downBody = migrationSource.substring(downStart);
    expect(downBody).toContain('DROP TABLE IF EXISTS broker.broker_account_snapshots');
    expect(downBody).toContain('DROP TABLE IF EXISTS trading.risk_grants');
    expect(downBody).toContain('DROP TABLE IF EXISTS trading.execution_confirmations');
    expect(downBody).toContain('DROP TABLE IF EXISTS trading.ai_signal_identities');
    expect(downBody).toContain('DROP TABLE IF EXISTS identity.trading_authority_generations');
    expect(downBody).toContain('DROP COLUMN IF EXISTS execution_mode');
    expect(downBody).toContain('DROP COLUMN IF EXISTS authority_generation');
  });

  // ── Round 5 task 50-c — final-dispatch fencing columns ──────────────────────

  it('adds nullable risk_grants.credential_generation for dispatch fencing (#361)', () => {
    expect(migrationSource).toMatch(
      /ALTER TABLE trading\.risk_grants\s+ADD COLUMN IF NOT EXISTS credential_generation integer/,
    );
  });

  it('adds nullable trades.dispatch_certainty with a domain CHECK (#314)', () => {
    expect(migrationSource).toMatch(
      /ALTER TABLE trading\.trades\s+ADD COLUMN IF NOT EXISTS dispatch_certainty varchar\(30\)/,
    );
    expect(migrationSource).toContain('ck_trades_dispatch_certainty');
    expect(migrationSource).toContain("'DEFINITELY_NOT_SENT'");
    expect(migrationSource).toContain("'MAY_HAVE_REACHED_PROVIDER'");
  });

  // ── Round 6 (R6-A) — complete execution authority ════════════════════════

  it('round-6 migration exists and is named CompleteExecutionAuthorityRound61754300000000', () => {
    expect(migrationSource).toContain('CompleteExecutionAuthorityRound61754300000000');
  });

  it('creates the shared control-plane singletons and revision logs (#363)', () => {
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS platform.trading_policy_state');
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS platform.trading_policy_revision_logs',
    );
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS platform.provider_live_verification_state',
    );
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS platform.provider_live_verification_revision_logs',
    );
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS platform.execution_control_revision_state',
    );
    expect(migrationSource).toContain('ck_trading_policy_state_singleton');
    expect(migrationSource).toContain('uq_trading_policy_revision_logs_revision');
    expect(migrationSource).toContain('uq_provider_live_verification_revision_logs_revision');
    expect(migrationSource).toContain('ck_execution_control_revision_state_singleton');
  });

  it('creates trading.daily_risk_periods with the (user, logical account, day) budget scope (#362)', () => {
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS trading.daily_risk_periods');
    expect(migrationSource).toContain('uq_daily_risk_periods_scope');
    expect(migrationSource).toMatch(/UNIQUE \(user_id, logical_account_key, risk_period_date\)/);
    expect(migrationSource).toContain('idx_daily_risk_periods_user_day');
  });

  it('replaces the global signal uniques with tenant-scoped ones (#364)', () => {
    expect(migrationSource).toContain('uq_risk_grants_one_active_per_user_signal');
    expect(migrationSource).toContain('uq_execution_confirmations_one_pending_per_user_signal');
    expect(migrationSource).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_grants_one_active_per_user_signal[\s\S]*?ON trading\.risk_grants \(user_id, signal_id\)[\s\S]*?WHERE status = 'ACTIVE'/,
    );
    expect(migrationSource).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_confirmations_one_pending_per_user_signal[\s\S]*?ON trading\.execution_confirmations \(user_id, signal_id\)[\s\S]*?WHERE status = 'PENDING'/,
    );
    // The global round-5 indexes are dropped (create-new-first, so there is
    // never a window without single-winner protection).
    expect(migrationSource).toContain(
      'DROP INDEX IF EXISTS trading.uq_risk_grants_one_active_per_signal',
    );
    expect(migrationSource).toContain(
      'DROP INDEX IF EXISTS trading.uq_execution_confirmations_one_pending_per_signal',
    );
  });

  it('adds referential integrity to the authority tables with retention semantics (#13 audit)', () => {
    expect(migrationSource).toContain('fk_risk_grants_user');
    expect(migrationSource).toContain('fk_risk_grants_session');
    expect(migrationSource).toContain('fk_risk_grants_broker_connection');
    expect(migrationSource).toContain('fk_risk_grants_account_snapshot');
    expect(migrationSource).toContain('fk_execution_confirmations_risk_grant');
    expect(migrationSource).toContain('fk_ai_signal_identities_user');
    expect(migrationSource).toContain('fk_trading_authority_generations_user');
    expect(migrationSource).toContain('fk_broker_account_snapshots_connection');
    // Never CASCADE on financial/audit authority history — retention (NO
    // ACTION) semantics only; the migration contains no ON DELETE CASCADE.
    expect(migrationSource).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('adds the round-6 risk_grants authority binding columns (#301/#363)', () => {
    expect(migrationSource).toMatch(
      /ALTER TABLE trading\.risk_grants\s+ADD COLUMN IF NOT EXISTS authority_binding_digest varchar\(64\)/,
    );
    expect(migrationSource).toMatch(/ADD COLUMN IF NOT EXISTS trading_policy_revision integer/);
    expect(migrationSource).toMatch(
      /ADD COLUMN IF NOT EXISTS provider_verification_revision integer/,
    );
  });

  it('adds the trading_sessions opening-snapshot binding and trades provenance (#297/#312/#362)', () => {
    expect(migrationSource).toMatch(
      /ALTER TABLE trading\.trading_sessions\s+ADD COLUMN IF NOT EXISTS account_currency varchar\(3\)/,
    );
    expect(migrationSource).toMatch(/ADD COLUMN IF NOT EXISTS opening_snapshot_id uuid/);
    expect(migrationSource).toMatch(/ADD COLUMN IF NOT EXISTS opening_snapshot_generation integer/);
    expect(migrationSource).toMatch(
      /ALTER TABLE trading\.trades\s+ADD COLUMN IF NOT EXISTS trading_session_id uuid/,
    );
    expect(migrationSource).toMatch(/ADD COLUMN IF NOT EXISTS logical_account_key varchar\(255\)/);
    expect(migrationSource).toMatch(/ADD COLUMN IF NOT EXISTS account_currency varchar\(3\)/);
    expect(migrationSource).toMatch(/ADD COLUMN IF NOT EXISTS risk_period_id uuid/);
  });

  it('adds risk_profiles.revision and broker_accounts.last_snapshot_generation (#299/#312)', () => {
    expect(migrationSource).toMatch(
      /ALTER TABLE trading\.risk_profiles\s+ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1/,
    );
    expect(migrationSource).toMatch(
      /ALTER TABLE broker\.broker_accounts\s+ADD COLUMN IF NOT EXISTS last_snapshot_generation integer/,
    );
  });

  it('supports the orders DISPATCH_COMMITTED status (#365)', () => {
    expect(migrationSource).toContain('DROP CONSTRAINT IF EXISTS chk_orders_status');
    expect(migrationSource).toMatch(
      /ADD CONSTRAINT chk_orders_status CHECK \("status" IN \([\s\S]*?'DISPATCH_COMMITTED'/,
    );
  });
});
