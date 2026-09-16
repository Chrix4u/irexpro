import { DataSource, Repository } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RiskService } from './risk.service';
import { RiskProfile } from './entities/risk-profile.entity';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { RiskGrant } from '../execution/entities/risk-grant.entity';
import { ExecutionConfirmation } from '../execution/entities/execution-confirmation.entity';
import {
  AuthoritativeOrderPayload,
  ExecutionConfirmationStatus,
  ExecutionMode,
  RiskGrantStatus,
} from '../execution/interfaces/execution-authority';
import { ExecutionSessionResolutionService } from '../execution/execution-session.resolution';
import {
  RiskGrantService,
  RISK_GRANT_TTL_MS,
  EXECUTION_CONFIRMATION_WINDOW_MS,
  PendingConfirmationRebindError,
} from './risk-grant.service';
import { RiskOrderGeometryService } from './risk-order-geometry.service';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import { TradingAuthorityGeneration } from '../users/entities/trading-authority-generation.entity';
import { ExactDecimal } from '../../common/utils/exact-decimal';
import { ProposedTrade, RiskRejectionCode } from './interfaces/risk.interface';
import { DomainEventBus } from '../events/event-bus.service';
import { AllowedTradingMode } from './entities/risk-profile.entity';

/**
 * RiskGrant issuance + lifecycle + exact-decimal risk boundaries (Sprint 56
 * correction round 5, task 50-b — architect issues #296/#301/#313/#316/#317/#330).
 *
 * REAL sqlite store with REAL TypeORM repositories: the RiskGrantService and
 * RiskService code under test is the REAL production code. The authority
 * entities declare PostgreSQL-native column types (enum/timestamptz/jsonb)
 * the sqlite driver refuses to register, so this harness mirrors the three
 * authority tables 1:1 (same table/column names, sqlite-compatible types) and
 * casts the repositories to the production entity types — the exact pattern
 * of execution-session.authority.spec.ts. The partial unique indexes are the
 * EXACT production DDL from migration 1754000000000 (sqlite supports partial
 * indexes).
 *
 * Matrix:
 *   - issuance binds ALL authority fields (digests, binding, TTL, status)
 *   - missing authority binding → typed AUTHORITY_BINDING_REQUIRED (no grant)
 *   - SEMI_AUTO creates the PENDING confirmation (grant expiry + window);
 *     PAPER_ONLY/FULL_AUTO create none
 *   - idempotent re-issuance (same digests → same grantId, one row)
 *   - different digests → stale grant CAS-invalidated + fresh issued
 *   - TTL: expiresAt == issuedAt + RISK_GRANT_TTL_MS; expired → not consumable
 *   - invalidateGrantsForSession CAS: only still-ACTIVE rows flip
 *   - consumeGrantAtomic single-winner: 10 concurrent consumers → exactly one
 *   - EXACT boundaries: daily-loss equality (opening-balance baseline),
 *     drawdown vs monotonic peak (incl. the persisted CAS write), margin
 *     equality passes, maxTradeRiskPercent equality, maxLeverageAllowed
 *     equality
 *   - LOW_LIQUIDITY rejection; malformed balance fail-closed;
 *     query-failure → RISK_ENGINE_QUERY_FAILED (never SKIPPED)
 */

// ─── sqlite mirror entities (1:1 with the production authority tables) ───────

@Entity({ name: 'trading_sessions' })
class TradingSessionMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'broker_connection_id', type: 'varchar' })
  brokerConnectionId: string;
  @Column({
    name: 'execution_mode',
    type: 'varchar',
    length: 20,
    default: ExecutionMode.PAPER_ONLY,
  })
  executionMode: ExecutionMode;
  @Column({ name: 'authority_generation', type: 'integer', default: 1 })
  authorityGeneration: number;
  @Column({
    name: 'status',
    type: 'simple-enum',
    enum: TradingSessionStatus,
    default: TradingSessionStatus.ACTIVE,
  })
  status: TradingSessionStatus;
  @Column({ name: 'opening_balance', type: 'numeric', precision: 15, scale: 2, nullable: true })
  openingBalance: string | null;
  @Column({ name: 'peak_equity', type: 'numeric', precision: 15, scale: 2, nullable: true })
  peakEquity: string | null;
  @Column({ name: 'risk_profile_snapshot', type: 'simple-json', nullable: true })
  riskProfileSnapshot: Record<string, unknown> | null;
  @Column({ name: 'started_at', type: 'datetime', nullable: true })
  startedAt: Date;
  @Column({ name: 'ended_at', type: 'datetime', nullable: true })
  endedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

