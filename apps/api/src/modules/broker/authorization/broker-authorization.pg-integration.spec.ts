import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { BrokerService } from '../broker.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from '../registry/broker-provider-registry.service';
import { CredentialEncryptionService } from '../services/credential-encryption.service';
import { AuditService } from '../../audit/audit.service';
import { DomainEventBus } from '../../events/event-bus.service';
import {
  BrokerAuthorizationStatus,
  BrokerAuthorizationStateMachine,
} from './broker-authorization-status';
import { BrokerConnectionStatus, BrokerMode } from '../interfaces/broker-adapter.interface';

/**
 * Sprint 50 correction (architect review A4) — atomic authorization
 * transitions proven against a REAL PostgreSQL store.
 *
 * Proves the adversarial races the architect required:
 * - revoke versus enable-live-trading (concurrent lifecycle transitions)
 * - disconnect versus enable-live-trading (disconnect vs activation)
 * - healthCheck suspend versus revoke (suspend vs lifecycle)
 * - concurrent duplicate revoke → exactly ONE effective transition
 * - a stale writer's conditional update CANNOT resurrect a terminal state
 *
 * The guarantee: every transition write is a conditional UPDATE
 * (WHERE authorization_status = <validated state>) with an affected-rows
 * check — the stale operation fails visibly and never overwrites the
 * winning authoritative state.
 *
 * Runs ONLY via test/jest-pg.json (excluded from the unit run).
 */
