/**
 * Runtime bootstrap smoke test (Sprint 20).
 *
 * Purpose: catch NestJS dependency-injection / module-wiring failures BEFORE
 * they reach a real deployment. This test was added after a staging VPS dry-run
 * (PM2) failed with:
 *
 *   Nest can't resolve dependencies of the ExecutionService
 *   (..., CredentialEncryptionService at index [4], ...).
 *
 * The existing unit tests did not catch it because each spec builds an isolated
 * TestingModule with manually-mocked providers — the real module boundary /
 * export graph is never exercised. This test compiles the REAL feature-module
 * graph (all 21 modules from AppModule) so that any missing provider export
 * surfaces as a test failure in CI rather than at runtime.
 *
 * Infrastructure stubbing (so CI does not need live PostgreSQL / Redis):
 *   - @nestjs/typeorm is mocked: forRoot → global no-op providing a mock
 *     DataSource; forFeature → provides mock repository tokens for each entity.
 *   - @nestjs/bullmq is mocked: forRoot → no-op (no Redis connection);
 *     registerQueue → provides mock Queue tokens for each queue.
 *
 * These mocks prevent real TCP connections (which would otherwise retry forever
 * and stack-overflow) while letting every real feature module, provider, and
 * export boundary resolve exactly as it would in production. The real
 * ExecutionModule and BrokerModule are imported unchanged — their DI graphs
 * must resolve fully, including the cross-module CredentialEncryptionService
 * injection that broke on staging.
 *
 * What this test catches:
 *   - A service injected across a module boundary whose provider is not exported
 *     (the exact Sprint 20 CredentialEncryptionService regression).
 *   - A missing provider in any feature module.
 *   - A circular import that breaks DI resolution.
 *   - Any future module-wiring mistake that compiles in isolation but fails at
 *     runtime under the full module graph.
 *
 * What this test does NOT do:
 *   - It does not call listen(), so no port is bound.
 *   - It does not connect to PostgreSQL or Redis.
 *   - It does not execute any business logic (no trades, no payments, no AI).
 *   - It does not bypass the real ExecutionModule wiring — ExecutionModule is
 *     imported for real, so its DI graph must resolve fully.
 *
 * Production safety rules preserved:
 *   - AI never executes broker orders directly (unchanged — not exercised here).
 *   - Risk gate remains mandatory (unchanged).
 *   - Payment checkout never marks paid (unchanged).
 *   - Only verified webhooks confirm payment (unchanged).
 *   - No floating-point money (unchanged).
 *   - No demo fallback (unchanged).
 *   - No localStorage / Fovi-style assumptions (unchanged).
 *   - No secrets committed (env vars below are test-only placeholders).
 */

// ── Infrastructure mocks (must run before any feature-module import) ──────────

// Mock @nestjs/bullmq: forRoot/registerQueue become no-op DynamicModules that
// provide mock Queue tokens. This prevents BullMQ's Queue/Worker from opening a
// real Redis connection (which retries forever and stack-overflows in CI).
jest.mock('@nestjs/bullmq', () => {
  const real = jest.requireActual('@nestjs/bullmq');
  const noopModule = () => ({
    module: class NoopBullModule {},
    providers: [],
    exports: [],
  });
  return {
    ...real,
    BullModule: {
      forRoot: jest.fn(() => noopModule()),
      forRootAsync: jest.fn(() => noopModule()),
      // Round 7: the REAL registerQueue signature is VARIADIC — it accepts
      // any number of queue options and returns ONE DynamicModule providing
      // every queue token. The previous single-option mock silently dropped
      // all but the first queue of a multi-queue registration (the
      // execution module now registers three queues in one call), leaving
      // the remaining @InjectQueue tokens unresolved (DI recursion at init).
      registerQueue: jest.fn((...allOpts: Array<{ name: string }>) => {
        const providers: Array<{ provide: symbol; useValue: unknown }> = [];
        for (const opts of allOpts) {
          const token = real.getQueueToken(opts.name);
          providers.push({
            provide: token,
            useValue: {
              add: jest.fn().mockResolvedValue(undefined),
              close: jest.fn().mockResolvedValue(undefined),
              pause: jest.fn().mockResolvedValue(undefined),
              resume: jest.fn().mockResolvedValue(undefined),
              obliterate: jest.fn().mockResolvedValue(undefined),
              getRepeatableJobs: jest.fn().mockResolvedValue([]),
              getJobCounts: jest.fn().mockResolvedValue({}),
              removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
            },
          });
        }
        return {
          module: class NoopQueueModule {},
          providers,
          exports: providers.map((p) => p.provide),
        };
      }),
    },
  };
});

