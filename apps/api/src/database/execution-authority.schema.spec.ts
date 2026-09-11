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
});
