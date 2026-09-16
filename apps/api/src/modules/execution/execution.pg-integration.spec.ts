import { ForbiddenException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource, Repository } from 'typeorm';
import { ExecutionService } from './execution.service';
import type { EmergencyFlattenProducer } from './jobs/emergency-flatten.producer';
import { Trade } from './entities/trade.entity';
import { TradingSession } from './entities/trading-session.entity';
import { RiskGrant } from './entities/risk-grant.entity';
import { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import { TradeIntent } from './entities/trade-intent.entity';
import { TradeIntentService } from './services/trade-intent.service';
import { ExecutionMode } from './interfaces/execution-authority';
import { ExecutionSessionResolutionService } from './execution-session.resolution';
import { Order } from './orders/order.entity';
import { OrderService } from './orders/order.service';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import type { MarketSafetyGateService } from './orchestration/market-safety-gate.service';
import { AccountDispatchLeaseService } from './orchestration/account-dispatch-lease.service';
import { ExecutionIntent } from './orchestration/execution-intent.interface';
import { FinalDispatchBoundary } from './orchestration/final-dispatch-boundary';
import { TradeLifecycleCasService } from './orders/trade-lifecycle-cas.service';
import { BrokerService } from '../broker/broker.service';
import { BrokerAdapterRegistry } from '../broker/adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from '../broker/registry/broker-provider-registry.service';
import { CredentialEncryptionService } from '../broker/services/credential-encryption.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { BrokerMode, IBrokerAdapter } from '../broker/interfaces/broker-adapter.interface';
import { RiskDecision } from '../risk/interfaces/risk.interface';
import { RiskGrantService } from '../risk/risk-grant.service';
import { OrderKind, OrderTimeInForce } from './orders/order.enums';

/**
 * Sprint 50 PR-3 — real-PostgreSQL concurrency proof for the execution
 * orchestration pipeline (ExecutionService → FinalDispatchBoundary →
 * ExecutionOrchestrator → OrderService → adapter):
 *
 * 1. The Sprint 32 trade-slot advisory-lock guarantees (unchanged).
 * 2. NEW: exactly-once DISPATCH — a duplicate clientOrderId NEVER re-calls
 *    the provider, even under concurrency (the order-layer idempotency).
 * 3. NEW: the full order lifecycle (CREATED → SUBMITTED → ACKNOWLEDGED →
 *    FILLED with exact decimal fill math) is recorded on real PostgreSQL.
 * 4. Round 5 (task 50-c): the FINAL DISPATCH BOUNDARY runs for REAL against
 *    real grant/session rows — a durable RiskGrant is REQUIRED per approval
 *    and consumed atomically (the same signal racing through two
 *    executeTrade calls yields ONE grant-consume winner and ONE provider
 *    call; the loser gets the typed grant conflict, never a second
 *    dispatch).
 */
describe('ExecutionService — real PostgreSQL advisory-lock concurrency', () => {
  let dataSource: DataSource;
  let service: ExecutionService;
  let orchestrator: ExecutionOrchestrator;
  let placeOrder: jest.Mock;
  let riskGrantRepo: Repository<RiskGrant>;
  let sessionRepo: Repository<TradingSession>;
  let confirmationRepo: Repository<ExecutionConfirmation>;
  let tradeRepo: Repository<Trade>;
  let tradeIntentService: TradeIntentService;

  const userId = '11111111-1111-1111-1111-111111111111';
  const connectionId = '22222222-2222-2222-2222-222222222222';
  const sessionId = '33333333-3333-4333-8333-333333333333';

  const decision = (
    signalId: string,
    maxDailyTrades = 1,
  ): RiskDecision & { decision: 'APPROVED' } => ({
    decision: 'APPROVED',
    signalId,
    validatedOrder: {
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.05',
      entryPrice: '1.08500',
      stopLoss: '1.07500',
      takeProfit: '1.09500',
      idempotencyKey: `caller-${signalId}`,
    },
    appliedRules: ['TEST:REAL_POSTGRES'],
    riskScore: 10,
    evaluatedAt: new Date(),
    maxDailyTrades,
    // Round 5 (task 50-c): the durable authority — seeded per signal by
    // seedGrant() in beforeEach; the boundary consumes it atomically.
    grantId: '',
    sessionId,
    sessionGeneration: 1,
    executionMode: ExecutionMode.FULL_AUTO,
    brokerConnectionId: connectionId,
  });

  /** Seed one ACTIVE grant (+ returns its id) bound to the test session. */
  const seedGrant = async (signalId: string): Promise<string> => {
    const grant = riskGrantRepo.create({
      userId,
      signalId,
      signalPayloadDigest: `sig-${signalId}`.padEnd(64, '0').slice(0, 64),
      sessionId,
      sessionGeneration: 1,
      executionMode: ExecutionMode.FULL_AUTO,
      brokerConnectionId: connectionId,
      credentialGeneration: 0,
      providerBrokerIdentity: null,
      providerVerificationFingerprint: null,
      riskProfileId: null,
      riskProfileVersion: null,
      riskProfileHash: null,
      accountSnapshotId: null,
      accountSnapshotGeneration: null,
      accountSnapshotObservedAt: null,
      authorityGeneration: 1,
      killSwitchGeneration: null,
      executionControlRevision: null,
      orderPayloadDigest: `order-${signalId}`.padEnd(64, '0').slice(0, 64),
      orderPayload: {
        instrument: 'EURUSD',
        direction: 'BUY',
        quantity: '0.05',
        orderType: 'MARKET',
      },
      quoteRef: null,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      invalidatedAt: null,
      invalidationReason: null,
      status: 'ACTIVE',
    } as RiskGrant);
    const saved = await riskGrantRepo.save(grant);
    return saved.id;
  };

  /** decision() + a seeded ACTIVE grant (the durable authority handle). */
  const grantedDecision = async (signalId: string, maxDailyTrades = 1): Promise<RiskDecision> => {
    const grantId = await seedGrant(signalId);
    // Round 6 §2: the durable TradeIntent is recorded at intake — the
    // executeTrade intent guard fail-closes without it.
    await tradeIntentService.recordOrReuseIntent({
      userId,
      signalId,
      signalGeneratedAt: new Date(),
      brokerConnectionId: connectionId,
      logicalAccountKey: null,
      tradingSessionId: sessionId,
      strategyCode: 'test-strategy',
      modelVersion: 'test-model',
      timeframe: 'M15',
      instrument: 'EURUSD',
      direction: 'BUY',
      requestedLotSize: '0.05',
      requestedEntryPrice: null,
      stopLoss: '1.07500',
      takeProfit: '1.09500',
      trailingStopPips: null,
      rationale: null,
      metadata: null,
      authorityGeneration: 1,
      tradingPolicyRevision: 1,
      providerVerificationRevision: 1,
      executionControlRevision: 1,
    });
    return { ...decision(signalId, maxDailyTrades), grantId };
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'irexpro',
      password: process.env.DB_PASSWORD ?? 'test_password',
      database: process.env.DB_NAME ?? 'irexpro_test',
      entities: [Order, Trade, TradingSession, RiskGrant, ExecutionConfirmation, TradeIntent],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS trading');
    await dataSource.query('DROP TABLE IF EXISTS trading.trades');
    await dataSource.query('DROP TABLE IF EXISTS trading.orders');
    await dataSource.query('DROP TABLE IF EXISTS trading.execution_confirmations');
    await dataSource.query('DROP TABLE IF EXISTS trading.risk_grants');
    await dataSource.query('DROP TABLE IF EXISTS trading.trading_sessions');
    await dataSource.query('DROP TABLE IF EXISTS trading.trade_intents');
    // The ACTIVE session bound to every seeded grant (task 50-c: the
    // boundary re-reads CURRENT session/authority state).
    await dataSource.query(`CREATE TABLE trading.trading_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      broker_connection_id UUID NOT NULL,
      execution_mode VARCHAR(20) NOT NULL DEFAULT 'PAPER_ONLY',
      authority_generation INTEGER NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      opening_balance NUMERIC(15,2),
      account_currency VARCHAR(3),
      opening_snapshot_id UUID,
      opening_snapshot_generation INTEGER,
      peak_equity NUMERIC(15,2),
      risk_profile_snapshot JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // trade_intents — mirrors migration 1754400000000 (Round 6 §2: the
    // durable normalized AI-decision layer; UNIQUE (user_id, intent_key) is
    // the exactly-once intent identity backstop).
    await dataSource.query(`CREATE TABLE trading.trade_intents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      intent_key VARCHAR(255) NOT NULL,
      signal_id VARCHAR(100) NOT NULL,
      signal_generated_at TIMESTAMPTZ NOT NULL,
      broker_connection_id UUID NOT NULL,
      logical_account_key VARCHAR(255),
      trading_session_id UUID,
      strategy_code VARCHAR(100),
      model_version VARCHAR(100),
      timeframe VARCHAR(20),
      instrument VARCHAR(30) NOT NULL,
      direction VARCHAR(4) NOT NULL,
      entry_type VARCHAR(20) NOT NULL DEFAULT 'MARKET',
      requested_lot_size NUMERIC(10,4) NOT NULL,
      requested_entry_price NUMERIC(18,8),
      stop_loss NUMERIC(18,8),
      take_profit NUMERIC(18,8),
      trailing_stop_pips NUMERIC(10,2),
      expires_at TIMESTAMPTZ NOT NULL,
      market_data_ref JSONB,
      rationale TEXT,
      metadata JSONB,
      authority_generation INTEGER NOT NULL,
      trading_policy_revision INTEGER,
      provider_verification_revision INTEGER,
      execution_control_revision INTEGER,
      status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
      trade_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_trade_intents_user_intent_key UNIQUE (user_id, intent_key))`);
    // risk_grants — mirrors migration 1754000000000 + the 1754200000000
    // fencing column (credential_generation).
    await dataSource.query(`CREATE TABLE trading.risk_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      signal_id VARCHAR(100) NOT NULL,
      signal_payload_digest VARCHAR(64) NOT NULL,
      session_id UUID NOT NULL,
      session_generation INTEGER NOT NULL,
      execution_mode VARCHAR(20) NOT NULL,
      broker_connection_id UUID NOT NULL,
      credential_generation INTEGER,
      provider_broker_identity VARCHAR(100),
      provider_verification_fingerprint VARCHAR(128),
      risk_profile_id UUID,
      risk_profile_version INTEGER,
      risk_profile_hash VARCHAR(64),
      account_snapshot_id UUID,
      account_snapshot_generation INTEGER,
      account_snapshot_observed_at TIMESTAMPTZ,
      authority_generation INTEGER NOT NULL,
      kill_switch_generation INTEGER,
      execution_control_revision INTEGER,
      authority_binding_digest VARCHAR(64),
      trading_policy_revision INTEGER,
      provider_verification_revision INTEGER,
      order_payload_digest VARCHAR(64) NOT NULL,
      order_payload JSONB NOT NULL,
      quote_ref JSONB,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      invalidated_at TIMESTAMPTZ,
      invalidation_reason VARCHAR(200),
      status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await dataSource.query(
      `CREATE UNIQUE INDEX uq_risk_grants_one_active_per_signal ON trading.risk_grants (signal_id) WHERE status = 'ACTIVE'`,
    );
    await dataSource.query(`CREATE TABLE trading.execution_confirmations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      session_id UUID NOT NULL,
      session_generation INTEGER NOT NULL,
      signal_id VARCHAR(100) NOT NULL,
      broker_connection_id UUID NOT NULL,
      risk_grant_id UUID,
      order_payload_digest VARCHAR(64) NOT NULL,
      instrument VARCHAR(50) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      quantity NUMERIC(18,8) NOT NULL,
      stop_loss NUMERIC(18,8),
      take_profit NUMERIC(18,8),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await dataSource.query(
      `CREATE UNIQUE INDEX uq_execution_confirmations_one_pending_per_signal ON trading.execution_confirmations (signal_id) WHERE status = 'PENDING'`,
    );
    await dataSource.query(`CREATE TABLE trading.trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
      broker_connection_id UUID NOT NULL, signal_id UUID, idempotency_key VARCHAR(255) UNIQUE NOT NULL,
      instrument VARCHAR(50) NOT NULL, direction VARCHAR(10) NOT NULL,
      lot_size NUMERIC(10,4) NOT NULL, requested_entry_price NUMERIC(18,8) NOT NULL,
      fill_price NUMERIC(18,8), stop_loss NUMERIC(18,8) NOT NULL, take_profit NUMERIC(18,8) NOT NULL,
      trailing_stop_pips NUMERIC(8,2), external_order_id VARCHAR(255), external_position_id VARCHAR(255),
      commission NUMERIC(18,8), swap NUMERIC(18,8), status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      exit_price NUMERIC(18,8), realised_pnl NUMERIC(18,8), close_reason VARCHAR(64), broker_rejection_reason TEXT,
      dispatch_certainty VARCHAR(30), trading_session_id UUID, logical_account_key VARCHAR(255), account_currency VARCHAR(3),
      risk_period_id UUID, trade_intent_id UUID, risk_grant_id UUID, order_id UUID,
      opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // trading.orders — mirrors migration 1753600000000 (CreateNormalizedOrderDomain)
    await dataSource.query(`CREATE TABLE trading.orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      broker_connection_id UUID NOT NULL,
      trade_id UUID NULL,
      signal_id UUID NULL,
      client_order_id VARCHAR(100) NOT NULL,
      provider_order_id VARCHAR(255) NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      order_kind VARCHAR(20) NOT NULL,
      time_in_force VARCHAR(10) NOT NULL,
      instrument VARCHAR(50) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      requested_quantity NUMERIC(10,4) NOT NULL,
      requested_price NUMERIC(18,8) NULL,
      stop_price NUMERIC(18,8) NULL,
      filled_quantity NUMERIC(10,4) NOT NULL DEFAULT 0,
      avg_fill_price NUMERIC(18,8) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'CREATED',
      reject_reason VARCHAR(500) NULL,
      submitted_at TIMESTAMPTZ NULL,
      finalized_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_orders_kind CHECK (order_kind IN ('MARKET','LIMIT','STOP','STOP_LIMIT')),
      CONSTRAINT chk_orders_tif CHECK (time_in_force IN ('GTC','DAY','IOC','FOK')),
      CONSTRAINT chk_orders_direction CHECK (direction IN ('BUY','SELL')),
      CONSTRAINT chk_orders_status CHECK (status IN (
        'CREATED','SUBMITTED','DISPATCH_COMMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED',
        'REJECTED','CANCELLED','EXPIRED','RECONCILIATION_PENDING')),
      CONSTRAINT chk_orders_quantity_positive CHECK (requested_quantity > 0),
      CONSTRAINT chk_orders_filled_range CHECK (filled_quantity >= 0 AND filled_quantity <= requested_quantity),
      CONSTRAINT chk_orders_fill_price_consistency CHECK (
        (filled_quantity = 0 AND avg_fill_price IS NULL)
        OR (filled_quantity > 0 AND avg_fill_price IS NOT NULL)),
      CONSTRAINT chk_orders_price_kind CHECK (
        (order_kind = 'MARKET' AND requested_price IS NULL AND stop_price IS NULL)
        OR (order_kind = 'LIMIT' AND requested_price IS NOT NULL AND stop_price IS NULL)
        OR (order_kind = 'STOP' AND requested_price IS NULL AND stop_price IS NOT NULL)
        OR (order_kind = 'STOP_LIMIT' AND requested_price IS NOT NULL AND stop_price IS NOT NULL)),
      CONSTRAINT chk_orders_filled_implies_submitted CHECK (filled_quantity = 0 OR submitted_at IS NOT NULL)
    )`);
    await dataSource.query(
      `CREATE UNIQUE INDEX uq_orders_idempotency_key ON trading.orders (idempotency_key)`,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE trading.trades');
    await dataSource.query('TRUNCATE TABLE trading.orders');
    await dataSource.query('TRUNCATE TABLE trading.execution_confirmations');
    await dataSource.query('TRUNCATE TABLE trading.risk_grants');
    await dataSource.query('TRUNCATE TABLE trading.trading_sessions');
    await dataSource.query('TRUNCATE TABLE trading.trade_intents');
    // Real repositories: trade-lifecycle CAS + the boundary operate on the
    // real PostgreSQL rows (task 50-c).
    tradeRepo = dataSource.getRepository(Trade);
    sessionRepo = dataSource.getRepository(TradingSession);
    riskGrantRepo = dataSource.getRepository(RiskGrant);
    confirmationRepo = dataSource.getRepository(ExecutionConfirmation);

    // The ACTIVE session every grant binds to (authorityGeneration 1,
    // FULL_AUTO so the pipeline origin may dispatch; the connection is the
    // paper-broker path).
    await sessionRepo.save(
      sessionRepo.create({
        id: sessionId,
        userId,
        brokerConnectionId: connectionId,
        executionMode: ExecutionMode.FULL_AUTO,
        authorityGeneration: 1,
        status: 'ACTIVE',
        startedAt: new Date(),
      } as TradingSession),
    );

    placeOrder = jest.fn().mockResolvedValue({
      success: true,
      externalOrderId: 'broker-position-1',
      filledPrice: '1.08500',
      filledQuantity: '0.05',
      status: 'FILLED',
    });
    const adapter = {
      brokerId: 'paper-broker',
      brokerName: 'Concurrency Test Broker',
      supportsDemo: true,
      // Round 6 §7: the declared order capability contract.
      getOrderCapabilities: jest.fn().mockReturnValue({
        brokerId: 'paper-broker',
        supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'],
        requirements: {
          MARKET: { limitPriceRequired: false, stopPriceRequired: false },
          LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
          STOP: { limitPriceRequired: false, stopPriceRequired: true },
          STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
        },
        marketSlTpAttachedAtPlacement: true,
      }),
      setMode: jest.fn(),
      connect: jest.fn().mockResolvedValue({ success: true }),
      disconnect: jest.fn(),
      testConnection: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
      getAccountInfo: jest.fn(),
      getAccountBalance: jest.fn(),
      getOpenPositions: jest.fn(),
      getPositionById: jest.fn(),
      getRequiredMargin: jest.fn(),
      getInstrumentList: jest.fn(),
      getCurrentPrice: jest.fn(),
      getOHLCV: jest.fn(),
      placeOrder,
      modifyOrder: jest.fn(),
      closeOrder: jest.fn(),
      closeAllOrders: jest.fn(),
      getClosedTrades: jest.fn(),
      // Sprint 50 PR-4: provider order-state read surface
      listOrders: jest.fn(),
      getOrderById: jest.fn(),
    } as IBrokerAdapter;
    // Sprint 50 correction round: the connection fixture carries the
    // credential lifecycle state, and the (Phase D) orchestrator boundary
    // re-loads the persisted connection — the mock answers both entry points
    // with the same usable-state connection. Task 50-c: the connection also
    // carries credentialGeneration 0 — the grant-observed value the boundary
    // fences on.
    const connection = {
      id: connectionId,
      userId,
      brokerId: 'paper-broker',
      accountType: BrokerMode.DEMO,
      status: 'CONNECTED',
      authorizationStatus: 'ACTIVE',
      credentialStatus: 'VERIFIED',
      credentialGeneration: 0,
      encryptedCredentials: 'ciphertext',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'test-key',
    };
    const brokerService = {
      // Round 5 (#295): discovery sentinel — executeTrade resolves the session
      // authority seam + the EXACT session-bound connection by id.
      findActiveConnectionForUser: jest.fn(),
      findConnectionById: jest.fn().mockResolvedValue(connection),
      findConnectionsByIds: jest.fn().mockResolvedValue([connection]),
      isConnectionExecutable: jest.fn().mockReturnValue(true),
    } as unknown as BrokerService;
    const adapterRegistry = {
      getAdapter: jest.fn().mockReturnValue(adapter),
      getAdapterForConnection: jest.fn().mockReturnValue(adapter),
    } as unknown as BrokerAdapterRegistry;
    const encryptionService = {
      decrypt: jest.fn().mockReturnValue({
        apiKey: 'test',
        apiSecret: 'test',
        accountId: 'test-account',
      }),
    } as unknown as CredentialEncryptionService;
    const executionControlService = {
      checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true, blockedBy: null }),
    } as unknown as ExecutionControlService;
    const providerRegistry = {
      getEntry: jest.fn().mockReturnValue(null),
      isProductionLiveEligible: jest.fn().mockReturnValue(false),
    } as unknown as BrokerProviderRegistryService;
    const auditService = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const eventBus = { publish: jest.fn() } as unknown as DomainEventBus;

    // Round 5: the session-authority seam is mocked at this boundary — the
    // session-resolution + start-race matrix against REAL PostgreSQL lives in
    // execution-session.pg-integration.spec.ts.
    const sessionResolution = {
      resolveActiveSessionAuthority: jest.fn().mockResolvedValue({
        sessionId: 'session-1',
        sessionGeneration: 1,
        executionMode: ExecutionMode.PAPER_ONLY,
        brokerConnectionId: connectionId,
      }),
    } as unknown as ExecutionSessionResolutionService;

    const orderService = new OrderService(
      dataSource.getRepository(Order) as Repository<Order>,
      dataSource,
    );
    orchestrator = new ExecutionOrchestrator(
      orderService,
      brokerService,
      executionControlService,
      adapterRegistry,
      encryptionService,
      auditService,
      eventBus,
      // Round 6 (#365): the provider-dispatch commitment seam — the
      // commitment-path pg matrices are tracked for this CI-gated suite.
      {} as never,
      // Round 6 §5/§18: the market-safety gate is exercised at the SEAM
      // (its own matrix lives in market-safety-gate.spec.ts) — passes by
      // default; per-test overrides make it fail closed.
      {
        assertMarketSafeForDispatch: jest.fn().mockResolvedValue(undefined),
      } as unknown as MarketSafetyGateService,
      // Round 6 §14: the per-account dispatch lease (real implementation —
      // its own matrix lives in account-dispatch-lease.spec.ts).
      new AccountDispatchLeaseService(),
      // Round 7 (P1 metrics): the lazy MetricsService ModuleRef seam — the
      // stub's get() returns undefined, so every metrics call site no-ops.
      { get: jest.fn() } as unknown as ModuleRef,
    );
    // Round 5 (task 50-c): the REAL final dispatch boundary + the REAL
    // RiskGrantService (the 50-b contract) + the REAL trade-lifecycle CAS —
    // grant consumption, confirmation fencing and CAS transitions run
    // against real PostgreSQL rows.
    const riskGrantService = new RiskGrantService(
      riskGrantRepo,
      confirmationRepo,
      auditService,
      // Round 7 (P1 metrics): the lazy MetricsService ModuleRef seam.
      { get: jest.fn() } as unknown as ModuleRef,
    );
    const boundary = new FinalDispatchBoundary(
      riskGrantRepo,
      sessionRepo,
      confirmationRepo,
      brokerService,
      executionControlService,
      providerRegistry,
      auditService,
      riskGrantService,
      // Round 6 (#365): the provider-dispatch commitment seam — the
      // commitment-path pg matrices (authority-generation mismatch, shared
      // revision mismatch, exactly-one-commitment) are tracked for this
      // CI-gated suite (NOT EXECUTED locally — no PostgreSQL in sandbox).
      dataSource.getRepository(Order),
      {} as never,
      dataSource,
      { getCurrentGeneration: jest.fn().mockResolvedValue(1) } as never,
      {
        getCurrentTradingPolicyRevision: jest.fn(),
        getCurrentProviderVerificationRevision: jest.fn(),
        getCurrentExecutionControlRevision: jest.fn(),
      } as never,
    );
    // PG harness: route orchestrator dispatch commitment through the same real
    // FinalDispatchBoundary instance used by ExecutionService.
    (
      orchestrator as unknown as { finalDispatchBoundary: FinalDispatchBoundary }
    ).finalDispatchBoundary = boundary;
    const tradeCas = new TradeLifecycleCasService(tradeRepo, auditService);
    // Round 6 §2: the REAL TradeIntentService against real PostgreSQL rows —
    // the intent guard + exactly-once identity run in this CI-gated matrix.
    tradeIntentService = new TradeIntentService(dataSource.getRepository(TradeIntent));
    service = new ExecutionService(
      tradeRepo as unknown as Repository<Trade>,
      sessionRepo,
      brokerService,
      orchestrator,
      auditService,
      dataSource,
      // Round 7 (P1): the durable-flatten producer is a stub seam here.
      {} as EmergencyFlattenProducer,
      eventBus,
      riskGrantRepo,
      confirmationRepo,
      sessionResolution,
      boundary,
      tradeCas,
      tradeIntentService,
    );
  });

  it('different signals racing for final slot yield one DB row and one broker submission', async () => {
    const [decisionA, decisionB] = await Promise.all([
      grantedDecision('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      grantedDecision('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ]);
    const results = await Promise.allSettled([
      service.executeTrade(userId, decisionA),
      service.executeTrade(userId, decisionB),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ForbiddenException);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const rows = await dataSource.query('SELECT status FROM trading.trades WHERE user_id = $1', [
      userId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('same signal concurrently: ONE durable trade, ONE broker submission, duplicate returns existing trade', async () => {
    const signalId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    // ONE durable grant for the signal — both racing executeTrade calls carry
    // the same grantId. The atomic trade-slot reservation serializes the same
    // idempotency key: one caller reserves the PENDING trade and proceeds to
    // provider commitment; the duplicate caller returns that existing trade.
    // Exactly one provider dispatch is therefore possible.
    const granted = await grantedDecision(signalId, 10);
    const results = await Promise.allSettled([
      service.executeTrade(userId, granted),
      service.executeTrade(userId, granted),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(0);
    const returnedTradeIds = fulfilled.map(
      (r) => (r as PromiseFulfilledResult<{ id: string }>).value.id,
    );
    expect(returnedTradeIds[0]).toBe(returnedTradeIds[1]);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const rows = await dataSource.query(
      'SELECT id, idempotency_key FROM trading.trades WHERE user_id = $1',
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(returnedTradeIds[0]);
  });

  it('records the full normalized order lifecycle (CREATED→SUBMITTED→ACKNOWLEDGED→FILLED) on real PostgreSQL', async () => {
    const signalId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const trade = await service.executeTrade(userId, await grantedDecision(signalId, 10));

    // The trade (position aggregate) mirrors the outcome.
    expect(trade.status).toBe('OPEN');
    expect(trade.externalOrderId).toBe('broker-position-1');

    const orders = await dataSource.query(
      'SELECT * FROM trading.orders WHERE user_id = $1 AND signal_id = $2',
      [userId, signalId],
    );
    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order.client_order_id).toBe(`sig-${signalId}`);
    expect(order.trade_id).toBe(trade.id);
    expect(order.order_kind).toBe('MARKET');
    expect(order.status).toBe('FILLED');
    expect(String(order.filled_quantity)).toBe('0.0500');
    expect(String(order.avg_fill_price)).toBe('1.08500000');
    expect(order.provider_order_id).toBe('broker-position-1');
    expect(order.submitted_at).not.toBeNull();
    expect(order.finalized_at).not.toBeNull();

    const trades = await dataSource.query(
      'SELECT * FROM trading.trades WHERE user_id = $1 AND signal_id = $2',
      [userId, signalId],
    );
    expect(trades).toHaveLength(1);
    expect(trades[0].status).toBe('OPEN');
    expect(trades[0].external_order_id).toBe('broker-position-1');
    expect(String(trades[0].fill_price)).toBe('1.08500000');
  });

  it('duplicate clientOrderId never re-dispatches — exactly-once at the order layer (sequential)', async () => {
    const signalId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await service.executeTrade(userId, await grantedDecision(signalId, 10));

    // A second orchestrated dispatch with the SAME clientOrderId (e.g. a
    // retried pipeline after a crash) must NOT re-contact the provider.
    const intent: ExecutionIntent = {
      userId,
      brokerConnectionId: connectionId,
      clientOrderId: `sig-${signalId}`,
      orderKind: OrderKind.MARKET,
      timeInForce: OrderTimeInForce.GTC,
      instrument: 'EURUSD',
      direction: 'BUY',
      requestedQuantity: '0.05',
      stopLoss: '1.07500',
      takeProfit: '1.09500',
      providerAction: 'PLACE',
    };
    const brokerServiceHandle = (service as unknown as { brokerService: BrokerService })
      .brokerService;
    const connection = (await brokerServiceHandle.findConnectionById(connectionId, userId))!;
    const outcome = await orchestrator.dispatchOrder(intent, connection);

    expect(outcome.outcome).toBe('DUPLICATE');
    // The outcome carries the EXISTING order's identifier explicitly.
    expect(outcome.orderId).toBeDefined();
    expect(outcome.order.id).toBe(outcome.orderId);
    expect(placeOrder).toHaveBeenCalledTimes(1);

    const orders = await dataSource.query(
      'SELECT * FROM trading.orders WHERE client_order_id = $1',
      [`sig-${signalId}`],
    );
    expect(orders).toHaveLength(1);
  });

  it('concurrent duplicate order dispatches race to exactly one provider call', async () => {
    const intent: ExecutionIntent = {
      userId,
      brokerConnectionId: connectionId,
      clientOrderId: 'race-order-001',
      orderKind: OrderKind.MARKET,
      timeInForce: OrderTimeInForce.GTC,
      instrument: 'EURUSD',
      direction: 'BUY',
      requestedQuantity: '0.05',
      stopLoss: '1.07500',
      takeProfit: '1.09500',
      providerAction: 'PLACE',
    };
    const connection = {
      id: connectionId,
      brokerId: 'paper-broker',
      accountType: BrokerMode.DEMO,
      encryptedCredentials: 'ciphertext',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'test-key',
    };

    const outcomes = await Promise.all([
      orchestrator.dispatchOrder(intent, connection as never),
      orchestrator.dispatchOrder(intent, connection as never),
    ]);

    // One dispatch reaches the provider; the duplicate is suppressed BEFORE
    // any provider I/O — the exactly-once dispatch guarantee.
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const duplicateOutcomes = outcomes.filter((o) => o.outcome === 'DUPLICATE');
    const dispatchedOutcomes = outcomes.filter((o) => o.outcome !== 'DUPLICATE');
    expect(dispatchedOutcomes).toHaveLength(1);
    expect(duplicateOutcomes).toHaveLength(1);
    // Every outcome variant carries an explicit, defined orderId.
    for (const o of outcomes) {
      expect(o.orderId).toBeDefined();
      expect(o.order.id).toBe(o.orderId);
    }

    const orders = await dataSource.query(
      'SELECT * FROM trading.orders WHERE client_order_id = $1',
      ['race-order-001'],
    );
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('FILLED');
  });
});
