import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsModule } from './metrics.module';
import { renderPrometheusText } from './prometheus-text';
import { METRIC_GAUGE_NAMES, METRIC_NAMES } from './metric-names';
import { InternalApiKeyGuard } from '../../common/guards/internal-api-key.guard';
import { IS_PUBLIC_KEY } from '../../common/constants/roles.constants';
import { Trade, TradeStatus } from '../execution/entities/trade.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';
import { BrokerAccountSnapshot } from '../broker/entities/broker-account-snapshot.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { Order } from '../execution/orders/order.entity';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';

const VALID_KEY = 'test-internal-key-12345678901234';

/** Query-builder chain mock for the grouped open-trades gauge query. */
const tradeRepoWithRows = (rows: Array<{ status: string; count: string }>) =>
  ({
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    }),
  }) as unknown as Repository<Trade>;

const sessionRepoWithCount = (count: number) =>
  ({ count: jest.fn().mockResolvedValue(count) }) as unknown as Repository<TradingSession>;

/** Grouped-count query-builder mock for the broker-connections gauge. */
const connectionRepoWithRows = (rows: Array<{ authorizationStatus: string; count: string }>) =>
  ({
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    }),
  }) as unknown as Repository<BrokerConnection>;

/** Raw-query mock for the snapshot-staleness gauge (DISTINCT ON latest row). */
const snapshotRepoWithRows = (
  rows: Array<{ connection_id: string; observed_at: string | Date | null }>,
) => ({ query: jest.fn().mockResolvedValue(rows) }) as unknown as Repository<BrokerAccountSnapshot>;

/** Raw-query mock for the reconciliation-age gauge (MAX(completed_at)). */
const runRepoWithLastCompleted = (lastCompletedAt: string | Date | null) =>
  ({
    query: jest.fn().mockResolvedValue([{ last_completed_at: lastCompletedAt }]),
  }) as unknown as Repository<ReconciliationRun>;

/** Count mock for the reconciliation-pending-orders gauge. */
const orderRepoWithCount = (count: number) =>
  ({ count: jest.fn().mockResolvedValue(count) }) as unknown as Repository<Order>;