@Entity({ name: 'risk_grants' })
class RiskGrantMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'signal_id', type: 'varchar', length: 100 })
  signalId: string;
  @Column({ name: 'signal_payload_digest', type: 'varchar', length: 64 })
  signalPayloadDigest: string;
  @Column({ name: 'session_id', type: 'varchar' })
  sessionId: string;
  @Column({ name: 'session_generation', type: 'integer' })
  sessionGeneration: number;
  @Column({ name: 'execution_mode', type: 'varchar', length: 20 })
  executionMode: ExecutionMode;
  @Column({ name: 'broker_connection_id', type: 'varchar' })
  brokerConnectionId: string;
  @Column({ name: 'provider_broker_identity', type: 'varchar', length: 100, nullable: true })
  providerBrokerIdentity: string | null;
  @Column({
    name: 'provider_verification_fingerprint',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  providerVerificationFingerprint: string | null;
  @Column({ name: 'risk_profile_id', type: 'varchar', nullable: true })
  riskProfileId: string | null;
  @Column({ name: 'risk_profile_version', type: 'integer', nullable: true })
  riskProfileVersion: number | null;
  @Column({ name: 'risk_profile_hash', type: 'varchar', length: 64, nullable: true })
  riskProfileHash: string | null;
  @Column({ name: 'account_snapshot_id', type: 'varchar', nullable: true })
  accountSnapshotId: string | null;
  @Column({ name: 'account_snapshot_generation', type: 'integer', nullable: true })
  accountSnapshotGeneration: number | null;
  @Column({ name: 'account_snapshot_observed_at', type: 'datetime', nullable: true })
  accountSnapshotObservedAt: Date | null;
  @Column({ name: 'authority_generation', type: 'integer' })
  authorityGeneration: number;
  @Column({ name: 'kill_switch_generation', type: 'integer', nullable: true })
  killSwitchGeneration: number | null;
  @Column({ name: 'execution_control_revision', type: 'integer', nullable: true })
  executionControlRevision: number | null;
  // Round 6 (#301/#363): canonical authority binding digest + shared
  // control-plane revisions (mirror of the production risk_grants columns).
  @Column({ name: 'authority_binding_digest', type: 'varchar', length: 64, nullable: true })
  authorityBindingDigest: string | null;
  @Column({ name: 'trading_policy_revision', type: 'integer', nullable: true })
  tradingPolicyRevision: number | null;
  @Column({ name: 'provider_verification_revision', type: 'integer', nullable: true })
  providerVerificationRevision: number | null;
  @Column({ name: 'credential_generation', type: 'integer', nullable: true })
  credentialGeneration: number | null;
  @Column({ name: 'order_payload_digest', type: 'varchar', length: 64 })
  orderPayloadDigest: string;
  @Column({ name: 'order_payload', type: 'simple-json' })
  orderPayload: AuthoritativeOrderPayload;
  @Column({ name: 'quote_ref', type: 'simple-json', nullable: true })
  quoteRef: Record<string, unknown> | null;
  @Column({ name: 'issued_at', type: 'datetime' })
  issuedAt: Date;
  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;
  @Column({ name: 'consumed_at', type: 'datetime', nullable: true })
  consumedAt: Date | null;
  @Column({ name: 'invalidated_at', type: 'datetime', nullable: true })
  invalidatedAt: Date | null;
  @Column({ name: 'invalidation_reason', type: 'varchar', length: 200, nullable: true })
  invalidationReason: string | null;
  @Column({ name: 'status', type: 'varchar', length: 30, default: RiskGrantStatus.ACTIVE })
  status: RiskGrantStatus;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

@Entity({ name: 'execution_confirmations' })
class ExecutionConfirmationMirror {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'user_id', type: 'varchar' })
  userId: string;
  @Column({ name: 'session_id', type: 'varchar' })
  sessionId: string;
  @Column({ name: 'session_generation', type: 'integer' })
  sessionGeneration: number;
  @Column({ name: 'signal_id', type: 'varchar', length: 100 })
  signalId: string;
  @Column({ name: 'broker_connection_id', type: 'varchar' })
  brokerConnectionId: string;
  @Column({ name: 'risk_grant_id', type: 'varchar', nullable: true })
  riskGrantId: string | null;
  @Column({ name: 'order_payload_digest', type: 'varchar', length: 64 })
  orderPayloadDigest: string;
  @Column({ name: 'instrument', type: 'varchar', length: 50 })
  instrument: string;
  @Column({ name: 'direction', type: 'varchar', length: 10 })
  direction: string;
  @Column({ name: 'quantity', type: 'numeric', precision: 18, scale: 8 })
  quantity: string;
  @Column({ name: 'stop_loss', type: 'numeric', precision: 18, scale: 8, nullable: true })
  stopLoss: string | null;
  @Column({ name: 'take_profit', type: 'numeric', precision: 18, scale: 8, nullable: true })
  takeProfit: string | null;
  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;
  @Column({ name: 'consumed_at', type: 'datetime', nullable: true })
  consumedAt: Date | null;
  @Column({ name: 'revoked_at', type: 'datetime', nullable: true })
  revokedAt: Date | null;
  @Column({
    name: 'status',
    type: 'varchar',
    length: 30,
    default: ExecutionConfirmationStatus.PENDING,
  })
  status: ExecutionConfirmationStatus;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const CONN = '33333333-3333-4333-8333-333333333333';

const profileRow = (): RiskProfile =>
  ({
    id: 'profile-1',
    userId: USER,
    killSwitchActive: false,
    killSwitchReason: null,
    maxDailyLossPercent: '5.00',
    maxDrawdownPercent: '10.00',
    maxOpenTrades: 3,
    maxDailyTrades: 10,
    maxPositionSizeLot: '0.10',
    minStopLossPips: '5.00',
    allowedInstruments: null,
    maxVolatilityScore: '0.85',
    rejectLowLiquidity: true,
    riskAcknowledgementAccepted: true,
    riskAcknowledgementAcceptedAt: new Date(),
    maxTradeRiskPercent: '2.00',
    maxLeverageAllowed: 30,
    allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as RiskProfile;

const trade = (overrides: Partial<ProposedTrade> = {}): ProposedTrade => ({
  signalId: 'sig-grant-001',
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedLotSize: '0.05',
  entryPrice: '1.08500',
  stopLoss: '1.07500',
  takeProfit: '1.09500',
  idempotencyKey: `${USER}:sig-grant-001`,
  volatilityScore: 0.4,
  regime: 'TRENDING',
  sessionId: 'session-1',
  sessionGeneration: 1,
  executionMode: ExecutionMode.PAPER_ONLY,
  brokerConnectionId: CONN,
  generatedAt: new Date(),
  ...overrides,
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('RiskGrant issuance + exact-decimal boundaries (Round 5, 50-b)', () => {
  let dataSource: DataSource;
  let sessionRepo: Repository<TradingSessionMirror>;
  let grantRepo: Repository<RiskGrantMirror>;
  let confirmationRepo: Repository<ExecutionConfirmationMirror>;
  let riskGrantService: RiskGrantService;
  let riskService: RiskService;
  let brokerService: {
    findConnectionById: jest.Mock;
    isConnectionExecutable: jest.Mock;
    getBrokerAccountState: jest.Mock;
    getRequiredMargin: jest.Mock;
  };
  let executionService: {
    countOpenTrades: jest.Mock;
    countTodayTrades: jest.Mock;
    getTodayRealisedLoss: jest.Mock;
    findTradeBySignalId: jest.Mock;
  };
  let profileRepoMock: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let authorityGenerationRepoMock: { findOne: jest.Mock };
  let geometryMock: { resolveOrderGeometry: jest.Mock };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [TradingSessionMirror, RiskGrantMirror, ExecutionConfirmationMirror],
    });
    await dataSource.initialize();

    // EXACT production partial uniques (migration 1754000000000).
    await dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_grants_one_active_per_signal
       ON risk_grants (signal_id) WHERE status = 'ACTIVE'`,
    );
    await dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_confirmations_one_pending_per_signal
       ON execution_confirmations (signal_id) WHERE status = 'PENDING'`,
    );

    sessionRepo = dataSource.getRepository(TradingSessionMirror);
    grantRepo = dataSource.getRepository(RiskGrantMirror);
    confirmationRepo = dataSource.getRepository(ExecutionConfirmationMirror);

    const auditService = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const eventBus = { publish: jest.fn() } as unknown as DomainEventBus;

    riskGrantService = new RiskGrantService(
      grantRepo as unknown as Repository<RiskGrant>,
      confirmationRepo as unknown as Repository<ExecutionConfirmation>,
      auditService,
      // Round 7 (P1 metrics): the lazy MetricsService ModuleRef seam — the
      // stub's get() returns undefined, so every metrics call site no-ops.
      { get: jest.fn() } as unknown as ModuleRef,
    );

    brokerService = {
      findConnectionById: jest.fn().mockResolvedValue({
        id: CONN,
        userId: USER,
        brokerId: 'metatrader5',
        accountType: 'DEMO',
        status: 'CONNECTED',
        authorizationStatus: 'ACTIVE',
        providerBrokerIdentity: 'MetaQuotes-Demo',
        credentialGeneration: 3,
      }),
      isConnectionExecutable: jest.fn().mockReturnValue(true),
      getBrokerAccountState: jest.fn().mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '9800.00',
        currency: 'USD',
      }),
      getRequiredMargin: jest.fn().mockResolvedValue('100.00'),
    };
    executionService = {
      countOpenTrades: jest.fn().mockResolvedValue(0),
      countTodayTrades: jest.fn().mockResolvedValue(0),
      getTodayRealisedLoss: jest.fn().mockResolvedValue(0),
      findTradeBySignalId: jest.fn().mockResolvedValue(null),
    };
    profileRepoMock = {
      findOne: jest.fn().mockResolvedValue(profileRow()),
      create: jest.fn().mockImplementation((obj) => ({ ...profileRow(), ...obj })),
      save: jest.fn().mockImplementation(async (obj) => obj),
    };
    authorityGenerationRepoMock = { findOne: jest.fn().mockResolvedValue(null) };
    geometryMock = {
      resolveOrderGeometry: jest.fn().mockResolvedValue({
        contractSize: ExactDecimal.parse('100000'),
        freshQuote: null,
        quoteRef: null,
      }),
    };

    const sessionResolution = new ExecutionSessionResolutionService(
      sessionRepo as unknown as Repository<TradingSession>,
    );

    riskService = new RiskService(
      profileRepoMock as unknown as Repository<RiskProfile>,
      { create: jest.fn(), save: jest.fn().mockResolvedValue({}) } as never,
      sessionRepo as unknown as Repository<TradingSession>,
      authorityGenerationRepoMock as unknown as Repository<TradingAuthorityGeneration>,
      brokerService as unknown as BrokerService,
      auditService,
      executionService as unknown as ExecutionService,
      {
        checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true }),
      } as unknown as ExecutionControlService,
      eventBus,
      sessionResolution,
      riskGrantService,
      geometryMock as unknown as RiskOrderGeometryService,
      // Round 6: unified execution-authority service seams (mocks — this
      // suite exercises the RiskGrantService contract, not issuance).
      { getCurrentGeneration: jest.fn().mockResolvedValue(1) } as never,
      {
        getCurrentTradingPolicyRevision: jest.fn(),
        getCurrentProviderVerificationRevision: jest.fn(),
        getCurrentExecutionControlRevision: jest.fn(),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM execution_confirmations');
    await dataSource.query('DELETE FROM risk_grants');
    await dataSource.query('DELETE FROM trading_sessions');
    jest.clearAllMocks();

    // Default ACTIVE session: opening balance + seeded peak equity.
    await sessionRepo.save(
      sessionRepo.create({
        id: 'session-1',
        userId: USER,
        brokerConnectionId: CONN,
        executionMode: ExecutionMode.PAPER_ONLY,
        authorityGeneration: 1,
        status: TradingSessionStatus.ACTIVE,
        openingBalance: '10000.00',
        peakEquity: '10000.00',
        startedAt: new Date(),
      }),
    );
    brokerService.getBrokerAccountState.mockResolvedValue({
      balance: '10000.00',
      equity: '10050.00',
      freeMargin: '9800.00',
      currency: 'USD',
    });
    brokerService.getRequiredMargin.mockResolvedValue('100.00');
    executionService.getTodayRealisedLoss.mockResolvedValue(0);
    executionService.countOpenTrades.mockResolvedValue(0);
    executionService.countTodayTrades.mockResolvedValue(0);
    executionService.findTradeBySignalId.mockResolvedValue(null);
    profileRepoMock.findOne.mockResolvedValue(profileRow());
    geometryMock.resolveOrderGeometry.mockResolvedValue({
      contractSize: ExactDecimal.parse('100000'),
      freshQuote: null,
      quoteRef: null,
    });
  });

  const setSessionMode = async (mode: ExecutionMode) => {
    await sessionRepo.update({ id: 'session-1' } as never, { executionMode: mode } as never);
  };

  /** Re-seed the persisted peak equity (drawdown baseline) for a test. */
  const setSessionPeak = async (peak: string) => {
    await sessionRepo.update({ id: 'session-1' } as never, { peakEquity: peak } as never);
  };

  const countGrants = async (): Promise<number> => {
    const rows = await dataSource.query('SELECT COUNT(*) AS n FROM risk_grants');
    return Number(rows[0].n);
  };

  // ─── Grant issuance binds ALL authority fields (#301) ────────────────────

  describe('issuance', () => {
    it('APPROVES and persists a RiskGrant binding every authority field', async () => {
      const decision = await riskService.validateProposedTrade(USER, trade());

      expect(decision.decision).toBe('APPROVED');
      if (decision.decision !== 'APPROVED') return;

      const grant = await grantRepo.findOne({ where: { id: decision.grantId! } });
      expect(grant).not.toBeNull();
      expect(grant).toMatchObject({
        userId: USER,
        signalId: 'sig-grant-001',
        sessionId: 'session-1',
        sessionGeneration: 1,
        executionMode: ExecutionMode.PAPER_ONLY,
        brokerConnectionId: CONN,
        // Read-only from the EXACT session-bound connection:
        providerBrokerIdentity: 'MetaQuotes-Demo',
        credentialGeneration: 3,
        // Profile binding (no version column → hash + id):
        riskProfileId: 'profile-1',
        riskProfileVersion: null,
        // User trading-authority generation (absent row → 1):
        authorityGeneration: 1,
        killSwitchGeneration: null,
        executionControlRevision: null,
        status: RiskGrantStatus.ACTIVE,
      });
      expect(grant!.signalPayloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(grant!.orderPayloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(grant!.riskProfileHash).toMatch(/^[0-9a-f]{64}$/);
      expect(grant!.orderPayload).toMatchObject({
        instrument: 'EURUSD',
        direction: 'BUY',
        quantity: '0.05',
        orderType: 'MARKET',
        requestedPrice: '1.085',
        stopLoss: '1.075',
        takeProfit: '1.095',
        marketRegime: 'TRENDING',
      });
      // TTL: expiresAt = issuedAt + RISK_GRANT_TTL_MS (60s).
      expect(grant!.expiresAt.getTime() - grant!.issuedAt.getTime()).toBe(RISK_GRANT_TTL_MS);

      // The approval carries the authority binding:
      expect(decision.sessionId).toBe('session-1');
      expect(decision.sessionGeneration).toBe(1);
      expect(decision.executionMode).toBe(ExecutionMode.PAPER_ONLY);
      expect(decision.brokerConnectionId).toBe(CONN);

      // PAPER_ONLY: NO confirmation row is created.
      const confirmations = await confirmationRepo.find();
      expect(confirmations).toHaveLength(0);
    });

    it('missing authority binding → typed AUTHORITY_BINDING_REQUIRED, no grant row', async () => {
      const { sessionId: _s, ...unbound } = trade();
      void _s;

      const decision = await riskService.validateProposedTrade(USER, unbound);

      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.AUTHORITY_BINDING_REQUIRED);
      }
      expect(await countGrants()).toBe(0);
    });

    it('stale binding → typed SESSION_AUTHORITY_MISMATCH, no grant row', async () => {
      const decision = await riskService.validateProposedTrade(
        USER,
        trade({ sessionGeneration: 2 }),
      );

      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.SESSION_AUTHORITY_MISMATCH);
      }
      expect(await countGrants()).toBe(0);
    });

    it('SEMI_AUTO creates the PENDING confirmation bound to the grant + exact order', async () => {
      await setSessionMode(ExecutionMode.SEMI_AUTO);

      const decision = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.SEMI_AUTO }),
      );
      expect(decision.decision).toBe('APPROVED');
      if (decision.decision !== 'APPROVED') return;

      const confirmations = await confirmationRepo.find();
      expect(confirmations).toHaveLength(1);
      const confirmation = confirmations[0]!;
      expect(confirmation).toMatchObject({
        userId: USER,
        sessionId: 'session-1',
        sessionGeneration: 1,
        signalId: 'sig-grant-001',
        brokerConnectionId: CONN,
        riskGrantId: decision.grantId,
        instrument: 'EURUSD',
        direction: 'BUY',
        status: ExecutionConfirmationStatus.PENDING,
        consumedAt: null,
        revokedAt: null,
      });
      // quantity/SL/TP persist the exact validated order values.
      expect(Number(confirmation.quantity)).toBeCloseTo(0.05, 8);
      expect(Number(confirmation.stopLoss)).toBeCloseTo(1.075, 8);
      expect(Number(confirmation.takeProfit)).toBeCloseTo(1.095, 8);

      const grant = await grantRepo.findOne({ where: { id: decision.grantId! } });
      // Expiry = grant expiry + the confirmation window (300s by design —
      // the confirmation outlives the grant so the UI flow never races it).
      expect(confirmation.orderPayloadDigest).toBe(grant!.orderPayloadDigest);
      expect(confirmation.expiresAt.getTime() - grant!.expiresAt.getTime()).toBe(
        EXECUTION_CONFIRMATION_WINDOW_MS,
      );
    });

    it('FULL_AUTO creates NO confirmation row', async () => {
      await setSessionMode(ExecutionMode.FULL_AUTO);

      const decision = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.FULL_AUTO }),
      );
      expect(decision.decision).toBe('APPROVED');
      expect(await confirmationRepo.count()).toBe(0);
    });

    it('idempotent re-issuance with the SAME digests reuses the existing grant', async () => {
      const first = await riskService.validateProposedTrade(USER, trade());
      const second = await riskService.validateProposedTrade(USER, trade());

      expect(first.decision).toBe('APPROVED');
      expect(second.decision).toBe('APPROVED');
      if (first.decision !== 'APPROVED' || second.decision !== 'APPROVED') return;
      expect(second.grantId).toBe(first.grantId);
      // Exactly ONE grant row — the one-ACTIVE-per-signal invariant.
      expect(await countGrants()).toBe(1);
    });

    it('re-issuance with DIFFERENT digests invalidates the stale grant and issues fresh', async () => {
      const first = await riskService.validateProposedTrade(USER, trade());
      const second = await riskService.validateProposedTrade(
        USER,
        trade({ signalId: 'sig-grant-001', requestedLotSize: '0.06' }),
      );

      expect(first.decision).toBe('APPROVED');
      expect(second.decision).toBe('APPROVED');
      if (first.decision !== 'APPROVED' || second.decision !== 'APPROVED') return;
      expect(second.grantId).not.toBe(first.grantId);

      const stale = await grantRepo.findOne({ where: { id: first.grantId! } });
      expect(stale!.status).toBe(RiskGrantStatus.INVALIDATED);
      expect(stale!.invalidationReason).toBe('SUPERSEDED_BY_REVALIDATION');
      expect(stale!.invalidatedAt).not.toBeNull();

      const fresh = await grantRepo.findOne({ where: { id: second.grantId! } });
      expect(fresh!.status).toBe(RiskGrantStatus.ACTIVE);
      expect(await countGrants()).toBe(2);
    });
  });

  // ─── Round 7 (P0 fix): the SEMI_AUTO confirm-path grant re-bind ────────

  describe('SEMI_AUTO confirm-path re-bind (Round 7 P0 fix)', () => {
    it('the fresh §18 evaluation RE-BINDS the in-flight PENDING confirmation to the fresh grant instead of revoking it', async () => {
      await setSessionMode(ExecutionMode.SEMI_AUTO);

      // Original approval → G1 + C1 (PENDING, bound to G1).
      const first = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.SEMI_AUTO }),
      );
      expect(first.decision).toBe('APPROVED');
      if (first.decision !== 'APPROVED') return;
      const confirmations = await confirmationRepo.find();
      expect(confirmations).toHaveLength(1);
      const c1 = confirmations[0]!;
      expect(c1.riskGrantId).toBe(first.grantId);

      // The user CONFIRMS → fresh evaluation (fresh quote ⇒ different binding
      // digest ⇒ supersession) with rebindConfirmationId = C1.
      const confirmed = await riskService.validateProposedTrade(
        USER,
        trade({
          executionMode: ExecutionMode.SEMI_AUTO,
          requestedLotSize: '0.06',
        }),
        { rebindConfirmationId: c1.id },
      );
      expect(confirmed.decision).toBe('APPROVED');
      if (confirmed.decision !== 'APPROVED') return;
      expect(confirmed.grantId).not.toBe(first.grantId);

      // G1 superseded with the confirm-path reason.
      const stale = await grantRepo.findOne({ where: { id: first.grantId! } });
      expect(stale!.status).toBe(RiskGrantStatus.INVALIDATED);
      expect(stale!.invalidationReason).toBe('SUPERSEDED_BY_CONFIRMATION_RE_EVALUATION');

      // C1 SURVIVED as PENDING and is RE-BOUND to the fresh grant — the
      // commitment CAS (risk_grant_id = fresh grant + PENDING + unexpired)
      // is winnable. This is the exact regression the P0 fix closes.
      const reloaded = await confirmationRepo.findOne({ where: { id: c1.id } });
      expect(reloaded!.status).toBe(ExecutionConfirmationStatus.PENDING);
      expect(reloaded!.riskGrantId).toBe(confirmed.grantId);
      expect(reloaded!.revokedAt).toBeNull();

      // EXACTLY ONE confirmation exists (no second row was created).
      expect(await confirmationRepo.count()).toBe(1);

      // The fresh grant is consumable AND the confirmation CAS precondition
      // holds — simulate the commitment's two CAS legs.
      const consume = await riskGrantService.consumeGrantAtomic(confirmed.grantId!, USER);
      expect(consume.consumed).toBe(true);
      await confirmationRepo.update(
        { id: c1.id } as never,
        { status: ExecutionConfirmationStatus.CONSUMED, consumedAt: new Date() } as never,
      );
      const after = await confirmationRepo.findOne({ where: { id: c1.id } });
      expect(after!.status).toBe(ExecutionConfirmationStatus.CONSUMED);
    });

    it('the re-bind works when the ORIGINAL grant already expired (>60s confirm window) — the fresh grant re-anchors the CAS', async () => {
      await setSessionMode(ExecutionMode.SEMI_AUTO);

      const first = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.SEMI_AUTO }),
      );
      expect(first.decision).toBe('APPROVED');
      if (first.decision !== 'APPROVED') return;
      const c1 = (await confirmationRepo.find())[0]!;

      // Time-travel: the original grant's TTL has passed (the row stays ACTIVE
      // until superseded — exactly the production lazy-expiry shape).
      await grantRepo.update(
        { id: first.grantId! } as never,
        { expiresAt: new Date(Date.now() - 1_000) } as never,
      );

      const confirmed = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.SEMI_AUTO, requestedLotSize: '0.06' }),
        { rebindConfirmationId: c1.id },
      );
      expect(confirmed.decision).toBe('APPROVED');
      if (confirmed.decision !== 'APPROVED') return;

      const reloaded = await confirmationRepo.findOne({ where: { id: c1.id } });
      expect(reloaded!.status).toBe(ExecutionConfirmationStatus.PENDING);
      expect(reloaded!.riskGrantId).toBe(confirmed.grantId);

      // The FRESH grant is unexpired + consumable (the old one never was again).
      const consume = await riskGrantService.consumeGrantAtomic(confirmed.grantId!, USER);
      expect(consume.consumed).toBe(true);
      const staleConsume = await riskGrantService.consumeGrantAtomic(first.grantId!, USER);
      expect(staleConsume.consumed).toBe(false);
    });

    it('a NON-PENDING confirmation (revoked concurrently) fails the re-bind CLOSED — typed error, no dispatchable approval', async () => {
      await setSessionMode(ExecutionMode.SEMI_AUTO);

      const first = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.SEMI_AUTO }),
      );
      expect(first.decision).toBe('APPROVED');
      if (first.decision !== 'APPROVED') return;
      const c1 = (await confirmationRepo.find())[0]!;

      // A concurrent actor revoked the confirmation BEFORE the user's confirm
      // landed (session end, authority change…).
      await confirmationRepo.update(
        { id: c1.id } as never,
        {
          status: ExecutionConfirmationStatus.REVOKED,
          revokedAt: new Date(),
        } as never,
      );

      // The fresh evaluation with the re-bind option must NOT approve: the
      // fail-closed wrapper converts the typed rebind error into a REJECTED
      // decision (zero provider calls).
      const decision = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.SEMI_AUTO, requestedLotSize: '0.06' }),
        { rebindConfirmationId: c1.id },
      );
      expect(decision.decision).not.toBe('APPROVED');

      // The revoked confirmation was NOT resurrected.
      const reloaded = await confirmationRepo.findOne({ where: { id: c1.id } });
      expect(reloaded!.status).toBe(ExecutionConfirmationStatus.REVOKED);
    });

    it('a supersession WITHOUT the confirm-path option keeps the Round-6 revoke semantics (regression guard)', async () => {
      await setSessionMode(ExecutionMode.SEMI_AUTO);

      const first = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.SEMI_AUTO }),
      );
      expect(first.decision).toBe('APPROVED');
      if (first.decision !== 'APPROVED') return;
      const c1 = (await confirmationRepo.find())[0]!;

      // A NON-confirm re-validation (e.g. orchestrator retry): the stale
      // confirmation is revoked and a fresh one is created on the new grant.
      const second = await riskService.validateProposedTrade(
        USER,
        trade({ executionMode: ExecutionMode.SEMI_AUTO, requestedLotSize: '0.06' }),
      );
      expect(second.decision).toBe('APPROVED');
      if (second.decision !== 'APPROVED') return;

      const reloaded = await confirmationRepo.findOne({ where: { id: c1.id } });
      expect(reloaded!.status).toBe(ExecutionConfirmationStatus.REVOKED);
      expect(await confirmationRepo.count()).toBe(2);
      const fresh = (await confirmationRepo.find()).find((c) => c.id !== c1.id)!;
      expect(fresh.status).toBe(ExecutionConfirmationStatus.PENDING);
      expect(fresh.riskGrantId).toBe(second.grantId);
    });

    it('PendingConfirmationRebindError carries the typed shape', () => {
      const err = new PendingConfirmationRebindError('conf-1', 'sig-1', 'detail');
      expect(err.name).toBe('PendingConfirmationRebindError');
      expect(err.confirmationId).toBe('conf-1');
      expect(err.signalId).toBe('sig-1');
      expect(err.message).toContain('conf-1');
    });
  });

  // ─── Grant lifecycle CAS (#301) ───────────────────────────────────────────

  describe('lifecycle', () => {
    const seedGrant = async (
      overrides: Partial<RiskGrantMirror> = {},
    ): Promise<RiskGrantMirror> => {
      const grant = grantRepo.create({
        userId: USER,
        signalId: `sig-${Math.random().toString(36).slice(2, 10)}`,
        signalPayloadDigest: 'a'.repeat(64),
        sessionId: 'session-1',
        sessionGeneration: 1,
        executionMode: ExecutionMode.PAPER_ONLY,
        brokerConnectionId: CONN,
        authorityGeneration: 1,
        orderPayloadDigest: 'b'.repeat(64),
        orderPayload: {
          instrument: 'EURUSD',
          direction: 'BUY',
          quantity: '0.05',
          orderType: 'MARKET',
        },
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        status: RiskGrantStatus.ACTIVE,
        ...overrides,
      });
      return grantRepo.save(grant);
    };

    it('consumeGrantAtomic: single winner among 10 concurrent consumers', async () => {
      const grant = await seedGrant();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => riskGrantService.consumeGrantAtomic(grant.id)),
      );

      const winners = results.filter((r) => r.consumed);
      expect(winners).toHaveLength(1);
      // Every loser is TYPED — never a guessed status.
      for (const loser of results.filter((r) => !r.consumed)) {
        expect(loser.reason).toBeDefined();
      }
      const reloaded = await grantRepo.findOne({ where: { id: grant.id } });
      expect(reloaded!.status).toBe(RiskGrantStatus.CONSUMED);
      expect(reloaded!.consumedAt).not.toBeNull();
    });

    it('consumeGrantAtomic: an EXPIRED (past TTL) grant is not consumable', async () => {
      const grant = await seedGrant({
        issuedAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000), // TTL elapsed
      });

      const result = await riskGrantService.consumeGrantAtomic(grant.id);
      expect(result.consumed).toBe(false);
      expect(result.reason).toBe('EXPIRED');
      const reloaded = await grantRepo.findOne({ where: { id: grant.id } });
      expect(reloaded!.status).toBe(RiskGrantStatus.ACTIVE); // never silently flipped
    });

    it('consumeGrantAtomic: an UNKNOWN grant is NOT_FOUND', async () => {
      const result = await riskGrantService.consumeGrantAtomic(
        '00000000-0000-0000-0000-000000000000',
      );
      expect(result.consumed).toBe(false);
      expect(result.reason).toBe('NOT_FOUND');
    });

    it('invalidateGrantsForSession CAS: only still-ACTIVE rows flip; terminal rows untouched', async () => {
      const active = await seedGrant();
      const consumed = await seedGrant({
        status: RiskGrantStatus.CONSUMED,
        consumedAt: new Date(),
      });
      const invalidated = await seedGrant({ status: RiskGrantStatus.INVALIDATED });

      const affected = await riskGrantService.invalidateGrantsForSession(
        'session-1',
        'SESSION_AUTHORITY_GENERATION_CHANGED',
      );

      expect(affected).toBe(1);
      const reloadedActive = await grantRepo.findOne({ where: { id: active.id } });
      expect(reloadedActive!.status).toBe(RiskGrantStatus.INVALIDATED);
      expect(reloadedActive!.invalidationReason).toBe('SESSION_AUTHORITY_GENERATION_CHANGED');
      const reloadedConsumed = await grantRepo.findOne({ where: { id: consumed.id } });
      expect(reloadedConsumed!.status).toBe(RiskGrantStatus.CONSUMED);
      const reloadedInvalidated = await grantRepo.findOne({ where: { id: invalidated.id } });
      expect(reloadedInvalidated!.invalidationReason).toBeNull(); // untouched
    });

    it('revokeConfirmationsForSession revokes only PENDING rows', async () => {
      await confirmationRepo.save([
        confirmationRepo.create({
          userId: USER,
          sessionId: 'session-1',
          sessionGeneration: 1,
          signalId: 'sig-c1',
          brokerConnectionId: CONN,
          orderPayloadDigest: 'b'.repeat(64),
          instrument: 'EURUSD',
          direction: 'BUY',
          quantity: '0.05',
          expiresAt: new Date(Date.now() + 60_000),
          status: ExecutionConfirmationStatus.PENDING,
        }),
        confirmationRepo.create({
          userId: USER,
          sessionId: 'session-1',
          sessionGeneration: 1,
          signalId: 'sig-c2',
          brokerConnectionId: CONN,
          orderPayloadDigest: 'b'.repeat(64),
          instrument: 'EURUSD',
          direction: 'BUY',
          quantity: '0.05',
          expiresAt: new Date(Date.now() + 60_000),
          status: ExecutionConfirmationStatus.CONSUMED,
          consumedAt: new Date(),
        }),
      ]);

      const revoked = await riskGrantService.revokeConfirmationsForSession('session-1');
      expect(revoked).toBe(1);
      const pending = await confirmationRepo.findOne({ where: { signalId: 'sig-c1' } });
      expect(pending!.status).toBe(ExecutionConfirmationStatus.REVOKED);
      expect(pending!.revokedAt).not.toBeNull();
      const consumedRow = await confirmationRepo.findOne({ where: { signalId: 'sig-c2' } });
      expect(consumedRow!.status).toBe(ExecutionConfirmationStatus.CONSUMED);
    });

    // ─── Round 7 (P1): the confirmation-expiry sweeper seam ──────────────

    it('expireStalePendingConfirmations expires ONLY window-passed PENDING rows (Round 7 expiry hygiene)', async () => {
      const seed = (
        signalId: string,
        expiresInMs: number,
        status = ExecutionConfirmationStatus.PENDING,
      ) =>
        confirmationRepo.create({
          userId: USER,
          sessionId: 'session-1',
          sessionGeneration: 1,
          signalId,
          brokerConnectionId: CONN,
          orderPayloadDigest: 'b'.repeat(64),
          instrument: 'EURUSD',
          direction: 'BUY',
          quantity: '0.05',
          expiresAt: new Date(Date.now() + expiresInMs),
          status,
        });
      await confirmationRepo.save([
        seed('sig-stale-pending', -1_000), // window passed, PENDING -> expires
        seed('sig-live-pending', 120_000), // window open, PENDING -> stays
        seed('sig-stale-consumed', -1_000, ExecutionConfirmationStatus.CONSUMED), // terminal -> stays
      ]);

      const expired = await riskGrantService.expireStalePendingConfirmations();
      expect(expired).toBe(1);
      const stale = await confirmationRepo.findOne({ where: { signalId: 'sig-stale-pending' } });
      expect(stale!.status).toBe(ExecutionConfirmationStatus.EXPIRED);
      const live = await confirmationRepo.findOne({ where: { signalId: 'sig-live-pending' } });
      expect(live!.status).toBe(ExecutionConfirmationStatus.PENDING);
      const consumed = await confirmationRepo.findOne({
        where: { signalId: 'sig-stale-consumed' },
      });
      expect(consumed!.status).toBe(ExecutionConfirmationStatus.CONSUMED);
    });
  });

  // ─── EXACT-decimal boundaries through the REAL pipeline ──────────────────

  describe('exact boundaries (#313/#317/#316/#330/#296)', () => {
    it('daily-loss EXACT equality against the SESSION opening balance → SUSPENDED', async () => {
      executionService.getTodayRealisedLoss.mockResolvedValue(-500); // 5% of 10000.00

      const decision = await riskService.validateProposedTrade(USER, trade());

      expect(decision.decision).toBe('SUSPENDED');
      if (decision.decision !== 'APPROVED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.DAILY_LOSS_LIMIT_REACHED);
        expect(decision.rejectionReason).toContain('opening balance');
      }
    });

    it('daily loss just below the exact boundary approves', async () => {
      executionService.getTodayRealisedLoss.mockResolvedValue(-499.99);

      const decision = await riskService.validateProposedTrade(USER, trade());
      expect(decision.decision).toBe('APPROVED');
    });

    it('drawdown EXACT equality against the monotonic peak → SUSPENDED', async () => {
      // Persisted peak 10000, fresh equity 9000 → 10.00% == maxDrawdownPercent.
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '9000.00',
        equity: '9000.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const decision = await riskService.validateProposedTrade(USER, trade());

      expect(decision.decision).toBe('SUSPENDED');
      if (decision.decision !== 'APPROVED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.MAX_DRAWDOWN_REACHED);
      }
    });

    it('a higher fresh equity updates the session peak MONOTONICALLY (persisted CAS write)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10500.00',
        equity: '10500.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      await riskService.validateProposedTrade(USER, trade());

      const session = await sessionRepo.findOne({ where: { id: 'session-1' } });
      expect(Number(session!.peakEquity)).toBe(10500);
    });

    it('margin EXACT equality PASSES (requiredMargin == freeMargin)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '10000.00',
        equity: '10050.00',
        freeMargin: '100.00',
        currency: 'USD',
      });
      brokerService.getRequiredMargin.mockResolvedValue('100.00');

      const decision = await riskService.validateProposedTrade(USER, trade());
      expect(decision.decision).toBe('APPROVED');
    });

    it('maxTradeRiskPercent EXACT equality rejects', async () => {
      // |1.085−1.075| × 0.05 × 100000 = 50 risk at stop; equity 2500 → 2.00%.
      await setSessionPeak('2500.00');
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '2500.00',
        equity: '2500.00',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const decision = await riskService.validateProposedTrade(USER, trade());

      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.MAX_TRADE_RISK_EXCEEDED);
        expect(decision.rejectionReason).toContain('2.00%');
      }
    });

    it('maxLeverageAllowed EXACT equality rejects (effective order leverage = notional/equity)', async () => {
      // notional = 1.085 × 0.05 × 100000 = 5425; equity 2712.50 → 2.0 exactly.
      await setSessionPeak('2712.50');
      profileRepoMock.findOne.mockResolvedValue({ ...profileRow(), maxLeverageAllowed: 2 });
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: '2712.50',
        equity: '2712.50',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const decision = await riskService.validateProposedTrade(USER, trade());

      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.LEVERAGE_EXCEEDED);
      }
    });

    it('LOW_LIQUIDITY regime rejects (rejectLowLiquidity enforced)', async () => {
      const decision = await riskService.validateProposedTrade(
        USER,
        trade({ regime: 'LOW_LIQUIDITY' }),
      );

      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.LOW_LIQUIDITY_REGIME);
      }
    });

    it('malformed balance/equity string fails CLOSED (typed, never approved)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue({
        balance: 'not-a-number',
        equity: 'garbage',
        freeMargin: '9800.00',
        currency: 'USD',
      });

      const decision = await riskService.validateProposedTrade(USER, trade());

      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.ACCOUNT_STATE_UNAVAILABLE);
      }
      expect(await countGrants()).toBe(0);
    });

    it('safety-query failure → RISK_ENGINE_QUERY_FAILED (never SKIPPED, sanitized)', async () => {
      executionService.getTodayRealisedLoss.mockRejectedValue(new Error('secret db dsn leaked'));

      const decision = await riskService.validateProposedTrade(USER, trade());

      expect(decision.decision).toBe('REJECTED');
      if (decision.decision === 'REJECTED') {
        expect(decision.rejectionCode).toBe(RiskRejectionCode.RISK_ENGINE_QUERY_FAILED);
        expect(decision.rejectionReason).not.toContain('secret db dsn leaked');
      }
      expect(await countGrants()).toBe(0);
    });
  });
});
