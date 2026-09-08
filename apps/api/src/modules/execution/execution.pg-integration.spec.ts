import { ForbiddenException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { ExecutionService } from './execution.service';
import { Trade } from './entities/trade.entity';
import { TradingSession } from './entities/trading-session.entity';
import { Order } from './orders/order.entity';
import { OrderService } from './orders/order.service';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { ExecutionIntent } from './orchestration/execution-intent.interface';
import { BrokerService } from '../broker/broker.service';
import { BrokerAdapterRegistry } from '../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../broker/services/credential-encryption.service';
import { ExecutionControlService } from '../execution-control/execution-control.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { BrokerMode, IBrokerAdapter } from '../broker/interfaces/broker-adapter.interface';
import { RiskDecision } from '../risk/interfaces/risk.interface';
import { OrderKind, OrderTimeInForce } from './orders/order.enums';

/**
 * Sprint 50 PR-3 — real-PostgreSQL concurrency proof for the execution
 * orchestration pipeline (ExecutionService → ExecutionOrchestrator →
 * OrderService → adapter):
 *
 * 1. The Sprint 32 trade-slot advisory-lock guarantees (unchanged).
 * 2. NEW: exactly-once DISPATCH — a duplicate clientOrderId NEVER re-calls
 *    the provider, even under concurrency (the order-layer idempotency).
 * 3. NEW: the full order lifecycle (CREATED → SUBMITTED → ACKNOWLEDGED →
 *    FILLED with exact decimal fill math) is recorded on real PostgreSQL.
 */
describe('ExecutionService — real PostgreSQL advisory-lock concurrency', () => {
  let dataSource: DataSource;
  let service: ExecutionService;
  let orchestrator: ExecutionOrchestrator;
  let placeOrder: jest.Mock;
  let tradeRepo: { update: jest.Mock };

  const userId = '11111111-1111-1111-1111-111111111111';
  const connectionId = '22222222-2222-2222-2222-222222222222';

  const decision = (signalId: string, maxDailyTrades = 1): RiskDecision => ({
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
  });

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'irexpro',
      password: process.env.DB_PASSWORD ?? 'test_password',
      database: process.env.DB_NAME ?? 'irexpro_test',
      entities: [Order],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS trading');
    await dataSource.query('DROP TABLE IF EXISTS trading.trades');
    await dataSource.query('DROP TABLE IF EXISTS trading.orders');
    await dataSource.query(`CREATE TABLE trading.trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
      broker_connection_id UUID NOT NULL, signal_id UUID, idempotency_key VARCHAR(255) UNIQUE NOT NULL,
      instrument VARCHAR(50) NOT NULL, direction VARCHAR(10) NOT NULL,
      lot_size NUMERIC(10,4) NOT NULL, requested_entry_price NUMERIC(18,8) NOT NULL,
      fill_price NUMERIC(18,8), stop_loss NUMERIC(18,8) NOT NULL, take_profit NUMERIC(18,8) NOT NULL,
      trailing_stop_pips NUMERIC(8,2), external_order_id VARCHAR(255), status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      exit_price NUMERIC(18,8), realised_pnl NUMERIC(18,8), close_reason VARCHAR(64), broker_rejection_reason TEXT,
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
        'CREATED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED',
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
    // The trade-repository mock PERSISTS updates to the real table (the
    // orchestration pipeline's trade-side assertions read the DB row state,
    // so a no-op mock would leave the trade PENDING forever).
    const toSnake = (key: string) => key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    tradeRepo = {
      update: jest.fn().mockImplementation(async (criteria, patch: Record<string, unknown>) => {
        const id = typeof criteria === 'string' ? criteria : (criteria as { id: string }).id;
        const params: unknown[] = [id];
        const sets = Object.entries(patch).map(([key, value], i) => {
          params.push(value instanceof Date ? value.toISOString() : (value ?? null));
          return `"${toSnake(key)}" = $${i + 2}`;
        });
        await dataSource.query(
          `UPDATE trading.trades SET ${sets.join(', ')} WHERE id = $1`,
          params,
        );
        return { affected: 1 };
      }),
    };
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
    // with the same usable-state connection.
    const connection = {
      id: connectionId,
      brokerId: 'paper-broker',
      accountType: BrokerMode.DEMO,
      status: 'CONNECTED',
      authorizationStatus: 'ACTIVE',
      credentialStatus: 'VERIFIED',
      encryptedCredentials: 'ciphertext',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'test-key',
    };
    const brokerService = {
      findActiveConnectionForUser: jest.fn().mockResolvedValue(connection),
      findConnectionById: jest.fn().mockResolvedValue(connection),
      isConnectionExecutable: jest.fn().mockReturnValue(true),
    } as unknown as BrokerService;
    const adapterRegistry = {
      getAdapter: jest.fn().mockReturnValue(adapter),
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
    const auditService = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const eventBus = { publish: jest.fn() } as unknown as DomainEventBus;

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
    );
    service = new ExecutionService(
      tradeRepo as unknown as Repository<Trade>,
      {} as Repository<TradingSession>,
      brokerService,
      orchestrator,
      auditService,
      dataSource,
      eventBus,
    );
  });

  it('different signals racing for final slot yield one DB row and one broker submission', async () => {
    const results = await Promise.allSettled([
      service.executeTrade(userId, decision('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
      service.executeTrade(userId, decision('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')),
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

  it('same signal concurrently persists once and submits to broker once', async () => {
    const signalId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const results = await Promise.allSettled([
      service.executeTrade(userId, decision(signalId, 10)),
      service.executeTrade(userId, decision(signalId, 10)),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const rows = await dataSource.query(
      'SELECT idempotency_key FROM trading.trades WHERE user_id = $1',
      [userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('records the full normalized order lifecycle (CREATED→SUBMITTED→ACKNOWLEDGED→FILLED) on real PostgreSQL', async () => {
    const signalId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const trade = await service.executeTrade(userId, decision(signalId, 10));

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
    await service.executeTrade(userId, decision(signalId, 10));

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
    const connection = (await brokerServiceHandle.findActiveConnectionForUser(userId))!;
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