describe('MetricsController — internal /metrics scrape endpoint', () => {
  let module: TestingModule;
  let controller: MetricsController;
  let metrics: MetricsService;

  const buildModule = async (overrides?: {
    sessionRepo?: Repository<TradingSession>;
    tradeRepo?: Repository<Trade>;
    connectionRepo?: Repository<BrokerConnection>;
    snapshotRepo?: Repository<BrokerAccountSnapshot>;
    runRepo?: Repository<ReconciliationRun>;
    orderRepo?: Repository<Order>;
  }): Promise<void> => {
    // ConfigModule.forRoot({ isGlobal: true }) mirrors exactly how AppModule
    // mounts MetricsModule — the InternalApiKeyGuard's ConfigService must
    // resolve through the global config registration, not a test stub (only
    // the TypeORM repository tokens are stubbed — no live database).
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), MetricsModule],
    })
      .overrideProvider(getRepositoryToken(TradingSession))
      .useValue(overrides?.sessionRepo ?? sessionRepoWithCount(3))
      .overrideProvider(getRepositoryToken(Trade))
      .useValue(overrides?.tradeRepo ?? tradeRepoWithRows([]))
      .overrideProvider(getRepositoryToken(BrokerConnection))
      .useValue(overrides?.connectionRepo ?? connectionRepoWithRows([]))
      .overrideProvider(getRepositoryToken(BrokerAccountSnapshot))
      .useValue(overrides?.snapshotRepo ?? snapshotRepoWithRows([]))
      .overrideProvider(getRepositoryToken(ReconciliationRun))
      .useValue(overrides?.runRepo ?? runRepoWithLastCompleted(null))
      .overrideProvider(getRepositoryToken(Order))
      .useValue(overrides?.orderRepo ?? orderRepoWithCount(0))
      .compile();

    controller = module.get<MetricsController>(MetricsController);
    metrics = module.get<MetricsService>(MetricsService);
    metrics.reset();
  };

  afterEach(async () => {
    await module.close();
  });

  describe('module wiring smoke test', () => {
    it('compiles MetricsModule with mocked repos and resolves service + controller', async () => {
      await buildModule();
      expect(controller).toBeInstanceOf(MetricsController);
      expect(metrics).toBeInstanceOf(MetricsService);
      expect(await controller.getMetrics()).toEqual(expect.any(String));
    });

    it('exposes MetricsService for injection/export (DI token resolvable)', () => {
      // MetricsModule compiles AND exports MetricsService (the ModuleRef
      // strict:false lookup target used by the instrumented services).
      expect(module.get(MetricsService, { strict: false })).toBeInstanceOf(MetricsService);
    });
  });

  describe('Prometheus text exposition rendering', () => {
    it('renders # HELP / # TYPE headers and counter samples', async () => {
      await buildModule();
      metrics.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome: 'EXECUTION_SUCCEEDED' });
      metrics.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome: 'RISK_REJECTED' });
      metrics.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome: 'RISK_REJECTED' });

      const text = await controller.getMetrics();
      const lines = text.split('\n');
      expect(lines).toContain(`# TYPE ${METRIC_NAMES.AI_SIGNALS_RECEIVED} counter`);
      expect(lines).toContain(
        `${METRIC_NAMES.AI_SIGNALS_RECEIVED}{outcome="EXECUTION_SUCCEEDED"} 1`,
      );
      expect(lines).toContain(`${METRIC_NAMES.AI_SIGNALS_RECEIVED}{outcome="RISK_REJECTED"} 2`);
      expect(
        lines.some((line) => line.startsWith(`# HELP ${METRIC_NAMES.AI_SIGNALS_RECEIVED} `)),
      ).toBe(true);
      expect(text.endsWith('\n')).toBe(true);
    });

    it('renders label-less counters without braces', async () => {
      await buildModule();
      metrics.increment(METRIC_NAMES.GRANTS_ISSUED);
      const text = await controller.getMetrics();
      expect(text).toContain(`\n${METRIC_NAMES.GRANTS_ISSUED} 1\n`);
    });

    it('escapes backslash, double-quote and newline in label values (renderer contract)', () => {
      // The MetricsService sanitize whitelist already strips these characters
      // on every write path — the renderer escaping is defense-in-depth for any
      // series value, so it is proven directly against the pure renderer.
      const text = renderPrometheusText({
        generatedAt: new Date().toISOString(),
        counters: [
          {
            name: METRIC_NAMES.PROVIDER_REJECTS,
            labels: { reason: 'bad\\quote"and\nnewline' },
            value: 1,
          },
        ],
        gauges: [],
        recent: [],
      });
      expect(text).toContain(
        `${METRIC_NAMES.PROVIDER_REJECTS}{reason="bad\\\\quote\\"and\\nnewline"} 1`,
      );
    });

    it('emits each metric family exactly once (no duplicate HELP/TYPE pairs)', async () => {
      await buildModule();
      metrics.increment(METRIC_NAMES.RISK_REJECTIONS, { code: 'A' });
      metrics.increment(METRIC_NAMES.RISK_REJECTIONS, { code: 'B' });
      const text = await controller.getMetrics();
      const helpLines = text
        .split('\n')
        .filter((l) => l.startsWith(`# HELP ${METRIC_NAMES.RISK_REJECTIONS} `));
      const typeLines = text
        .split('\n')
        .filter((l) => l === `# TYPE ${METRIC_NAMES.RISK_REJECTIONS} counter`);
      expect(helpLines).toHaveLength(1);
      expect(typeLines).toHaveLength(1);
    });
  });

  describe('DB-backed gauges (computed on scrape)', () => {
    it('renders irexpro_live_sessions_active from the ACTIVE session count', async () => {
      await buildModule({ sessionRepo: sessionRepoWithCount(7) });
      const text = await controller.getMetrics();
      expect(text).toContain(`# TYPE ${METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE} gauge`);
      expect(text).toContain(`${METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE} 7`);
    });

    it('renders irexpro_open_trades grouped by status label', async () => {
      await buildModule({
        tradeRepo: tradeRepoWithRows([
          { status: TradeStatus.OPEN, count: '4' },
          { status: TradeStatus.RECONCILIATION_PENDING, count: '2' },
        ]),
      });
      const text = await controller.getMetrics();
      expect(text).toContain(`# TYPE ${METRIC_GAUGE_NAMES.OPEN_TRADES} gauge`);
      expect(text).toContain(`${METRIC_GAUGE_NAMES.OPEN_TRADES}{status="OPEN"} 4`);
      expect(text).toContain(
        `${METRIC_GAUGE_NAMES.OPEN_TRADES}{status="RECONCILIATION_PENDING"} 2`,
      );
    });

    it('materializes explicit zero series when a status has no rows', async () => {
      await buildModule({
        tradeRepo: tradeRepoWithRows([{ status: TradeStatus.OPEN, count: '5' }]),
      });
      const text = await controller.getMetrics();
      expect(text).toContain(`${METRIC_GAUGE_NAMES.OPEN_TRADES}{status="OPEN"} 5`);
      expect(text).toContain(
        `${METRIC_GAUGE_NAMES.OPEN_TRADES}{status="RECONCILIATION_PENDING"} 0`,
      );
    });

    it('OMITS the live-sessions gauge when its query fails (fail-open, never 500)', async () => {
      const failing = {
        count: jest.fn().mockRejectedValue(new Error('db down')),
      } as unknown as Repository<TradingSession>;
      await buildModule({
        sessionRepo: failing,
        tradeRepo: tradeRepoWithRows([{ status: TradeStatus.OPEN, count: '1' }]),
      });
      await expect(controller.getMetrics()).resolves.toEqual(expect.any(String));
      const text = await controller.getMetrics();
      expect(text).not.toContain(METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE);
      expect(text).toContain(`${METRIC_GAUGE_NAMES.OPEN_TRADES}{status="OPEN"} 1`);
    });

    it('OMITS the open-trades gauge when its query fails (fail-open)', async () => {
      await buildModule({
        sessionRepo: sessionRepoWithCount(2),
        tradeRepo: {
          createQueryBuilder: jest.fn().mockImplementation(() => {
            throw new Error('db down');
          }),
        } as unknown as Repository<Trade>,
      });
      const text = await controller.getMetrics();
      expect(text).toContain(`${METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE} 2`);
      expect(text).not.toContain(METRIC_GAUGE_NAMES.OPEN_TRADES);
    });

    it('never serves a STALE gauge from a previous successful scrape', async () => {
      await buildModule(); // first scrape: session count 3 → gauge set
      await controller.getMetrics();
      expect((await controller.getMetrics()).toString()).toContain(
        `${METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE} 3`,
      );
      // second scrape: the query now fails → the stale 3 must disappear
      (
        controller as unknown as { sessionRepo: { count: jest.Mock } }
      ).sessionRepo.count.mockRejectedValue(new Error('db down now'));
      const text = await controller.getMetrics();
      expect(text).not.toContain(`${METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE} 3`);
      expect(text).not.toContain(`# TYPE ${METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE} gauge`);
    });

    it('renders irexpro_broker_connections grouped by authorizationStatus with explicit zeros', async () => {
      await buildModule({
        connectionRepo: connectionRepoWithRows([
          { authorizationStatus: 'ACTIVE', count: '2' },
          { authorizationStatus: 'SUSPENDED', count: '1' },
        ]),
      });
      const text = await controller.getMetrics();
      expect(text).toContain(
        `# TYPE ${METRIC_GAUGE_NAMES.BROKER_CONNECTIONS_BY_AUTHORIZATION} gauge`,
      );
      expect(text).toContain(
        `${METRIC_GAUGE_NAMES.BROKER_CONNECTIONS_BY_AUTHORIZATION}{authorizationStatus="ACTIVE"} 2`,
      );
      expect(text).toContain(
        `${METRIC_GAUGE_NAMES.BROKER_CONNECTIONS_BY_AUTHORIZATION}{authorizationStatus="SUSPENDED"} 1`,
      );
      // Every enum status materializes — an absent status is an explicit 0.
      expect(text).toContain(
        `${METRIC_GAUGE_NAMES.BROKER_CONNECTIONS_BY_AUTHORIZATION}{authorizationStatus="REVOKED"} 0`,
      );
      expect(text).toContain(
        `${METRIC_GAUGE_NAMES.BROKER_CONNECTIONS_BY_AUTHORIZATION}{authorizationStatus="NOT_CONNECTED"} 0`,
      );
    });

    it('renders per-connection snapshot staleness in seconds from the latest observation instant', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        await buildModule({
          snapshotRepo: snapshotRepoWithRows([
            {
              connection_id: 'conn-1',
              observed_at: new Date(1_700_000_000_000 - 30_000).toISOString(),
            },
            {
              connection_id: 'conn-2',
              observed_at: new Date(1_700_000_000_000 - 5_000).toISOString(),
            },
          ]),
        });
        const text = await controller.getMetrics();
        expect(text).toContain(
          `# TYPE ${METRIC_GAUGE_NAMES.BROKER_SNAPSHOT_STALENESS_SECONDS} gauge`,
        );
        expect(text).toContain(
          `${METRIC_GAUGE_NAMES.BROKER_SNAPSHOT_STALENESS_SECONDS}{connectionId="conn-1"} 30`,
        );
        expect(text).toContain(
          `${METRIC_GAUGE_NAMES.BROKER_SNAPSHOT_STALENESS_SECONDS}{connectionId="conn-2"} 5`,
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('clamps negative snapshot staleness to zero (provider clock slightly ahead)', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        await buildModule({
          snapshotRepo: snapshotRepoWithRows([
            {
              connection_id: 'conn-future',
              observed_at: new Date(1_700_000_000_500).toISOString(),
            },
          ]),
        });
        const text = await controller.getMetrics();
        expect(text).toContain(
          `${METRIC_GAUGE_NAMES.BROKER_SNAPSHOT_STALENESS_SECONDS}{connectionId="conn-future"} 0`,
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('renders the reconciliation last-cycle age from MAX(completed_at)', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        await buildModule({
          runRepo: runRepoWithLastCompleted(new Date(1_700_000_000_000 - 90_000)),
        });
        const text = await controller.getMetrics();
        expect(text).toContain(
          `# TYPE ${METRIC_GAUGE_NAMES.RECONCILIATION_LAST_CYCLE_AGE_SECONDS} gauge`,
        );
        expect(text).toContain(`${METRIC_GAUGE_NAMES.RECONCILIATION_LAST_CYCLE_AGE_SECONDS} 90`);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('OMITS the reconciliation age gauge when no run ever completed (honest absence)', async () => {
      await buildModule({ runRepo: runRepoWithLastCompleted(null) });
      const text = await controller.getMetrics();
      expect(text).not.toContain(METRIC_GAUGE_NAMES.RECONCILIATION_LAST_CYCLE_AGE_SECONDS);
    });

    it('renders the reconciliation-pending (orphaned/uncertain) order count', async () => {
      await buildModule({ orderRepo: orderRepoWithCount(4) });
      const text = await controller.getMetrics();
      expect(text).toContain(`# TYPE ${METRIC_GAUGE_NAMES.RECONCILIATION_PENDING_ORDERS} gauge`);
      expect(text).toContain(`${METRIC_GAUGE_NAMES.RECONCILIATION_PENDING_ORDERS} 4`);
    });

    it('OMITS each new gauge independently when its backing query fails (fail-open)', async () => {
      await buildModule({
        connectionRepo: {
          createQueryBuilder: jest.fn(() => {
            throw new Error('db down');
          }),
        } as unknown as Repository<BrokerConnection>,
        snapshotRepo: {
          query: jest.fn().mockRejectedValue(new Error('db down')),
        } as unknown as Repository<BrokerAccountSnapshot>,
        runRepo: {
          query: jest.fn().mockRejectedValue(new Error('db down')),
        } as unknown as Repository<ReconciliationRun>,
        orderRepo: {
          count: jest.fn().mockRejectedValue(new Error('db down')),
        } as unknown as Repository<Order>,
      });
      const text = await controller.getMetrics();
      // The scrape itself never 500s and the OTHER gauges still render.
      expect(text).toEqual(expect.any(String));
      expect(text).toContain(`${METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE} 3`);
      expect(text).not.toContain(METRIC_GAUGE_NAMES.BROKER_CONNECTIONS_BY_AUTHORIZATION);
      expect(text).not.toContain(METRIC_GAUGE_NAMES.BROKER_SNAPSHOT_STALENESS_SECONDS);
      expect(text).not.toContain(METRIC_GAUGE_NAMES.RECONCILIATION_LAST_CYCLE_AGE_SECONDS);
      expect(text).not.toContain(METRIC_GAUGE_NAMES.RECONCILIATION_PENDING_ORDERS);
    });
  });

  describe('guard wiring (NEVER public)', () => {
    const reflector = new Reflector();

    it('mounts InternalApiKeyGuard at the class level', () => {
      // GUARDS_METADATA is '__guards__' (not exported publicly — mirrored here)
      const guards: unknown[] = Reflect.getMetadata('__guards__', MetricsController);
      expect(guards).toEqual([InternalApiKeyGuard]);
    });

    it('marks the controller @Public (JWT bypass) — the internal key is the ONLY guard', () => {
      // Class-level @Public (mirrors the runtime check order of JwtAuthGuard:
      // handler then class) — no user JWT can ever be the auth for /metrics.
      expect(reflector.get(IS_PUBLIC_KEY, MetricsController)).toBe(true);
    });

    it('is routed at GET metrics', () => {
      expect(Reflect.getMetadata('path', MetricsController)).toBe('metrics');
      expect(Reflect.getMetadata('method', MetricsController.prototype.getMetrics)).toBe(0); // RequestMethod.GET
    });

    it('sets the Prometheus text content type via @Header', () => {
      const headers: Array<{ name: string; value: string }> =
        Reflect.getMetadata('__headers__', MetricsController.prototype.getMetrics) ?? [];
      expect(headers).toContainEqual({
        name: 'Content-Type',
        value: 'text/plain; version=0.0.4; charset=utf-8',
      });
    });
  });

  describe('InternalApiKeyGuard enforcement', () => {
    let guard: InternalApiKeyGuard;

    const makeContext = (headerValue?: string) => ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: headerValue ? { 'x-irexpro-internal-api-key': headerValue } : {},
        }),
      }),
    });

    beforeEach(() => {
      const configService = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'internalApi.key') return VALID_KEY;
          return undefined;
        }),
      } as unknown as ConfigService;
      guard = new InternalApiKeyGuard(configService);
    });

    it('rejects a missing API key header', () => {
      expect(() => guard.canActivate(makeContext(undefined) as never)).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an invalid API key', () => {
      expect(() => guard.canActivate(makeContext('wrong-key') as never)).toThrow(
        UnauthorizedException,
      );
    });

    it('accepts the valid internal API key', () => {
      expect(guard.canActivate(makeContext(VALID_KEY) as never)).toBe(true);
    });
  });
});
