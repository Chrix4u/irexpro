import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { BrokerOAuthTokenLifecycleService } from './broker-oauth-token-lifecycle.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { CtraderOAuthTokens } from '../adapters/ctrader/ctrader-oauth';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { BrokerCredentialStatus } from '../authorization/broker-credential-status';
import { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';

/**
 * Sprint 56 correction round 2 (architect finding 3) — concurrent OAuth
 * refresh protection proven against a REAL PostgreSQL store.
 *
 * The unit concurrency suite proves the lease/generation-CAS mechanics
 * against an in-memory conditional-UPDATE double; THIS suite re-proves the
 * architect-critical races against real row-level locking and affected-rows
 * semantics — the exact guarantee that must hold ACROSS API replicas:
 *
 * - N simultaneous ensureFreshTokens for one near-expiry connection →
 *   EXACTLY ONE provider refresh, every caller adopts the winner's pair,
 *   the stored row ends ROTATED with generation+1 and a free lease, and
 *   exactly ONE rotation audit event is recorded;
 * - a second service instance starting mid-flight WAITS and adopts the
 *   first instance's persisted result (provider count stays 1).
 *
 * Runs ONLY via test/jest-pg.json (excluded from the unit run).
 */
describe('BrokerOAuthTokenLifecycleService concurrent refresh — real PostgreSQL (architect finding 3)', () => {
  const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!!';
  const REFRESH_TOKEN = 'original-refresh-token';
  const NEW_ACCESS_TOKEN = 'NEW-ACCESS-TOKEN-PG';
  const NEW_REFRESH_TOKEN = 'NEW-REFRESH-TOKEN-PG';
  const USER = '11111111-1111-1111-1111-111111111111';
  const CONN = '44444444-4444-4444-4444-444444444444';

  let dataSource: DataSource;
  let connectionRepo: Repository<BrokerConnection>;
  let encryption: CredentialEncryptionService;
  let ctraderClient: { refreshAccessToken: jest.Mock };
  let audit: { log: jest.Mock };

  /** One simulated API replica sharing the repo + provider mock. */
  const makeInstance = (): BrokerOAuthTokenLifecycleService =>
    new (class extends BrokerOAuthTokenLifecycleService {
      constructor() {
        super(
          connectionRepo,
          encryption,
          ctraderClient as unknown as CTraderClientService,
          audit as unknown as AuditService,
        );
        this.leaseMs = 5_000;
        this.waitBudgetMs = 5_000;
        this.pollIntervalMs = 5;
      }
    })();

  const seed = async (): Promise<void> => {
    await connectionRepo.save(
      connectionRepo.create({
        id: CONN,
        userId: USER,
        brokerId: 'ctrader',
        brokerName: 'cTrader',
        accountType: 'DEMO',
        credentialStatus: BrokerCredentialStatus.VERIFIED,
        credentialGeneration: 0,
        encryptedCredentials: 'stale-ciphertext',
        credentialIv: 'iv',
        credentialTag: 'tag',
        encryptionKeyId: 'env-key-v1',
      } as Partial<BrokerConnection>),
    );
  };

  const connectionFixture = (): BrokerConnection =>
    ({
      id: CONN,
      userId: USER,
      brokerId: 'ctrader',
      accountId: '1234567',
      credentialStatus: BrokerCredentialStatus.VERIFIED,
      credentialGeneration: 0,
    }) as unknown as BrokerConnection;

  const staleCredentials = (): DecryptedBrokerCredentials => ({
    apiKey: 'original-access-token',
    accountId: '1234567',
    additionalParams: {
      refreshToken: REFRESH_TOKEN,
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(), // expired
    },
  });

  const refreshedAuditCount = (): number =>
    audit.log.mock.calls.filter((c) => c[0].action === AuditAction.BROKER_OAUTH_TOKENS_REFRESHED)
      .length;

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

    // DDL mirrors broker.broker_connections including the Sprint-56 round-2
    // refresh-protection columns (migration 1753850000000).
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
        "credential_generation" integer NOT NULL DEFAULT 0,
        "credential_refresh_lease_expires_at" timestamptz NULL,
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
        CONSTRAINT "pk_bc_pg" PRIMARY KEY ("id"),
        CONSTRAINT "chk_bc_credential_status_pg"
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
    await seed();
    encryption = new CredentialEncryptionService({
      get: (key: string) => (key === 'BROKER_ENCRYPTION_KEY' ? TEST_ENCRYPTION_KEY : ''),
    } as unknown as ConfigService);
    ctraderClient = { refreshAccessToken: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
  });

  it('20 simultaneous callers → EXACTLY ONE provider refresh, all adopt the winner (real row locking)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const service = makeInstance();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.ensureFreshTokens(connectionFixture(), staleCredentials()),
      ),
    );

    // EXACTLY ONE provider refresh for the stale generation.
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    // Every caller resolved with the winner's identical pair.
    expect(results).toHaveLength(20);
    for (const result of results) {
      expect(result.apiKey).toBe(NEW_ACCESS_TOKEN);
      expect(result.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
      expect(result.additionalParams?.accessTokenExpiresAt).toBe(
        results[0].additionalParams?.accessTokenExpiresAt,
      );
    }
    // Stored row: ROTATED, generation advanced exactly once, lease free.
    const row = await connectionRepo.findOne({ where: { id: CONN } });
    expect(row).not.toBeNull();
    expect(row!.credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(row!.credentialGeneration).toBe(1);
    expect(row!.credentialRefreshLeaseExpiresAt).toBeNull();
    // A fresh decrypt of the stored bundle equals the returned pair.
    const decrypted = encryption.decrypt({
      ciphertext: row!.encryptedCredentials!,
      iv: row!.credentialIv!,
      tag: row!.credentialTag!,
      keyId: row!.encryptionKeyId!,
    });
    expect(decrypted.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(decrypted.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
    // Exactly ONE rotation audit event for this credential generation.
    expect(refreshedAuditCount()).toBe(1);
  });

  it('second instance starting mid-flight WAITS and adopts the first instance result (provider count stays 1)', async () => {
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    ctraderClient.refreshAccessToken.mockImplementation(async (): Promise<CtraderOAuthTokens> => {
      await delay(50);
      return {
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresIn: 2_628_000,
      };
    });
    const instanceA = makeInstance();
    const instanceB = makeInstance();

    const promiseA = instanceA.ensureFreshTokens(connectionFixture(), staleCredentials());
    await delay(25); // A is mid-flight inside its provider refresh
    const promiseB = instanceB.ensureFreshTokens(connectionFixture(), staleCredentials());
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(resultA.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(resultB.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(resultB.additionalParams?.accessTokenExpiresAt).toBe(
      resultA.additionalParams?.accessTokenExpiresAt,
    );
    const row = await connectionRepo.findOne({ where: { id: CONN } });
    expect(row!.credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(row!.credentialGeneration).toBe(1);
    expect(row!.credentialRefreshLeaseExpiresAt).toBeNull();
    expect(refreshedAuditCount()).toBe(1);
  });
});
