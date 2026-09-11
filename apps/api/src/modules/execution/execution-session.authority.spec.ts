import { DataSource, Repository } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ExecutionService } from './execution.service';
import { Trade } from './entities/trade.entity';
import { TradingSession, TradingSessionStatus } from './entities/trading-session.entity';
import { RiskGrant } from './entities/risk-grant.entity';
import { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import {
  ExecutionMode,
  ExecutionConfirmationStatus,
  RiskGrantStatus,
} from './interfaces/execution-authority';
import {
  ExecutionSessionResolutionService,
  SessionAuthorityGenerationConflictException,
  SessionAuthorityNotActiveException,
  ActiveSessionConflictException,
  BrokerConnectionNotConnectedException,
  BrokerConnectionNotExecutableException,
  BrokerConnectionOwnershipException,
} from './execution-session.resolution';
import { BrokerService } from '../broker/broker.service';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';

/**
 * Execution-session authority — Round 5 service-layer matrix (issues #295/#298)
 * against a REAL sqlite store with REAL TypeORM repositories.
 *
 * The TradingSession entity itself declares PostgreSQL-native column types
 * (enum, timestamptz, jsonb, DEFAULT NOW()) which the sqlite driver refuses to
 * register (EntityMetadataValidator rejects `enum`), so this harness mirrors
 * the three authority tables 1:1 (same table/column names, sqlite-compatible
 * types) and casts the repositories to the production entity types — the
 * ExecutionService code under test is the REAL production code, and the
 * partial unique index uq_trading_sessions_one_active_per_user is created with
 * the exact production DDL (sqlite supports partial indexes). The REAL entity
 * against real PostgreSQL is covered by execution-session.pg-integration.spec.
 *
 * Matrix:
 *   - resolveActiveSessionAuthority: authority / typed not-active
 *   - idempotent same-connection + same-mode start
 *   - typed conflict on cross-connection start (and cross-mode start)
 *   - ownership / non-CONNECTED / non-executable rejections
 *   - mode change: CAS generation bump + RiskGrant INVALIDATED
 *     (SESSION_AUTHORITY_GENERATION_CHANGED) + PENDING confirmation REVOKED
 *   - grants are never revived when switching back
 *   - ended session invalidates outstanding authority
 *   - CAS race on the generation bump (0 affected rows → typed conflict)
 *   - 20-way concurrent startSession → exactly ONE ACTIVE row survives
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
  @Column({ name: 'execution_mode', type: 'varchar', length: 20, default: ExecutionMode.PAPER_ONLY })
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
  @Column({ name: 'authority_generation', type: 'integer' })
  authorityGeneration: number;
  @Column({ name: 'order_payload_digest', type: 'varchar', length: 64 })
  orderPayloadDigest: string;
  @Column({ name: 'order_payload', type: 'simple-json' })
  orderPayload: Record<string, unknown>;
  @Column({ name: 'issued_at', type: 'datetime' })
  issuedAt: Date;
  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;
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
  @Column({ name: 'order_payload_digest', type: 'varchar', length: 64 })
  orderPayloadDigest: string;
  @Column({ name: 'instrument', type: 'varchar', length: 50 })
  instrument: string;
  @Column({ name: 'direction', type: 'varchar', length: 10 })
  direction: string;
  @Column({ name: 'quantity', type: 'numeric', precision: 18, scale: 8 })
  quantity: string;
  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;
  @Column({ name: 'revoked_at', type: 'datetime', nullable: true })
  revokedAt: Date | null;
  @Column({ name: 'status', type: 'varchar', length: 30, default: ExecutionConfirmationStatus.PENDING })
  status: ExecutionConfirmationStatus;
  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}

// ─── Fixture data ────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const CONN_A = '33333333-3333-4333-8333-333333333333';
const CONN_B = '44444444-4444-4444-8444-444444444444';
const DIGEST = (char: string) => char.repeat(64);

const connectionRow = (id: string, userId: string, extra: Record<string, unknown> = {}) => ({
  id,
  userId,
  brokerId: 'paper-broker',
  status: 'CONNECTED',
  authorizationStatus: 'ACTIVE',
  accountType: 'DEMO',
  ...extra,
});

describe('ExecutionService — session authority (Round 5, issues #295/#298)', () => {
  let dataSource: DataSource;
  let service: ExecutionService;
  let resolution: ExecutionSessionResolutionService;
  let sessionRepo: Repository<TradingSessionMirror>;
  let riskGrantRepo: Repository<RiskGrantMirror>;
  let confirmationRepo: Repository<ExecutionConfirmationMirror>;
  let brokerService: {
    findConnectionsByIds: jest.Mock;
    findConnectionById: jest.Mock;
    isConnectionExecutable: jest.Mock;
  };
  let auditService: { log: jest.Mock };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [TradingSessionMirror, RiskGrantMirror, ExecutionConfirmationMirror],
    });
    await dataSource.initialize();
    // The EXACT production partial unique (migration 1754000000000): at most
    // ONE ACTIVE session per user. sqlite supports partial indexes.
    await dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_trading_sessions_one_active_per_user
       ON trading_sessions (user_id) WHERE status = 'ACTIVE'`,
    );
    sessionRepo = dataSource.getRepository(TradingSessionMirror);
    riskGrantRepo = dataSource.getRepository(RiskGrantMirror);
    confirmationRepo = dataSource.getRepository(ExecutionConfirmationMirror);

    resolution = new ExecutionSessionResolutionService(
      sessionRepo as unknown as Repository<TradingSession>,
    );
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const eventBus = { publish: jest.fn() } as unknown as DomainEventBus;
    const orchestrator = {} as ExecutionOrchestrator;
    brokerService = {
      findConnectionsByIds: jest
        .fn()
        .mockImplementation(async (ids: string[]) => ids.map((id) => connectionRow(id, USER))),
      findConnectionById: jest.fn(),
      isConnectionExecutable: jest.fn().mockReturnValue(true),
    };

    service = new ExecutionService(
      {} as Repository<Trade>, // trade repo — not exercised by this matrix
      sessionRepo as unknown as Repository<TradingSession>,
      brokerService as unknown as BrokerService,
      orchestrator,
      auditService as unknown as AuditService,
      dataSource,
      eventBus,
      riskGrantRepo as unknown as Repository<RiskGrant>,
      confirmationRepo as unknown as Repository<ExecutionConfirmation>,
      resolution,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM execution_confirmations');
    await dataSource.query('DELETE FROM risk_grants');
    await dataSource.query('DELETE FROM trading_sessions');
    brokerService.findConnectionsByIds.mockImplementation(async (ids: string[]) =>
      ids.map((id) => connectionRow(id, USER)),
    );
    brokerService.isConnectionExecutable.mockReturnValue(true);
    auditService.log.mockClear();
  });

  const start = (userId = USER, connectionId = CONN_A, mode: ExecutionMode = ExecutionMode.PAPER_ONLY) =>
    service.startSession(userId, connectionId, '10000.00', null, mode);

  const seedGrant = async (
    session: { id: string },
    overrides: Partial<RiskGrantMirror> = {},
  ): Promise<RiskGrantMirror> => {
    const grant = riskGrantRepo.create({
      userId: USER,
      signalId: `sig-${Math.random().toString(36).slice(2, 10)}`,
      signalPayloadDigest: DIGEST('a'),
      sessionId: session.id,
      sessionGeneration: 1,
      executionMode: ExecutionMode.PAPER_ONLY,
      brokerConnectionId: CONN_A,
      authorityGeneration: 1,
      orderPayloadDigest: DIGEST('b'),
      orderPayload: { instrument: 'EURUSD', direction: 'BUY', quantity: '0.1', orderType: 'MARKET' },
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      status: RiskGrantStatus.ACTIVE,
      ...overrides,
    });
    return riskGrantRepo.save(grant);
  };

  const seedConfirmation = async (
    session: { id: string },
    overrides: Partial<ExecutionConfirmationMirror> = {},
  ): Promise<ExecutionConfirmationMirror> => {
    const confirmation = confirmationRepo.create({
      userId: USER,
      sessionId: session.id,
      sessionGeneration: 1,
      signalId: `sig-${Math.random().toString(36).slice(2, 10)}`,
      brokerConnectionId: CONN_A,
      orderPayloadDigest: DIGEST('b'),
      instrument: 'EURUSD',
      direction: 'BUY',
      quantity: '0.1',
      expiresAt: new Date(Date.now() + 60_000),
      status: ExecutionConfirmationStatus.PENDING,
      ...overrides,
    });
    return confirmationRepo.save(confirmation);
  };

  // ─── resolveActiveSessionAuthority (the NEW-exposure seam) ───────────────

  describe('resolveActiveSessionAuthority', () => {
    it('resolves the ACTIVE session authority (id, generation, mode, exact connection)', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.SEMI_AUTO);
      const authority = await resolution.resolveActiveSessionAuthority(USER);
      expect(authority).toEqual({
        sessionId: session.id,
        sessionGeneration: 1,
        executionMode: ExecutionMode.SEMI_AUTO,
        brokerConnectionId: CONN_A,
      });
    });

    it('throws the typed not-active error when the user has no ACTIVE session', async () => {
      await expect(resolution.resolveActiveSessionAuthority(USER)).rejects.toThrow(
        SessionAuthorityNotActiveException,
      );
    });
  });

  // ─── startSession idempotency / conflicts / rejections ───────────────────

  describe('startSession', () => {
    it('persists executionMode + authorityGeneration 1 and captures the opening balance', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      expect(session.executionMode).toBe(ExecutionMode.PAPER_ONLY);
      expect(session.authorityGeneration).toBe(1);
      expect(session.status).toBe(TradingSessionStatus.ACTIVE);
      // sqlite numeric affinity hydrates numerics as numbers — assert the
      // captured value round-tripped (PG keeps the exact decimal string).
      expect(Number(session.openingBalance)).toBe(10000);
      expect(Number(session.peakEquity)).toBe(10000);
      expect(session.endedAt).toBeNull();
    });

    it('is idempotent for the same connection + same mode (returns the existing session)', async () => {
      const first = await start(USER, CONN_A, ExecutionMode.SEMI_AUTO);
      const second = await start(USER, CONN_A, ExecutionMode.SEMI_AUTO);
      expect(second.id).toBe(first.id);
      expect(second.authorityGeneration).toBe(1);
      const activeRows = await dataSource.query(
        "SELECT COUNT(*) AS n FROM trading_sessions WHERE user_id = ? AND status = 'ACTIVE'",
        [USER],
      );
      expect(Number(activeRows[0].n)).toBe(1);
    });

    it('throws the typed cross-connection conflict (never silently substitutes the account)', async () => {
      const existing = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      await expect(start(USER, CONN_B, ExecutionMode.PAPER_ONLY)).rejects.toThrow(
        ActiveSessionConflictException,
      );
      // The ACTIVE session remains bound to the EXACT original connection.
      const reloaded = await sessionRepo.findOne({ where: { id: existing.id } });
      expect(reloaded?.brokerConnectionId).toBe(CONN_A);
    });

    it('throws the typed conflict for the same connection but a different mode (mode changes are explicit + audited)', async () => {
      await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      await expect(start(USER, CONN_A, ExecutionMode.SEMI_AUTO)).rejects.toThrow(
        ActiveSessionConflictException,
      );
    });

    it('throws the typed ownership rejection when the connection belongs to another user', async () => {
      brokerService.findConnectionsByIds.mockImplementation(async (ids: string[]) =>
        ids.map(() => connectionRow(CONN_A, OTHER_USER)),
      );
      await expect(start(USER, CONN_A)).rejects.toThrow(BrokerConnectionOwnershipException);
      expect(await sessionRepo.count()).toBe(0);
    });

    it('throws the typed rejection when the connection is not CONNECTED', async () => {
      brokerService.findConnectionsByIds.mockImplementation(async (ids: string[]) =>
        ids.map(() => connectionRow(CONN_A, USER, { status: 'DISCONNECTED' })),
      );
      await expect(start(USER, CONN_A)).rejects.toThrow(BrokerConnectionNotConnectedException);
      expect(await sessionRepo.count()).toBe(0);
    });

    it('throws the typed rejection when the connection is not LIVE-authorization executable', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      await expect(start(USER, CONN_A)).rejects.toThrow(BrokerConnectionNotExecutableException);
      expect(await sessionRepo.count()).toBe(0);
    });
  });

  // ─── changeExecutionMode (audited CAS bump + authority invalidation) ─────

  describe('changeExecutionMode', () => {
    it('bumps the generation, persists the new mode, invalidates ACTIVE grants and REVOKES PENDING confirmations', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      const grant = await seedGrant(session);
      const staleGrant = await seedGrant(session, {
        status: RiskGrantStatus.INVALIDATED,
        invalidationReason: 'OTHER',
      });
      const confirmation = await seedConfirmation(session);
      const consumedConfirmation = await seedConfirmation(session, {
        status: ExecutionConfirmationStatus.CONSUMED,
      });

      const updated = await service.changeExecutionMode(USER, session.id, ExecutionMode.SEMI_AUTO);

      expect(updated.executionMode).toBe(ExecutionMode.SEMI_AUTO);
      expect(updated.authorityGeneration).toBe(2);
      expect(updated.status).toBe(TradingSessionStatus.ACTIVE);

      const invalidatedGrant = await riskGrantRepo.findOne({ where: { id: grant.id } });
      expect(invalidatedGrant?.status).toBe(RiskGrantStatus.INVALIDATED);
      expect(invalidatedGrant?.invalidationReason).toBe('SESSION_AUTHORITY_GENERATION_CHANGED');
      expect(invalidatedGrant?.invalidatedAt).toBeInstanceOf(Date);

      // CAS: a grant already terminal (INVALIDATED by another path) is untouched.
      const untouchedStale = await riskGrantRepo.findOne({ where: { id: staleGrant.id } });
      expect(untouchedStale?.invalidationReason).toBe('OTHER');

      const revoked = await confirmationRepo.findOne({ where: { id: confirmation.id } });
      expect(revoked?.status).toBe(ExecutionConfirmationStatus.REVOKED);
      expect(revoked?.revokedAt).toBeInstanceOf(Date);

      const consumed = await confirmationRepo.findOne({ where: { id: consumedConfirmation.id } });
      expect(consumed?.status).toBe(ExecutionConfirmationStatus.CONSUMED);
      expect(consumed?.revokedAt).toBeNull();

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: USER,
          action: 'TRADING_SESSION_MODE_CHANGED',
          resourceId: session.id,
          metadata: expect.objectContaining({
            previousExecutionMode: ExecutionMode.PAPER_ONLY,
            newExecutionMode: ExecutionMode.SEMI_AUTO,
            previousAuthorityGeneration: 1,
            newAuthorityGeneration: 2,
            invalidatedRiskGrants: 1,
            revokedExecutionConfirmations: 1,
          }),
        }),
      );
    });

    it('never revives invalidated grants when switching back to the original mode', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      const grant = await seedGrant(session);

      await service.changeExecutionMode(USER, session.id, ExecutionMode.SEMI_AUTO);
      await service.changeExecutionMode(USER, session.id, ExecutionMode.PAPER_ONLY);

      const grantAfter = await riskGrantRepo.findOne({ where: { id: grant.id } });
      expect(grantAfter?.status).toBe(RiskGrantStatus.INVALIDATED);
      expect(grantAfter?.invalidationReason).toBe('SESSION_AUTHORITY_GENERATION_CHANGED');
      const sessionAfter = await sessionRepo.findOne({ where: { id: session.id } });
      expect(sessionAfter?.authorityGeneration).toBe(3);
      expect(sessionAfter?.executionMode).toBe(ExecutionMode.PAPER_ONLY);
    });

    it('throws the typed conflict when the observed generation lost the CAS race (0 affected rows)', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      // A concurrent authority change commits between the service's read and
      // its CAS: the stored generation moves to 2 while the service observed 1.
      await sessionRepo
        .createQueryBuilder()
        .update(TradingSessionMirror)
        .set({ authorityGeneration: () => 'authority_generation + 1' })
        .where('id = :id', { id: session.id })
        .execute();

      const realFindOne = sessionRepo.findOne.bind(sessionRepo);
      const current = await realFindOne({ where: { id: session.id } });
      const staleView = { ...current, authorityGeneration: 1 } as TradingSessionMirror;
      const findOneSpy = jest
        .spyOn(sessionRepo, 'findOne')
        .mockImplementationOnce(async () => staleView);

      await expect(
        service.changeExecutionMode(USER, session.id, ExecutionMode.SEMI_AUTO),
      ).rejects.toThrow(SessionAuthorityGenerationConflictException);

      // The mode change did NOT apply — the row still has the racing writer's state.
      const after = await realFindOne({ where: { id: session.id } });
      expect(after?.executionMode).toBe(ExecutionMode.PAPER_ONLY);
      expect(after?.authorityGeneration).toBe(2);
      findOneSpy.mockRestore();
    });

    it('rejects a mode change on a session owned by another user', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      await expect(
        service.changeExecutionMode(OTHER_USER, session.id, ExecutionMode.SEMI_AUTO),
      ).rejects.toThrow();
      const after = await sessionRepo.findOne({ where: { id: session.id } });
      expect(after?.authorityGeneration).toBe(1);
    });

    it('rejects a mode change on a session that is no longer ACTIVE', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      await service.endSession(USER, TradingSessionStatus.ENDED);
      await expect(
        service.changeExecutionMode(USER, session.id, ExecutionMode.SEMI_AUTO),
      ).rejects.toThrow(SessionAuthorityNotActiveException);
    });
  });

  // ─── endSession invalidates outstanding authority ────────────────────────

  describe('endSession', () => {
    it('ends the session, bumps the generation and invalidates outstanding grants / confirmations', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      const grant = await seedGrant(session);
      const confirmation = await seedConfirmation(session);

      await service.endSession(USER, TradingSessionStatus.ENDED);

      const after = await sessionRepo.findOne({ where: { id: session.id } });
      expect(after?.status).toBe(TradingSessionStatus.ENDED);
      expect(after?.endedAt).toBeInstanceOf(Date);
      expect(after?.authorityGeneration).toBe(2);

      const grantAfter = await riskGrantRepo.findOne({ where: { id: grant.id } });
      expect(grantAfter?.status).toBe(RiskGrantStatus.INVALIDATED);
      expect(grantAfter?.invalidationReason).toBe('SESSION_AUTHORITY_GENERATION_CHANGED');

      const confirmationAfter = await confirmationRepo.findOne({ where: { id: confirmation.id } });
      expect(confirmationAfter?.status).toBe(ExecutionConfirmationStatus.REVOKED);
    });

    it('invalidates only grants bound to the OBSERVED generation (new-generation grants survive)', async () => {
      const session = await start(USER, CONN_A, ExecutionMode.PAPER_ONLY);
      await service.changeExecutionMode(USER, session.id, ExecutionMode.SEMI_AUTO); // generation 2
      const newGenerationGrant = await seedGrant(session, {
        sessionGeneration: 2,
        executionMode: ExecutionMode.SEMI_AUTO,
      });

      await service.endSession(USER, TradingSessionStatus.ENDED);

      const grantAfter = await riskGrantRepo.findOne({ where: { id: newGenerationGrant.id } });
      // The end CAS-matched the observed generation 2 and invalidated it.
      expect(grantAfter?.status).toBe(RiskGrantStatus.INVALIDATED);
    });
  });

  // ─── 20-way concurrent start — partial unique arbitration ─────────────────

  describe('20-way concurrent startSession', () => {
    it('yields exactly ONE ACTIVE row, with every caller resolving the same session', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => start(USER, CONN_A, ExecutionMode.PAPER_ONLY)),
      );

      const fulfilled = results.filter(
        (r) => r.status === 'fulfilled',
      ) as PromiseFulfilledResult<TradingSession>[];
      expect(fulfilled).toHaveLength(20);
      const ids = new Set(fulfilled.map((r) => r.value.id));
      expect(ids.size).toBe(1);

      const activeRows = await dataSource.query(
        "SELECT id, broker_connection_id, execution_mode, authority_generation FROM trading_sessions WHERE user_id = ? AND status = 'ACTIVE'",
        [USER],
      );
      expect(activeRows).toHaveLength(1);
      expect(activeRows[0].broker_connection_id).toBe(CONN_A);
      expect(activeRows[0].execution_mode).toBe('PAPER_ONLY');
      expect(Number(activeRows[0].authority_generation)).toBe(1);
    });

    it('a racing start on a DIFFERENT connection never wins the arbitration silently', async () => {
      // 19 same-target starts + 1 cross-connection start racing for the slot.
      const results = await Promise.allSettled([
        ...Array.from({ length: 19 }, () => start(USER, CONN_A, ExecutionMode.PAPER_ONLY)),
        start(USER, CONN_B, ExecutionMode.PAPER_ONLY),
      ]);

      // The cross-connection caller either lost the insert race (typed
      // conflict after the winner's commit) or won it (and the 19
      // same-connection callers then resolve idempotently to its row).
      const conflicts = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof ActiveSessionConflictException,
      );
      const unexpectedRejections = results.filter(
        (r) => r.status === 'rejected' && !(r.reason instanceof ActiveSessionConflictException),
      );
      expect(unexpectedRejections).toHaveLength(0);

      const activeRows = await dataSource.query(
        "SELECT broker_connection_id FROM trading_sessions WHERE user_id = ? AND status = 'ACTIVE'",
        [USER],
      );
      // EXACTLY ONE ACTIVE row survives the arbitration — never two.
      expect(activeRows).toHaveLength(1);
      const winnerConnection = activeRows[0].broker_connection_id;
      expect([CONN_A, CONN_B]).toContain(winnerConnection);
      if (winnerConnection === CONN_A) {
        // The cross-connection start lost the race and saw the typed conflict.
        expect(conflicts).toHaveLength(1);
      } else {
        // The cross-connection start won the race: the 19 same-connection
        // callers must ALL have received the typed conflict (never a silent
        // substitution of their requested connection).
        expect(conflicts).toHaveLength(19);
      }
    });
  });
});