// Mock @nestjs/typeorm: forRoot → global no-op providing a mock DataSource;
// forFeature → provides mock repository tokens for each entity. This prevents
// any real PostgreSQL connection while letting every @InjectRepository and
// @InjectDataSource dependency resolve.
//
// TypeOrmModule is mocked as a CLASS (not a plain object) because feature
// modules like UsersModule do `exports: [UsersService, TypeOrmModule]` — they
// re-export the TypeOrmModule class so other modules get access to the
// repository providers. NestJS matches the exported class against the `module`
// property of the DynamicModule returned by forFeature(), so they must be the
// same class.
jest.mock('@nestjs/typeorm', () => {
  const real = jest.requireActual('@nestjs/typeorm');
  const { DataSource } = jest.requireActual('typeorm');
  const mockRepo = () => ({
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockReturnValue({}),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    remove: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
  });
  const mockDataSource = {
    query: jest.fn().mockResolvedValue([{ total: '0' }]),
    isInitialized: false,
    destroy: jest.fn().mockResolvedValue(undefined),
  };

  class TypeOrmModuleMock {
    static forRoot = jest.fn(() => ({
      module: TypeOrmModuleMock,
      global: true,
      providers: [{ provide: DataSource, useValue: mockDataSource }],
      exports: [DataSource],
    }));
    static forRootAsync = jest.fn(() => ({
      module: TypeOrmModuleMock,
      providers: [],
      exports: [],
    }));
    static forFeature = jest.fn((entities: Array<new (...args: unknown[]) => unknown>) => ({
      module: TypeOrmModuleMock,
      providers: entities.map((e: new (...args: unknown[]) => unknown) => ({
        provide: real.getRepositoryToken(e),
        useFactory: mockRepo,
      })),
      exports: entities.map((e: new (...args: unknown[]) => unknown) => real.getRepositoryToken(e)),
    }));
  }

  return {
    ...real,
    TypeOrmModule: TypeOrmModuleMock,
  };
});

// ── Real imports (feature modules are imported UNCHANGED) ─────────────────────

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';

import { EventsModule } from './modules/events/events.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { AuditModule } from './modules/audit/audit.module';
import { GlobalConfigModule } from './modules/global-config/global-config.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BrokerModule } from './modules/broker/broker.module';
import { RiskModule } from './modules/risk/risk.module';
import { ExecutionModule } from './modules/execution/execution.module';
import { TradingModule } from './modules/trading/trading.module';
import { StrategyModule } from './modules/strategy/strategy.module';
import { AiModule } from './modules/ai/ai.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { AiEngineClientModule } from './modules/ai-engine-client/ai-engine-client.module';
import { PerformanceFeesModule } from './modules/performance-fees/performance-fees.module';
import { BrokerReconciliationModule } from './modules/broker-reconciliation/broker-reconciliation.module';
import { PerformanceBillingModule } from './modules/performance-billing/performance-billing.module';

// Service classes used by the DI-resolution assertions below. Imported here
// (rather than via require() inside the tests) so that ESM static imports are
// used consistently. The jest.mock() factories above are hoisted above these
// imports by babel-jest, so the mocks are in place before any module resolves.
import { ExecutionService } from './modules/execution/execution.service';
import { CredentialEncryptionService } from './modules/broker/services/credential-encryption.service';
import { BrokerService } from './modules/broker/broker.service';
import { BrokerAdapterRegistry } from './modules/broker/adapters/broker-adapter.registry';
import { MetaTraderAdapter } from './modules/broker/adapters/metatrader.adapter';
import { PaperBrokerAdapter } from './modules/broker/adapters/paper-broker.adapter';
import type { MetaApiClientService } from './modules/broker/services/metaapi-client.service';

