import { ForbiddenException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { ExecutionService } from './execution.service';
import { Trade } from './entities/trade.entity';
import { TradingSession } from './entities/trading-session.entity';
import { BrokerService } from '../broker/broker.service';
import { BrokerAdapterRegistry } from '../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../broker/services/credential-encryption.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { BrokerMode, IBrokerAdapter } from '../broker/interfaces/broker-adapter.interface';
import { RiskDecision } from '../risk/interfaces/risk.interface';

describe('ExecutionService — real PostgreSQL advisory-lock concurrency', () => {
  let dataSource: DataSource;
  let service: ExecutionService;
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
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS trading');
    await dataSource.query('DROP TABLE IF EXISTS trading.trades');
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
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE trading.trades');
    tradeRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    placeOrder = jest.fn().mockResolvedValue({
      success: true,
      externalOrderId: 'broker-position-1',
      filledPrice: '1.08500',
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
    } as IBrokerAdapter;
    // Sprint 50 correction round: the connection fixture carries the
    // credential lifecycle state, and the (Phase D) orchestrator boundary
    // re-loads the persisted connection — the mock answers both entry points
    // with the same usable-state connection.
    const connection = {
      id: connectionId,
      brokerId: 'paper-broker',
      accountType: BrokerMode.DEMO,
      credentialStatus: 'VERIFIED',
      encryptedCredentials: 'ciphertext',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'test-key',
    };
    const brokerService = {
      findActiveConnectionForUser: jest.fn().mockResolvedValue(connection),
      findConnectionById: jest.fn().mockResolvedValue(connection),
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
    const auditService = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const eventBus = { publish: jest.fn() } as unknown as DomainEventBus;
    service = new ExecutionService(
      tradeRepo as unknown as Repository<Trade>,
      {} as Repository<TradingSession>,
      brokerService,
      adapterRegistry,
      encryptionService,
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
    expect(rows[0].status).toBe('PENDING');
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
});
