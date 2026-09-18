import { DataSource, Repository } from 'typeorm';
import { ExecutionService } from './execution.service';
import type { EmergencyFlattenProducer } from './jobs/emergency-flatten.producer';
import { TradingSession } from './entities/trading-session.entity';
import { RiskGrant } from './entities/risk-grant.entity';
import { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import {
  ExecutionMode,
  ExecutionConfirmationStatus,
  RiskGrantStatus,
} from './interfaces/execution-authority';
import {
  ActiveSessionConflictException,
  ExecutionSessionResolutionService,
} from './execution-session.resolution';
import { BrokerService } from '../broker/broker.service';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { FinalDispatchBoundary } from './orchestration/final-dispatch-boundary';
import { TradeLifecycleCasService } from './orders/trade-lifecycle-cas.service';
import type { TradeIntentService } from './services/trade-intent.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { Trade } from './entities/trade.entity';

/**
 * Sprint 56 correction round 5 — real-PostgreSQL session-authority proofs
 * (architect issues #295/#298):
 *
 *   1. 20 concurrent startSession calls race the partial unique index
 *      uq_trading_sessions_one_active_per_user (migration 1754000000000):
 *      exactly ONE ACTIVE row survives, every caller resolves the SAME
 *      session (unique-violation catch → re-read the winner).
 *   2. The audited execution-mode change CAS-bumps authority_generation and
 *      INVALIDATES the outstanding ACTIVE RiskGrant (reason
 *      SESSION_AUTHORITY_GENERATION_CHANGED) + REVOKES the PENDING
 *      confirmation on real PostgreSQL.
 *
 * Gated exactly like execution.pg-integration.spec.ts: honored via the jest
 * testPathIgnorePatterns 'pg-integration' entry — typechecks locally, runs on
 * PostgreSQL in CI (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME).
 */
describe('ExecutionService — session authority on real PostgreSQL (#295/#298)', () => {
  let dataSource: DataSource;
  let service: ExecutionService;
  let sessionRepo: Repository<TradingSession>;
  let riskGrantRepo: Repository<RiskGrant>;
  let confirmationRepo: Repository<ExecutionConfirmation>;
  let brokerService: {
    findConnectionsByIds: jest.Mock;
    isConnectionExecutable: jest.Mock;
  };
  let auditService: { log: jest.Mock };

  const USER = '11111111-1111-4111-8111-111111111111';
  const CONN_A = '33333333-3333-4333-8333-333333333333';
  const CONN_B = '44444444-4444-4444-8444-444444444444';
  const DIGEST = (char: string) => char.repeat(64);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'irexpro',
      password: process.env.DB_PASSWORD ?? 'test_password',
      database: process.env.DB_NAME ?? 'irexpro_test',
      entities: [TradingSession, RiskGrant, ExecutionConfirmation],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS trading');

    // trading.trading_sessions — baseline columns + the execution-authority
    // columns from migration 1754000000000 (execution_mode,
    // authority_generation) + the partial unique one-ACTIVE-per-user.
    await dataSource.query('DROP TABLE IF EXISTS trading.execution_confirmations');
    await dataSource.query('DROP TABLE IF EXISTS trading.risk_grants');
    await dataSource.query('DROP TABLE IF EXISTS trading.trading_sessions');
    await dataSource.query(`CREATE TABLE trading.trading_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      broker_connection_id uuid NOT NULL,
      execution_mode varchar(20) NOT NULL DEFAULT 'PAPER_ONLY',
      authority_generation integer NOT NULL DEFAULT 1,
      status varchar(30) NOT NULL DEFAULT 'ACTIVE',
      opening_balance numeric(15,2),
      account_currency varchar(3),
      opening_snapshot_id uuid,
      opening_snapshot_generation integer,
      peak_equity numeric(15,2),
      risk_profile_snapshot jsonb,
      started_at timestamptz NOT NULL DEFAULT NOW(),
      ended_at timestamptz,
      close_ai_positions_on_stop boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT ck_trading_sessions_execution_mode
        CHECK (execution_mode IN ('PAPER_ONLY', 'SEMI_AUTO', 'FULL_AUTO')),
      CONSTRAINT ck_trading_sessions_authority_generation
        CHECK (authority_generation >= 1)
    )`);
    await dataSource.query(`
      CREATE UNIQUE INDEX uq_trading_sessions_one_active_per_user
      ON trading.trading_sessions (user_id)
      WHERE status = 'ACTIVE'`);

    // trading.risk_grants / trading.execution_confirmations — mirrors
    // migration 1754000000000 (subset exercised by this spec's authority rows).
    await dataSource.query(`CREATE TABLE trading.risk_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      signal_id varchar(100) NOT NULL,
      signal_payload_digest varchar(64) NOT NULL,
      session_id uuid NOT NULL,
      session_generation integer NOT NULL,
      execution_mode varchar(20) NOT NULL,
      broker_connection_id uuid NOT NULL,
      credential_generation integer,
      provider_broker_identity varchar(100),
      provider_verification_fingerprint varchar(128),
      risk_profile_id uuid,
      risk_profile_version integer,
      risk_profile_hash varchar(64),
      account_snapshot_id uuid,
      account_snapshot_generation integer,
      account_snapshot_observed_at timestamptz,
      authority_generation integer NOT NULL,
      kill_switch_generation integer,
      execution_control_revision integer,
      authority_binding_digest varchar(64),
      trading_policy_revision integer,
      provider_verification_revision integer,
      order_payload_digest varchar(64) NOT NULL,
      order_payload jsonb NOT NULL,
      quote_ref jsonb,
      issued_at timestamptz NOT NULL DEFAULT NOW(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      invalidated_at timestamptz,
      invalidation_reason varchar(200),
      status varchar(30) NOT NULL DEFAULT 'ACTIVE',
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )`);
    await dataSource.query(`CREATE TABLE trading.execution_confirmations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      session_id uuid NOT NULL,
      session_generation integer NOT NULL,
      signal_id varchar(100) NOT NULL,
      broker_connection_id uuid NOT NULL,
      risk_grant_id uuid,
      order_payload_digest varchar(64) NOT NULL,
      instrument varchar(50) NOT NULL,
      direction varchar(10) NOT NULL,
      quantity numeric(18,8) NOT NULL,
      stop_loss numeric(18,8),
      take_profit numeric(18,8),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      revoked_at timestamptz,
      status varchar(30) NOT NULL DEFAULT 'PENDING',
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )`);

    sessionRepo = dataSource.getRepository(TradingSession);
    riskGrantRepo = dataSource.getRepository(RiskGrant);
    confirmationRepo = dataSource.getRepository(ExecutionConfirmation);

    const resolution = new ExecutionSessionResolutionService(sessionRepo);
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const eventBus = { publish: jest.fn() } as unknown as DomainEventBus;
    brokerService = {
      findConnectionsByIds: jest.fn().mockImplementation(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          userId: USER,
          brokerId: 'paper-broker',
          status: 'CONNECTED',
          authorizationStatus: 'ACTIVE',
        })),
      ),
      isConnectionExecutable: jest.fn().mockReturnValue(true),
    };

    service = new ExecutionService(
      {} as Repository<Trade>, // trade repo — not exercised by this matrix
      sessionRepo,
      brokerService as unknown as BrokerService,
      {} as ExecutionOrchestrator,
      auditService as unknown as AuditService,
      dataSource,
      // Round 7 (P1): the durable-flatten producer is a stub seam here.
      {} as EmergencyFlattenProducer,
      eventBus,
      riskGrantRepo,
      confirmationRepo,
      resolution,
      // Round 5 (task 50-c): boundary + trade-lifecycle CAS are stub seams in
      // this session-authority matrix (their real-store proofs live in the
      // dedicated final-dispatch-boundary / trade-cas specs).
      {} as FinalDispatchBoundary,
      {} as TradeLifecycleCasService,
      // Round 6 §2: the durable TradeIntent guard is a stub seam in this
      // session-authority matrix (executeTrade is not exercised here).
      {
        resolveIntentForExecutionBySignal: jest.fn(),
        markExecuted: jest.fn(),
        markRejected: jest.fn(),
      } as unknown as TradeIntentService,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM trading.execution_confirmations');
    await dataSource.query('DELETE FROM trading.risk_grants');
    await dataSource.query('DELETE FROM trading.trading_sessions');
    auditService.log.mockClear();
  });

  it('20 concurrent startSession calls: exactly ONE ACTIVE row survives and every caller resolves it', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.startSession(USER, CONN_A, '10000.00', null, ExecutionMode.PAPER_ONLY),
      ),
    );

    // The partial unique index arbitrates the race: every loser catches the
    // unique violation, re-reads the winner, and resolves the SAME session.
    const fulfilled = results.filter(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<TradingSession>[];
    expect(fulfilled).toHaveLength(20);
    expect(new Set(fulfilled.map((r) => r.value.id)).size).toBe(1);

    const activeRows = await dataSource.query(
      `SELECT COUNT(*) AS n FROM trading.trading_sessions WHERE user_id = $1 AND status = 'ACTIVE'`,
      [USER],
    );
    expect(Number(activeRows[0].n)).toBe(1);

    const row = await dataSource.query(
      `SELECT execution_mode, authority_generation FROM trading.trading_sessions WHERE user_id = $1`,
      [USER],
    );
    expect(row[0].execution_mode).toBe('PAPER_ONLY');
    expect(Number(row[0].authority_generation)).toBe(1);
  });

  it('mode change invalidates the outstanding RiskGrant and revokes the PENDING confirmation (generation CAS)', async () => {
    const session = await service.startSession(
      USER,
      CONN_A,
      '10000.00',
      null,
      ExecutionMode.PAPER_ONLY,
    );
    const grant = riskGrantRepo.create({
      userId: USER,
      signalId: 'sig-pg-1',
      signalPayloadDigest: DIGEST('a'),
      sessionId: session.id,
      sessionGeneration: 1,
      executionMode: ExecutionMode.PAPER_ONLY,
      brokerConnectionId: CONN_A,
      authorityGeneration: 1,
      orderPayloadDigest: DIGEST('b'),
      orderPayload: {
        instrument: 'EURUSD',
        direction: 'BUY',
        quantity: '0.1',
        orderType: 'MARKET',
      },
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      status: RiskGrantStatus.ACTIVE,
    });
    const savedGrant = await riskGrantRepo.save(grant);
    const confirmation = confirmationRepo.create({
      userId: USER,
      sessionId: session.id,
      sessionGeneration: 1,
      signalId: 'sig-pg-1',
      brokerConnectionId: CONN_A,
      orderPayloadDigest: DIGEST('b'),
      instrument: 'EURUSD',
      direction: 'BUY',
      quantity: '0.1',
      expiresAt: new Date(Date.now() + 60_000),
      status: ExecutionConfirmationStatus.PENDING,
    });
    const savedConfirmation = await confirmationRepo.save(confirmation);

    const updated = await service.changeExecutionMode(USER, session.id, ExecutionMode.SEMI_AUTO);

    expect(updated.executionMode).toBe(ExecutionMode.SEMI_AUTO);
    expect(updated.authorityGeneration).toBe(2);

    const grantAfter = await riskGrantRepo.findOne({ where: { id: savedGrant.id } });
    expect(grantAfter?.status).toBe(RiskGrantStatus.INVALIDATED);
    expect(grantAfter?.invalidationReason).toBe('SESSION_AUTHORITY_GENERATION_CHANGED');
    expect(grantAfter?.invalidatedAt).toBeInstanceOf(Date);

    const confirmationAfter = await confirmationRepo.findOne({
      where: { id: savedConfirmation.id },
    });
    expect(confirmationAfter?.status).toBe(ExecutionConfirmationStatus.REVOKED);
    expect(confirmationAfter?.revokedAt).toBeInstanceOf(Date);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TRADING_SESSION_MODE_CHANGED',
        resourceId: session.id,
        metadata: expect.objectContaining({
          invalidatedRiskGrants: 1,
          revokedExecutionConfirmations: 1,
        }),
      }),
    );
  });

  it('a concurrent start on ANOTHER connection hits the typed conflict — the winner is never silently substituted', async () => {
    const results = await Promise.allSettled([
      service.startSession(USER, CONN_A, '10000.00', null, ExecutionMode.PAPER_ONLY),
      service.startSession(USER, CONN_B, '10000.00', null, ExecutionMode.PAPER_ONLY),
    ]);

    const conflicts = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ActiveSessionConflictException,
    );
    expect(conflicts).toHaveLength(1);

    const activeRows = await dataSource.query(
      `SELECT broker_connection_id FROM trading.trading_sessions WHERE user_id = $1 AND status = 'ACTIVE'`,
      [USER],
    );
    expect(activeRows).toHaveLength(1);
    expect([CONN_A, CONN_B]).toContain(activeRows[0].broker_connection_id);
  });
});
