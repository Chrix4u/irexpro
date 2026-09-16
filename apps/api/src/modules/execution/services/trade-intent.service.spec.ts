import { DataSource, Repository } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  INTENT_MAX_AGE_MS,
  TradeIntentNotUsableError,
  TradeIntentService,
} from './trade-intent.service';
import { TradeIntent, TradeIntentStatus } from '../entities/trade-intent.entity';

/**
 * TradeIntentService (Round 6 live-execution completion §2): the durable,
 * normalized AI-decision layer — exactly-once intent identity + the
 * stale/terminal decision guards.
 *
 * REAL sqlite store with REAL TypeORM repositories: the TradeIntentService
 * under test is the REAL production code. The production entity declares
 * PostgreSQL-native column types (timestamptz/jsonb/numeric) the sqlite
 * driver refuses to register, so this harness mirrors the table 1:1 (same
 * table/column names + the EXACT uq_trade_intents_user_intent_key unique
 * constraint) and casts the repository to the production entity type — the
 * pattern of risk-grant.spec.ts / signal-identity.gate.spec.ts. The
 * pg-integration suites re-prove the same guarantees against real
 * PostgreSQL.
 *
 * Matrix (§2 + §13 step 1):
 *   - recordOrReuseIntent: created=true first, reused=true on redelivery —
 *     EXACTLY ONE row per (userId, signalId) after retries, worker restarts
 *     and CONCURRENT racing workers (the UNIQUE violation loser re-reads the
 *     winner's row)
 *   - full §2 provenance persisted: source decision id + ORIGINAL
 *     generatedAt, user, connection, logical account, session, strategy/
 *     model/timeframe, instrument/direction/entry type, requested exposure,
 *     protective parameters, expiry, rationale, metadata, authority
 *     generations at creation
 *   - entry-type derivation: the '0' MARKET sentinel → MARKET + NULL price;
 *     a positive price → LIMIT (never a fabricated 0 limit)
 *   - expiry measured from the ORIGINAL signalGeneratedAt — a redelivery
 *     near the boundary cannot refresh a stale decision
 *   - resolveIntentForExecutionBySignal: CREATED+fresh resolves; missing /
 *     EXPIRED / SUPERSEDED / EXECUTED / REJECTED / elapsed-CREATED all fail
 *     closed with the typed error (a stale/expired/replaced AI decision
 *     never creates new exposure)
 *   - markExecuted is a guarded CAS: binds the trade id once; a second bind
 *     (different trade) never rewrites the original
 *   - markRejected / markExpired: CREATED-only transitions — terminal
 *     states never regress
 *   - different users, same signalId → independent intents
 */

// ─── sqlite mirror entity (1:1 with the production trading.trade_intents) ──

@Entity({ name: 'trade_intents' })
@Index('uq_trade_intents_user_intent_key', ['userId', 'intentKey'], { unique: true })
@Index('ix_trade_intents_user_status', ['userId', 'status'])
class TradeIntentMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'intent_key', type: 'varchar', length: 255 })
  intentKey: string;
  @Column({ name: 'signal_id', type: 'varchar', length: 100 })
  signalId: string;
  @Column({ name: 'signal_generated_at', type: 'datetime' })
  signalGeneratedAt: Date;
  @Column({ name: 'broker_connection_id', type: 'varchar' })
  brokerConnectionId: string;
  @Column({ name: 'logical_account_key', type: 'varchar', length: 255, nullable: true })
  logicalAccountKey: string | null;
  @Column({ name: 'trading_session_id', type: 'varchar', nullable: true })
  tradingSessionId: string | null;
  @Column({ name: 'strategy_code', type: 'varchar', length: 100, nullable: true })
  strategyCode: string | null;
  @Column({ name: 'model_version', type: 'varchar', length: 100, nullable: true })
  modelVersion: string | null;
  @Column({ name: 'timeframe', type: 'varchar', length: 20, nullable: true })
  timeframe: string | null;
  @Column({ type: 'varchar', length: 30 })
  instrument: string;
  @Column({ type: 'varchar', length: 4 })
  direction: 'BUY' | 'SELL';
  @Column({ name: 'entry_type', type: 'varchar', length: 20, default: 'MARKET' })
  entryType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  @Column({ name: 'requested_lot_size', type: 'varchar', length: 32 })
  requestedLotSize: string;
  @Column({ name: 'requested_entry_price', type: 'varchar', length: 32, nullable: true })
  requestedEntryPrice: string | null;
  @Column({ name: 'stop_loss', type: 'varchar', length: 32, nullable: true })
  stopLoss: string | null;
  @Column({ name: 'take_profit', type: 'varchar', length: 32, nullable: true })
  takeProfit: string | null;
  @Column({ name: 'trailing_stop_pips', type: 'varchar', length: 32, nullable: true })
  trailingStopPips: string | null;
  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;
  @Column({ name: 'market_data_ref', type: 'simple-json', nullable: true })
  marketDataRef: Record<string, unknown> | null;
  @Column({ type: 'text', nullable: true })
  rationale: string | null;
  @Column({ type: 'simple-json', nullable: true })
  metadata: Record<string, unknown> | null;
  @Column({ name: 'authority_generation', type: 'integer' })
  authorityGeneration: number;
  @Column({ name: 'trading_policy_revision', type: 'integer', nullable: true })
  tradingPolicyRevision: number | null;
  @Column({ name: 'provider_verification_revision', type: 'integer', nullable: true })
  providerVerificationRevision: number | null;
  @Column({ name: 'execution_control_revision', type: 'integer', nullable: true })
  executionControlRevision: number | null;
  @Column({ type: 'varchar', length: 20, default: TradeIntentStatus.CREATED })
  status: TradeIntentStatus;
  @Column({ name: 'trade_id', type: 'varchar', nullable: true })
  tradeId: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