/**
 * The real feature-module graph — identical to AppModule's import list.
 * Kept in a function so it is obvious it must mirror app.module.ts.
 */
function realFeatureModules() {
  return [
    EventsModule,
    AuthModule,
    UsersModule,
    AuditModule,
    GlobalConfigModule,
    // Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
    // SubscriptionsModule is no longer imported — performance-fee-only model.
    PaymentsModule,
    NotificationsModule,
    BrokerModule,
    RiskModule,
    ExecutionModule,
    TradingModule,
    StrategyModule,
    AiModule,
    RealtimeModule,
    HealthModule,
    MarketDataModule,
    AiEngineClientModule,
    PerformanceFeesModule,
    BrokerReconciliationModule,
    PerformanceBillingModule,
  ];
}

describe('Runtime bootstrap smoke test (Sprint 20)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    // Required env vars for Joi validation (validation.schema.ts). These are
    // test-only placeholders — no real secrets. DB/Redis connections are mocked
    // so these values are never used to connect anywhere.
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long!!';
    process.env.COOKIE_SECRET = 'test_cookie_secret_16+';
    process.env.BROKER_ENCRYPTION_KEY = 'test_broker_encryption_key_32_chars!!';
    process.env.DB_HOST = 'localhost';
    process.env.DB_NAME = 'irexpro_test';
    process.env.DB_USER = 'irexpro';
    process.env.DB_PASSWORD = 'test_db_password';
    process.env.NESTJS_INTERNAL_API_KEY = 'test_internal_api_key';

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
          validationSchema,
          validationOptions: { abortEarly: false },
        }),
        // The mocked forRoot/registerQueue are no-ops; they exist only so the
        // feature modules' @Module imports resolve.
        BullModule.forRoot({ connection: { host: 'localhost', port: 6379 } }),
        TypeOrmModule.forRoot({ type: 'sqlite', database: ':memory:' }),
        ...realFeatureModules(),
      ],
    }).compile();
    // init() triggers onModuleInit lifecycle hooks (e.g. BrokerModule registers
    // its adapters), which compile() alone does not.
    await moduleRef.init();
  }, 60000);

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('compiles the full real feature-module graph without DI errors', () => {
    // If any provider/export is missing (the Sprint 20 CredentialEncryptionService
    // regression), Test.createTestingModule throws during compile() and this
    // test never reaches the assertion. The assertion is a sanity check that the
    // module reference was actually built.
    expect(moduleRef).toBeDefined();
  });

  it('ExecutionService is resolvable — CredentialEncryptionService is available in the ExecutionModule context', () => {
    // This is the exact resolution that failed on staging. Importing the real
    // ExecutionModule means NestJS must resolve every constructor dependency of
    // ExecutionService, including CredentialEncryptionService at index [4].
    // Before the Sprint 20 fix, BrokerModule did not export
    // CredentialEncryptionService, so this resolution threw:
    //   "Nest can't resolve dependencies of the ExecutionService
    //    (..., CredentialEncryptionService at index [4], ...)"

    const executionService = moduleRef.get(ExecutionService);
    expect(executionService).toBeDefined();
    expect(typeof executionService.executeTrade).toBe('function');
  });

  it('CredentialEncryptionService is a single shared instance owned by BrokerModule', () => {
    // Defence-in-depth: confirms the service is NOT duplicated across modules.
    // BrokerService and ExecutionService should receive the same instance.

    const brokerService = moduleRef.get(BrokerService);
    const encryptionFromBroker = (brokerService as unknown as { encryptionService: unknown })
      .encryptionService;
    const encryptionFromModule = moduleRef.get(CredentialEncryptionService);
    expect(encryptionFromBroker).toBe(encryptionFromModule);
  });

  it('BrokerAdapterRegistry is resolvable and has both adapters registered (onModuleInit ran)', () => {
    const registry = moduleRef.get(BrokerAdapterRegistry);
    expect(registry).toBeDefined();
    // BrokerModule.onModuleInit registers MetaTrader + PaperBroker adapters.

    expect(() =>
      registry.getAdapter(new MetaTraderAdapter({} as unknown as MetaApiClientService).brokerId),
    ).not.toThrow();
    expect(() => registry.getAdapter(new PaperBrokerAdapter().brokerId)).not.toThrow();
  });
});