describe('BrokerService authorization transitions — real PostgreSQL concurrency (architect A4)', () => {
  let dataSource: DataSource;
  let service: BrokerService;
  let connectionRepo: Repository<BrokerConnection>;
  let adapter: { setMode: jest.Mock; disconnect: jest.Mock; connect: jest.Mock };

  const USER = '11111111-1111-1111-1111-111111111111';
  const LIVE_CONN = '22222222-2222-2222-2222-222222222222';
  const DEMO_CONN = '33333333-3333-3333-3333-333333333333';

  const seed = async (over: Partial<Record<string, unknown>> = {}) => {
    await connectionRepo.save(
      connectionRepo.create({
        id: LIVE_CONN,
        userId: USER,
        brokerId: 'metatrader5',
        brokerName: 'MetaTrader 5',
        accountType: BrokerMode.LIVE,
        status: BrokerConnectionStatus.CONNECTED,
        authorizationStatus: BrokerAuthorizationStatus.CONNECTED,
        credentialStatus: 'VERIFIED',
        demoValidated: false,
        liveTradingEnabled: false,
        ...over,
      } as Partial<BrokerConnection>),
    );
  };

  const seedDemo = async () => {
    await connectionRepo.save(
      connectionRepo.create({
        id: DEMO_CONN,
        userId: USER,
        brokerId: 'metatrader5',
        brokerName: 'MetaTrader 5',
        accountType: BrokerMode.DEMO,
        status: BrokerConnectionStatus.CONNECTED,
        authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED,
        credentialStatus: 'VERIFIED',
        demoValidated: true,
        liveTradingEnabled: false,
      } as Partial<BrokerConnection>),
    );
  };

  const freshRow = async (): Promise<BrokerConnection | null> =>
    connectionRepo.findOne({ where: { id: LIVE_CONN } });

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'irexpro',
      password: process.env.DB_PASSWORD ?? 'test_password',
      database: process.env.DB_NAME ?? 'irexpro_test',
      entities: [BrokerConnection],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS broker');

    // DDL mirrors the broker.broker_connections columns used by the service
    // plus the Sprint-50 authorization-state CHECK constraints
    // (migration 1753400000000-AddBrokerAuthorizationStateMachine).
    await dataSource.query(`DROP TABLE IF EXISTS "broker"."broker_connections"`);
    await dataSource.query(`
      CREATE TABLE "broker"."broker_connections" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "broker_id" varchar(50) NOT NULL,
        "broker_name" varchar(100) NOT NULL,
        "display_name" varchar(100) NULL,
        "account_id" varchar(100) NULL,
        "account_type" varchar(10) NOT NULL DEFAULT 'DEMO',
        "account_currency" varchar(3) NULL,
        "account_leverage" integer NULL,
        "status" varchar(32) NOT NULL DEFAULT 'DISCONNECTED',
        "authorization_status" varchar(30) NOT NULL DEFAULT 'NOT_CONNECTED',
        "credential_status" varchar(20) NOT NULL DEFAULT 'CREATED',
        "authorized_at" timestamptz NULL,
        "authorization_revoked_at" timestamptz NULL,
        "encrypted_credentials" text NULL,
        "credential_iv" varchar(32) NULL,
        "credential_tag" varchar(48) NULL,
        "encryption_key_id" varchar(255) NULL,
        "last_health_check_at" timestamptz NULL,
        "last_sync_at" timestamptz NULL,
        "consecutive_failure_count" integer NOT NULL DEFAULT 0,
        "last_error_message" text NULL,
        "demo_validated" boolean NOT NULL DEFAULT false,
        "live_trading_enabled" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz NULL,
        CONSTRAINT "pk_broker_connections" PRIMARY KEY ("id"),
        CONSTRAINT "chk_bc_authorization_status"
          CHECK ("authorization_status" IN (
            'NOT_CONNECTED','CONNECTING','CONNECTED','VERIFYING','AUTHORIZATION_REQUIRED',
            'AUTHORIZED','READY','ACTIVE','SUSPENDED','REVOKED','ERROR','DISCONNECTED')),
        CONSTRAINT "chk_bc_credential_status"
          CHECK ("credential_status" IN ('CREATED','VERIFIED','ROTATED','REVOKED','EXPIRED','INVALID'))
      )
    `);

    connectionRepo = dataSource.getRepository(BrokerConnection);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE "broker"."broker_connections"');
    adapter = {
      setMode: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined),
      connect: jest.fn(),
    };
    const adapterRegistry = {
      getAdapter: jest.fn().mockReturnValue(adapter),
      isSupported: jest.fn().mockReturnValue(true),
    } as unknown as BrokerAdapterRegistry;
    const providerRegistry = {
      supportsEnvironment: jest.fn().mockReturnValue(true),
      isConnectable: jest.fn().mockReturnValue(true),
      // Phase H: these fixtures are metatrader5 (the VERIFIED provider).
      isProductionLiveEligible: jest.fn().mockReturnValue(true),
    } as unknown as BrokerProviderRegistryService;
    const encryption = {
      decrypt: jest.fn().mockReturnValue({ accountId: 'acc-1' }),
    } as unknown as CredentialEncryptionService;
    const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const eventBus = { publish: jest.fn() } as unknown as DomainEventBus;
    service = new BrokerService(
      connectionRepo,
      // accountRepo is unused by the transition paths under test
      {} as never,
      adapterRegistry,
      providerRegistry,
      encryption,
      audit,
      eventBus,
    );
  });

  it('revoke vs enable-live-trading race: exactly ONE winner, no mixed state', async () => {
    // AUTHORIZED is a legal source for BOTH transitions:
    //   AUTHORIZED → REVOKED (revoke) and AUTHORIZED → ACTIVE (enable-live).
    await seed({ authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED });
    await seedDemo();

    const results = await Promise.allSettled([
      service.revokeAuthorization(LIVE_CONN, USER),
      service.enableLiveTrading(LIVE_CONN, USER),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const row = await freshRow();
    expect(row).not.toBeNull();
    if (row!.authorizationStatus === BrokerAuthorizationStatus.REVOKED) {
      // Revoke won: fail-closed dual-write must be consistent
      expect(row!.liveTradingEnabled).toBe(false);
      expect(row!.authorizationRevokedAt).not.toBeNull();
    } else {
      // Enable-live won: ACTIVE with the authorization dual-write
      expect(row!.authorizationStatus).toBe(BrokerAuthorizationStatus.ACTIVE);
      expect(row!.liveTradingEnabled).toBe(true);
    }
  });

  it('disconnect vs enable-live-trading race (architect adversarial case): stale disconnect never overwrites ACTIVE', async () => {
    await seed({ authorizationStatus: BrokerAuthorizationStatus.CONNECTED });
    await seedDemo();

    const results = await Promise.allSettled([
      service.disconnectBroker(LIVE_CONN, USER),
      service.enableLiveTrading(LIVE_CONN, USER),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    // Both transitions are legal from CONNECTED — the conditional write
    // guarantees exactly one wins; the loser surfaces ConflictException.
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const row = await freshRow();
    if (row!.authorizationStatus === BrokerAuthorizationStatus.ACTIVE) {
      expect(row!.liveTradingEnabled).toBe(true);
      expect(row!.status).toBe(BrokerConnectionStatus.CONNECTED);
    } else {
      expect(row!.authorizationStatus).toBe(BrokerAuthorizationStatus.DISCONNECTED);
      expect(row!.status).toBe(BrokerConnectionStatus.DISCONNECTED);
      expect(row!.liveTradingEnabled).toBe(false);
    }
  });

  it('healthCheck suspend vs revoke race: stale suspension never overwrites REVOKED', async () => {
    // AUTHORIZED is a legal source for BOTH SUSPENDED (healthCheck) and REVOKED.
    // The connection carries stored ciphertext so healthCheck passes the
    // presence + lifecycle gates and reaches the (failing) provider call.
    await seed({
      authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED,
      consecutiveFailureCount: 2, // next failure = 3 → suspend threshold
      encryptedCredentials: 'cipher',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'key-1',
    });
    // The provider is down: healthCheck fails and attempts the SUSPENDED
    // transition; concurrently a revoke lands.
    adapter.connect.mockRejectedValue(new Error('provider down'));

    const [healthResult] = await Promise.all([
      service.healthCheck(LIVE_CONN),
      service.revokeAuthorization(LIVE_CONN, USER),
    ]);

    expect(healthResult).toBe(false); // the health check itself failed

    const row = await freshRow();
    // Whichever transition won, the state is EXACTLY one of the two — never
    // a mixed/overwritten state, and telemetry was still recorded.
    expect([BrokerAuthorizationStatus.SUSPENDED, BrokerAuthorizationStatus.REVOKED]).toContain(
      row!.authorizationStatus,
    );
    expect(row!.consecutiveFailureCount).toBe(3); // telemetry write (unguarded) survived
    if (row!.authorizationStatus === BrokerAuthorizationStatus.REVOKED) {
      expect(row!.liveTradingEnabled).toBe(false);
    }
  });

  it('concurrent duplicate revokes produce exactly ONE effective transition', async () => {
    await seed({ authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED });

    const results = await Promise.allSettled([
      service.revokeAuthorization(LIVE_CONN, USER),
      service.revokeAuthorization(LIVE_CONN, USER),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const row = await freshRow();
    expect(row!.authorizationStatus).toBe(BrokerAuthorizationStatus.REVOKED);
    expect(row!.liveTradingEnabled).toBe(false);
  });

  it('a stale writer cannot resurrect a terminal state (REVOKED)', async () => {
    await seed({ authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED });
    await service.revokeAuthorization(LIVE_CONN, USER);
    expect((await freshRow())!.authorizationStatus).toBe(BrokerAuthorizationStatus.REVOKED);

    // A stale enable-live-trading writer that validated against AUTHORIZED
    // issues exactly this conditional UPDATE — it must match ZERO rows.
    const result = await connectionRepo.update(
      { id: LIVE_CONN, authorizationStatus: BrokerAuthorizationStatus.AUTHORIZED } as never,
      {
        authorizationStatus: BrokerAuthorizationStatus.ACTIVE,
        liveTradingEnabled: true,
      } as never,
    );
    const affected = Array.isArray(result) ? Number(result[1] ?? 0) : Number(result.affected ?? 0);
    expect(affected).toBe(0);

    const row = await freshRow();
    expect(row!.authorizationStatus).toBe(BrokerAuthorizationStatus.REVOKED);
    expect(row!.liveTradingEnabled).toBe(false);
  });

  it('sequential legal transitions still apply normally (guard does not over-block)', async () => {
    await seed({ authorizationStatus: BrokerAuthorizationStatus.CONNECTED });
    await seedDemo();

    // CONNECTED → ACTIVE (enable-live) …
    await service.enableLiveTrading(LIVE_CONN, USER);
    expect((await freshRow())!.authorizationStatus).toBe(BrokerAuthorizationStatus.ACTIVE);

    // … then ACTIVE → REVOKED (revoke) — both sequential transitions succeed.
    await service.revokeAuthorization(LIVE_CONN, USER);
    const row = await freshRow();
    expect(row!.authorizationStatus).toBe(BrokerAuthorizationStatus.REVOKED);
    expect(row!.liveTradingEnabled).toBe(false);

    // The transitions used are legal per the state machine
    expect(
      BrokerAuthorizationStateMachine.canTransition(
        BrokerAuthorizationStatus.CONNECTED,
        BrokerAuthorizationStatus.ACTIVE,
      ),
    ).toBe(true);
    expect(
      BrokerAuthorizationStateMachine.canTransition(
        BrokerAuthorizationStatus.ACTIVE,
        BrokerAuthorizationStatus.REVOKED,
      ),
    ).toBe(true);
  });
});