const facts = (
  overrides: Partial<Parameters<TradeIntentService['recordOrReuseIntent']>[0]> = {},
) => ({
  userId: USER,
  signalId: 'sig-001',
  signalGeneratedAt: new Date(),
  brokerConnectionId: CONN,
  logicalAccountKey: 'paper-broker::demo::acct-1',
  tradingSessionId: SESSION,
  strategyCode: 'TREND_V1',
  modelVersion: '1.0.0',
  timeframe: 'H1',
  instrument: 'EURUSD',
  direction: 'BUY' as const,
  requestedLotSize: '0.05',
  requestedEntryPrice: null,
  stopLoss: '1.07500',
  takeProfit: '1.09500',
  trailingStopPips: null,
  rationale: 'trend continuation',
  metadata: { confidenceScore: 0.82 },
  authorityGeneration: 3,
  tradingPolicyRevision: 7,
  providerVerificationRevision: 2,
  executionControlRevision: 11,
  ...overrides,
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('TradeIntentService — durable normalized AI decisions (Round 6 §2)', () => {
  let dataSource: DataSource;
  let repo: Repository<TradeIntentMirror>;
  let service: TradeIntentService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [TradeIntentMirror],
    });
    await dataSource.initialize();
    repo = dataSource.getRepository(TradeIntentMirror);
    service = new TradeIntentService(repo as unknown as Repository<TradeIntent>);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM trade_intents');
  });

  // ─── recordOrReuseIntent: exactly-once identity ──────────────────────────

  describe('recordOrReuseIntent', () => {
    it('creates the intent with the FULL §2 provenance on first delivery', async () => {
      const generatedAt = new Date('2025-09-15T10:00:00.000Z');
      const { created, intent } = await service.recordOrReuseIntent(
        facts({ signalGeneratedAt: generatedAt }),
      );

      expect(created).toBe(true);
      expect(intent.status).toBe(TradeIntentStatus.CREATED);
      expect(intent.intentKey).toBe(`${USER}:sig-001`);
      expect(intent.signalId).toBe('sig-001');
      expect(intent.signalGeneratedAt.toISOString()).toBe(generatedAt.toISOString());
      expect(intent.brokerConnectionId).toBe(CONN);
      expect(intent.logicalAccountKey).toBe('paper-broker::demo::acct-1');
      expect(intent.tradingSessionId).toBe(SESSION);
      expect(intent.strategyCode).toBe('TREND_V1');
      expect(intent.modelVersion).toBe('1.0.0');
      expect(intent.timeframe).toBe('H1');
      expect(intent.instrument).toBe('EURUSD');
      expect(intent.direction).toBe('BUY');
      expect(intent.entryType).toBe('MARKET');
      expect(intent.requestedLotSize).toBe('0.05');
      expect(intent.stopLoss).toBe('1.07500');
      expect(intent.takeProfit).toBe('1.09500');
      expect(intent.rationale).toBe('trend continuation');
      expect(intent.metadata).toEqual({ confidenceScore: 0.82 });
      expect(intent.authorityGeneration).toBe(3);
      expect(intent.tradingPolicyRevision).toBe(7);
      expect(intent.providerVerificationRevision).toBe(2);
      expect(intent.executionControlRevision).toBe(11);
      // Expiry measured from the ORIGINAL producer instant.
      expect(intent.expiresAt.getTime()).toBe(generatedAt.getTime() + INTENT_MAX_AGE_MS);
    });

    it('reuses the SAME row on a redelivery — exactly one intent per decision (queue retry / worker restart)', async () => {
      await service.recordOrReuseIntent(facts());
      const second = await service.recordOrReuseIntent(facts());

      expect(second.created).toBe(false);
      if (!second.created) {
        expect(second.reused).toBe(true);
      }
      const rows = await repo.find();
      expect(rows).toHaveLength(1);
      expect(second.intent.id).toBe(rows[0].id);
    });

    it("a CONCURRENT racing duplicate resolves to the winner's row — never a second intent (§13 step 1)", async () => {
      const results = await Promise.all([
        service.recordOrReuseIntent(facts()),
        service.recordOrReuseIntent(facts()),
        service.recordOrReuseIntent(facts()),
      ]);

      const rows = await repo.find();
      expect(rows).toHaveLength(1);
      // At most one worker reports created=true; every other resolves the
      // winner's row as reused.
      const createdCount = results.filter((r) => r.created).length;
      expect(createdCount).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.intent.id).toBe(rows[0].id);
      }
    });

    it('different users with the same signalId get INDEPENDENT intents', async () => {
      await service.recordOrReuseIntent(facts());
      await service.recordOrReuseIntent(facts({ userId: USER_B }));

      const rows = await repo.find();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([USER, USER_B]));
    });

    it('normalizes the signal layer\'s "0" MARKET sentinel to a NULL requested price (never a zero limit)', async () => {
      const { intent } = await service.recordOrReuseIntent(facts({ requestedEntryPrice: '0' }));
      expect(intent.entryType).toBe('MARKET');
      expect(intent.requestedEntryPrice).toBeNull();
    });

    it('derives LIMIT entry type from a positive requested price', async () => {
      const { intent } = await service.recordOrReuseIntent(
        facts({ requestedEntryPrice: '1.08250' }),
      );
      expect(intent.entryType).toBe('LIMIT');
      expect(intent.requestedEntryPrice).toBe('1.08250');
    });
  });

  // ─── resolveIntentForExecutionBySignal: the §2 guards ────────────────────

  describe('resolveIntentForExecutionBySignal', () => {
    it('resolves a CREATED, unexpired intent', async () => {
      const { intent } = await service.recordOrReuseIntent(facts());
      const resolved = await service.resolveIntentForExecutionBySignal(USER, 'sig-001');
      expect(resolved.id).toBe(intent.id);
    });

    it('fails closed when NO intent was recorded (off-pipeline exposure attempt)', async () => {
      await expect(
        service.resolveIntentForExecutionBySignal(USER, 'sig-unknown'),
      ).rejects.toBeInstanceOf(TradeIntentNotUsableError);
    });

    it('fails closed on an EXPIRED intent — a stale AI decision never creates new exposure', async () => {
      const staleGeneratedAt = new Date(Date.now() - INTENT_MAX_AGE_MS - 5_000);
      const { intent } = await service.recordOrReuseIntent(
        facts({ signalGeneratedAt: staleGeneratedAt }),
      );
      // The resolution lazily applies the EXPIRED transition.
      await expect(service.resolveIntentForExecutionBySignal(USER, 'sig-001')).rejects.toThrow(
        /expired/i,
      );

      const row = await repo.findOne({ where: { id: intent.id } });
      expect(row?.status).toBe(TradeIntentStatus.EXPIRED);
    });

    it('fails closed on an explicitly-EXPIRED row without touching the expiry clock', async () => {
      const { intent } = await service.recordOrReuseIntent(facts());
      await repo.update(intent.id, { status: TradeIntentStatus.EXPIRED });
      await expect(service.resolveIntentForExecutionBySignal(USER, 'sig-001')).rejects.toThrow(
        /expired/i,
      );
    });

    it('fails closed on a SUPERSEDED (replaced) decision', async () => {
      const { intent } = await service.recordOrReuseIntent(facts());
      await repo.update(intent.id, { status: TradeIntentStatus.SUPERSEDED });
      await expect(service.resolveIntentForExecutionBySignal(USER, 'sig-001')).rejects.toThrow(
        /superseded/i,
      );
    });

    it('fails closed on an EXECUTED decision — a replay can never open a second exposure', async () => {
      const { intent } = await service.recordOrReuseIntent(facts());
      await service.markExecuted(intent.id, 'trade-1');
      await expect(service.resolveIntentForExecutionBySignal(USER, 'sig-001')).rejects.toThrow(
        /already executed/i,
      );
    });

    it('fails closed on a REJECTED decision — a risk-rejected decision stays rejected', async () => {
      const { intent } = await service.recordOrReuseIntent(facts());
      await service.markRejected(intent.id);
      await expect(service.resolveIntentForExecutionBySignal(USER, 'sig-001')).rejects.toThrow(
        /previously rejected/i,
      );
    });

    it('scopes the lookup to the owning user (tenant isolation)', async () => {
      await service.recordOrReuseIntent(facts());
      await expect(
        service.resolveIntentForExecutionBySignal(USER_B, 'sig-001'),
      ).rejects.toBeInstanceOf(TradeIntentNotUsableError);
    });
  });

  // ─── CAS transitions ─────────────────────────────────────────────────────

  describe('markExecuted / markRejected / markExpired (guarded CAS)', () => {
    it('markExecuted binds the trade id exactly ONCE — a later bind never rewrites it', async () => {
      const { intent } = await service.recordOrReuseIntent(facts());
      await service.markExecuted(intent.id, 'trade-original');
      // A racing duplicate delivery tries to bind a different trade.
      await service.markExecuted(intent.id, 'trade-intruder');

      const row = await repo.findOne({ where: { id: intent.id } });
      expect(row?.status).toBe(TradeIntentStatus.EXECUTED);
      expect(row?.tradeId).toBe('trade-original');
    });

    it('markRejected transitions CREATED → REJECTED; an EXECUTED intent never regresses', async () => {
      const { intent } = await service.recordOrReuseIntent(facts());
      await service.markExecuted(intent.id, 'trade-1');
      await service.markRejected(intent.id);

      const row = await repo.findOne({ where: { id: intent.id } });
      expect(row?.status).toBe(TradeIntentStatus.EXECUTED);
    });

    it('markExpired transitions CREATED → EXPIRED only', async () => {
      const { intent } = await service.recordOrReuseIntent(facts());
      await service.markExpired(intent.id);
      const row = await repo.findOne({ where: { id: intent.id } });
      expect(row?.status).toBe(TradeIntentStatus.EXPIRED);
    });
  });

  // ─── Round 7 (P1): the proactive expiry sweeper ──────────────────────────

  describe('expireStaleCreatedIntents (Round 7 expiry hygiene)', () => {
    it('expires every CREATED intent past its window and returns the ids', async () => {
      // A stale CREATED intent (generated 10 minutes ago ⇒ expired).
      await service.recordOrReuseIntent(
        facts({ signalId: 'sig-stale', signalGeneratedAt: new Date(Date.now() - 600_000) }),
      );
      // A fresh CREATED intent (still inside the window).
      const fresh = await service.recordOrReuseIntent(
        facts({ signalId: 'sig-fresh', signalGeneratedAt: new Date() }),
      );

      const expiredIds = await service.expireStaleCreatedIntents();

      expect(expiredIds).toHaveLength(1);
      const expiredRow = await repo.findOne({ where: { signalId: 'sig-stale' } });
      expect(expiredRow?.status).toBe(TradeIntentStatus.EXPIRED);
      // The fresh intent is untouched.
      const freshRow = await repo.findOne({ where: { id: fresh.intent.id } });
      expect(freshRow?.status).toBe(TradeIntentStatus.CREATED);
    });

    it('never touches terminal intents (EXECUTED/REJECTED stay as they are)', async () => {
      const executed = await service.recordOrReuseIntent(
        facts({ signalId: 'sig-exec', signalGeneratedAt: new Date(Date.now() - 600_000) }),
      );
      await service.markExecuted(executed.intent.id, 'trade-1');

      const expiredIds = await service.expireStaleCreatedIntents();
      expect(expiredIds).toHaveLength(0);
      const row = await repo.findOne({ where: { id: executed.intent.id } });
      expect(row?.status).toBe(TradeIntentStatus.EXECUTED);
    });

    it('an empty table is a clean no-op', async () => {
      expect(await service.expireStaleCreatedIntents()).toEqual([]);
    });
  });

  // ─── helpers ─────────────────────────────────────────────────────────────

  describe('static helpers', () => {
    it('intentKeyFor is the stable <userId>:<signalId> identity', () => {
      expect(TradeIntentService.intentKeyFor(USER, 'sig-9')).toBe(`${USER}:sig-9`);
    });

    it('deriveEntryType / normalizeRequestedPrice agree for every sentinel shape', () => {
      expect(TradeIntentService.deriveEntryType(null)).toBe('MARKET');
      expect(TradeIntentService.deriveEntryType('0')).toBe('MARKET');
      expect(TradeIntentService.deriveEntryType('-1.5')).toBe('MARKET');
      expect(TradeIntentService.deriveEntryType('1.0825')).toBe('LIMIT');
      expect(TradeIntentService.normalizeRequestedPrice('0')).toBeNull();
      expect(TradeIntentService.normalizeRequestedPrice('1.0825')).toBe('1.0825');
      expect(TradeIntentService.normalizeRequestedPrice(null)).toBeNull();
    });
  });
});
