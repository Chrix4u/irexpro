import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BrokerOAuthTokenLifecycleService } from './broker-oauth-token-lifecycle.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { CtraderOAuthTokens } from '../adapters/ctrader/ctrader-oauth';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { BrokerCredentialStatus } from '../authorization/broker-credential-status';
import { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';

const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!!';
const ACCESS_TOKEN = 'original-access-token';
const REFRESH_TOKEN = 'original-refresh-token';
const NEW_ACCESS_TOKEN = 'NEW-ACCESS-TOKEN-XYZ';
const NEW_REFRESH_TOKEN = 'NEW-REFRESH-TOKEN-ABC';
const CONN_ID = 'conn-1';
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── In-memory BrokerConnection repository with REAL conditional-UPDATE ─────
//
// Two "simulated service instances" (two BrokerOAuthTokenLifecycleService
// objects — as two API replicas would be) share ONE repository whose rows are
// genuine shared mutable state: the lease claim, the generation CAS and the
// affected-rows semantics are evaluated for real, not mocked by call counts.
// The pg-integration suite re-proves the same guarantees against real
// PostgreSQL; this sandbox has no DB driver.

const COLUMN_OF: Record<string, string> = {
  id: 'id',
  userId: 'user_id',
  brokerId: 'broker_id',
  brokerName: 'broker_name',
  accountId: 'account_id',
  credentialStatus: 'credential_status',
  credentialGeneration: 'credential_generation',
  credentialRefreshLeaseExpiresAt: 'credential_refresh_lease_expires_at',
  credentialRefreshLeaseOwner: 'credential_refresh_lease_owner',
  encryptedCredentials: 'encrypted_credentials',
  credentialIv: 'credential_iv',
  credentialTag: 'credential_tag',
  encryptionKeyId: 'encryption_key_id',
  lastErrorMessage: 'last_error_message',
};
const PROPERTY_OF: Record<string, string> = Object.fromEntries(
  Object.entries(COLUMN_OF).map(([prop, col]) => [col, prop]),
);

interface FakeOp {
  kind: 'repo-update' | 'qb-update';
  set: Record<string, unknown>;
  where: string;
  params: Record<string, unknown>;
  affected: number;
}

const eqValue = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  return a === b;
};

const lteValue = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date && b instanceof Date) return a.getTime() <= b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a <= b;
  throw new Error(`fake repo cannot compare ${typeof a} <= ${typeof b}`);
};

const cloneValue = (value: unknown): unknown =>
  value instanceof Date ? new Date(value.getTime()) : value;

class FakeQueryBuilder {
  private setPatch: Record<string, unknown> = {};
  private clauses: string[] = [];
  private params: Record<string, unknown> = {};

  constructor(private readonly repo: InMemoryBrokerConnectionRepo) {}

  update(): this {
    return this;
  }

  set(patch: Record<string, unknown>): this {
    this.setPatch = { ...patch };
    return this;
  }

  where(clause: string, params: Record<string, unknown> = {}): this {
    this.clauses.push(clause);
    this.params = { ...this.params, ...params };
    return this;
  }

  andWhere(clause: string, params: Record<string, unknown> = {}): this {
    return this.where(clause, params);
  }

  async execute(): Promise<{ affected: number }> {
    let affected = 0;
    for (const row of this.repo.rows.values()) {
      if (this.matches(row)) {
        this.repo.applySet(row, this.setPatch);
        affected += 1;
      }
    }
    this.repo.ops.push({
      kind: 'qb-update',
      set: { ...this.setPatch },
      where: this.clauses.join(' AND '),
      params: { ...this.params },
      affected,
    });
    return { affected };
  }

  private matches(row: Record<string, unknown>): boolean {
    for (const clause of this.clauses) {
      if (!this.evaluate(clause, row)) return false;
    }
    return true;
  }

  private evaluate(clause: string, row: Record<string, unknown>): boolean {
    for (const token of clause.split(/\s+AND\s+/i)) {
      const trimmed = token.trim();
      if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
        const any = trimmed
          .slice(1, -1)
          .split(/\s+OR\s+/i)
          .some((inner) => this.predicate(inner.trim(), row));
        if (!any) return false;
        continue;
      }
      if (!this.predicate(trimmed, row)) return false;
    }
    return true;
  }

  private predicate(raw: string, row: Record<string, unknown>): boolean {
    let match = /^(\w+)\s*=\s*:(\w+)$/.exec(raw);
    if (match) return eqValue(row[match[1]], this.params[match[2]]);
    match = /^(\w+)\s*<=\s*:(\w+)$/.exec(raw);
    if (match) return lteValue(row[match[1]], this.params[match[2]]);
    match = /^(\w+)\s+IS\s+NULL$/i.exec(raw);
    if (match) return row[match[1]] === null || row[match[1]] === undefined;
    throw new Error(`fake repo cannot evaluate WHERE predicate: "${raw}"`);
  }
}

class InMemoryBrokerConnectionRepo {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly ops: FakeOp[] = [];

  seed(fixture: Record<string, unknown>): void {
    const row: Record<string, unknown> = {};
    for (const [prop, value] of Object.entries(fixture)) {
      row[COLUMN_OF[prop] ?? prop] = cloneValue(value);
    }
    this.rows.set(String(row['id']), row);
  }

  setColumns(id: string, columns: Record<string, unknown>): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    for (const [col, value] of Object.entries(columns)) {
      row[col] = cloneValue(value);
    }
  }

  findOne(criteria: { where: { id: string } }): Record<string, unknown> | null {
    const row = this.rows.get(criteria.where.id);
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const [col, value] of Object.entries(row)) {
      out[PROPERTY_OF[col] ?? col] = cloneValue(value);
    }
    return out;
  }

  update(id: string, patch: Record<string, unknown>): Promise<{ affected: number }> {
    const row = this.rows.get(id);
    const set = { ...patch };
    let affected = 0;
    if (row) {
      this.applySet(row, set);
      affected = 1;
    }
    this.ops.push({ kind: 'repo-update', set, where: `id = ${id}`, params: {}, affected });
    return Promise.resolve({ affected });
  }

  createQueryBuilder(): FakeQueryBuilder {
    return new FakeQueryBuilder(this);
  }

  applySet(row: Record<string, unknown>, set: Record<string, unknown>): void {
    for (const [prop, value] of Object.entries(set)) {
      row[COLUMN_OF[prop] ?? prop] = cloneValue(value);
    }
  }
}

/** One simulated API replica: its own service instance, shared repo/provider. */
const makeInstance = (
  repo: InMemoryBrokerConnectionRepo,
  encryption: CredentialEncryptionService,
  client: { refreshAccessToken: jest.Mock },
  audit: { log: jest.Mock },
  seams: { leaseMs?: number; waitBudgetMs?: number; pollIntervalMs?: number } = {},
): BrokerOAuthTokenLifecycleService => {
  const instance = new (class extends BrokerOAuthTokenLifecycleService {
    constructor() {
      super(
        repo as unknown as Repository<BrokerConnection>,
        encryption,
        client as unknown as CTraderClientService,
        audit as unknown as AuditService,
        // Round 6 live-execution completion (§1b): authority seams (mocked).
        {
          bumpGeneration: jest.fn().mockResolvedValue(2),
        } as unknown as import('../../execution-authority/trading-authority.service').TradingAuthorityService,
        {
          invalidateUserNewExposureAuthority: jest
            .fn()
            .mockResolvedValue({ invalidatedGrants: 0, revokedConfirmations: 0 }),
        } as unknown as import('../../execution-authority/grant-invalidation.service').GrantInvalidationService,
      );
      if (seams.leaseMs !== undefined) this.leaseMs = seams.leaseMs;
      if (seams.waitBudgetMs !== undefined) this.waitBudgetMs = seams.waitBudgetMs;
      if (seams.pollIntervalMs !== undefined) this.pollIntervalMs = seams.pollIntervalMs;
    }
  })();
  return instance;
};

describe('BrokerOAuthTokenLifecycleService concurrency (Sprint 56 correction round 2 — architect finding 3)', () => {
  let repo: InMemoryBrokerConnectionRepo;
  let encryption: CredentialEncryptionService;
  let ctraderClient: { refreshAccessToken: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new InMemoryBrokerConnectionRepo();
    repo.seed({
      id: CONN_ID,
      userId: 'user-1',
      brokerId: 'ctrader',
      accountId: '1234567',
      credentialStatus: BrokerCredentialStatus.VERIFIED,
      credentialGeneration: 0,
      encryptedCredentials: 'stale-ciphertext',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'env-key-v1',
    });
    encryption = new CredentialEncryptionService({
      get: (key: string) => (key === 'BROKER_ENCRYPTION_KEY' ? TEST_ENCRYPTION_KEY : ''),
    } as unknown as ConfigService);
    ctraderClient = { refreshAccessToken: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
  });

  const connectionFixture = (): BrokerConnection =>
    ({
      id: CONN_ID,
      userId: 'user-1',
      brokerId: 'ctrader',
      accountId: '1234567',
      credentialStatus: BrokerCredentialStatus.VERIFIED,
      credentialGeneration: 0,
    }) as unknown as BrokerConnection;

  const staleCredentials = (): DecryptedBrokerCredentials => ({
    apiKey: ACCESS_TOKEN,
    accountId: '1234567',
    additionalParams: {
      refreshToken: REFRESH_TOKEN,
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(), // expired
    },
  });

  const storedRow = (): Record<string, unknown> => repo.findOne({ where: { id: CONN_ID } })!;

  const decryptStored = (): DecryptedBrokerCredentials =>
    encryption.decrypt({
      ciphertext: storedRow().encryptedCredentials as string,
      iv: storedRow().credentialIv as string,
      tag: storedRow().credentialTag as string,
      keyId: storedRow().encryptionKeyId as string,
    });

  const refreshedAuditCount = (): number =>
    audit.log.mock.calls.filter((c) => c[0].action === AuditAction.BROKER_OAUTH_TOKENS_REFRESHED)
      .length;

  const successfulPersists = (): FakeOp[] =>
    repo.ops.filter((op) => 'encryptedCredentials' in op.set && op.affected === 1);

  /**
   * Lease-claim ops that LANDED (affected 1): each minted its own owner
   * token; failed claim attempts (loser-loop polls) never wrote anything.
   */
  const claimOps = (): FakeOp[] =>
    repo.ops.filter(
      (op) => op.set.credentialRefreshLeaseExpiresAt instanceof Date && op.affected === 1,
    );

  // ─── 1. Twenty simultaneous callers, one connection, one stale generation ──

  it('20 simultaneous ensureFreshTokens → EXACTLY ONE provider refresh, everyone adopts the winner', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const service = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        // Each caller carries its own decrypted copy of the SAME stale pair.
        service.ensureFreshTokens(connectionFixture(), staleCredentials()),
      ),
    );

    // EXACTLY ONE provider refresh for one stale credential generation.
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    // ALL 20 callers RESOLVED successfully (no rejections, no conflicts).
    expect(results).toHaveLength(20);
    // Every caller received the WINNER's new pair — byte-identical across
    // all 20 results (access token, refresh token, expiry) ...
    for (const result of results) {
      expect(result.apiKey).toBe(NEW_ACCESS_TOKEN);
      expect(result.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
      expect(result.additionalParams?.accessTokenExpiresAt).toBe(
        results[0].additionalParams?.accessTokenExpiresAt,
      );
    }
    // ... and identical to a FRESH decrypt of the stored row.
    const stored = decryptStored();
    expect(stored.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(stored.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
    expect(stored.additionalParams?.accessTokenExpiresAt).toBe(
      results[0].additionalParams?.accessTokenExpiresAt,
    );
    // Stored row: ROTATED, generation advanced exactly once, lease free
    // (BOTH columns — the persist clears the owner token it matched).
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(storedRow().credentialGeneration).toBe(1);
    expect(storedRow().credentialRefreshLeaseExpiresAt).toBeNull();
    expect(storedRow().credentialRefreshLeaseOwner).toBeNull();
    // NO INVALID transition ever happened (no op ever wrote INVALID).
    expect(repo.ops.map((op) => op.set.credentialStatus)).not.toContain(
      BrokerCredentialStatus.INVALID,
    );
    // Exactly ONE successful persist of the new bundle — owner-gated WHERE.
    expect(successfulPersists()).toHaveLength(1);
    expect(successfulPersists()[0].where).toContain('credential_refresh_lease_owner = :ownerToken');
    expect(successfulPersists()[0].where).not.toContain('IS NULL');
    // EXACTLY ONE rotation audit event for this credential generation.
    expect(refreshedAuditCount()).toBe(1);
  });

  // ─── 2. Concurrent duplicate completion ACROSS service instances ────────────

  it('instance B started mid-flight WAITS and adopts instance A persisted result (provider count stays 1)', async () => {
    ctraderClient.refreshAccessToken.mockImplementation(async () => {
      await delay(50);
      return {
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresIn: 2_628_000,
      };
    });
    const instanceA = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });
    const instanceB = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });

    const promiseA = instanceA.ensureFreshTokens(connectionFixture(), staleCredentials());
    await delay(25); // A is now mid-flight inside its provider refresh
    const promiseB = instanceB.ensureFreshTokens(connectionFixture(), staleCredentials());
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    // A refreshed; B waited and RELOADED A's result — still ONE provider call.
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(resultA.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(resultB.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(resultB.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
    expect(resultB.additionalParams?.accessTokenExpiresAt).toBe(
      resultA.additionalParams?.accessTokenExpiresAt,
    );
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(storedRow().credentialGeneration).toBe(1);
    expect(storedRow().credentialRefreshLeaseExpiresAt).toBeNull();
    expect(successfulPersists()).toHaveLength(1);
    expect(refreshedAuditCount()).toBe(1);
  });

  // ─── 3. A stale refresh response can never overwrite a newer generation ────

  it('CAS persist fails against a newer externally-rotated generation → adopts the newer pair, never overwrites', async () => {
    // A manual/stolen rotation lands BETWEEN the winner's provider refresh
    // and its CAS persist.
    const newerBundle = encryption.encrypt({
      apiKey: 'STOLEN-NEWER-ACCESS',
      accountId: '1234567',
      additionalParams: {
        refreshToken: 'STOLEN-NEWER-REFRESH',
        accessTokenExpiresAt: new Date(Date.now() + 20 * 24 * 3600_000).toISOString(),
      },
    });
    ctraderClient.refreshAccessToken.mockImplementation(async () => {
      repo.setColumns(CONN_ID, {
        credential_generation: 5,
        credential_status: BrokerCredentialStatus.ROTATED,
        encrypted_credentials: newerBundle.ciphertext,
        credential_iv: newerBundle.iv,
        credential_tag: newerBundle.tag,
        encryption_key_id: newerBundle.keyId,
      });
      return {
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresIn: 2_628_000,
      };
    });
    const service = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });

    const result = await service.ensureFreshTokens(connectionFixture(), staleCredentials());

    // The service returns the RELOADED newer pair — NOT its own stale response.
    expect(result.apiKey).toBe('STOLEN-NEWER-ACCESS');
    expect(result.additionalParams?.refreshToken).toBe('STOLEN-NEWER-REFRESH');
    // The stored newer ciphertext/iv/tag are UNCHANGED by the loser attempt.
    const row = storedRow();
    expect(row.encryptedCredentials).toBe(newerBundle.ciphertext);
    expect(row.credentialIv).toBe(newerBundle.iv);
    expect(row.credentialTag).toBe(newerBundle.tag);
    expect(row.credentialGeneration).toBe(5);
    expect(row.credentialRefreshLeaseExpiresAt).toBeNull();
    // The CAS persist lost (affected 0) and NO successful persist happened.
    const bundlePersists = repo.ops.filter((op) => 'encryptedCredentials' in op.set);
    expect(bundlePersists).toHaveLength(1);
    expect(bundlePersists[0].affected).toBe(0);
    expect(successfulPersists()).toHaveLength(0);
    // No rotation audit, no INVALID.
    expect(refreshedAuditCount()).toBe(0);
    expect(repo.ops.map((op) => op.set.credentialStatus)).not.toContain(
      BrokerCredentialStatus.INVALID,
    );
  });

  // ─── 4. A hung winner's lease EXPIRES → a waiter steals it and completes ────

  it('lease expiry recovery: a hung winner never blocks refresh — a waiter steals the EXPIRED lease and persists once', async () => {
    // First provider call NEVER settles (the hung winner); the second (the
    // lease thief) succeeds.
    ctraderClient.refreshAccessToken
      .mockImplementationOnce(() => new Promise<CtraderOAuthTokens>(() => {}))
      .mockImplementationOnce(async () => ({
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresIn: 2_628_000,
      }));
    // Tiny lease so the hung winner's claim EXPIRES quickly.
    const instanceA = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 40,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });
    const instanceB = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 40,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });

    const promiseA = instanceA.ensureFreshTokens(connectionFixture(), staleCredentials());
    const promiseB = instanceB.ensureFreshTokens(connectionFixture(), staleCredentials());
    const resultB = await promiseB;

    // B stole the EXPIRED lease and completed the refresh — the takeover
    // minted a NEW, DISTINCT owner token (round 6 lease-owner fencing).
    expect(resultB.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(resultB.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
    expect(claimOps()).toHaveLength(2);
    const [claimA, claimB] = claimOps();
    expect(claimA.set.credentialRefreshLeaseOwner).not.toBe(claimB.set.credentialRefreshLeaseOwner);
    expect(claimA.set.credentialRefreshLeaseOwner).toEqual(expect.any(String));
    expect(claimB.set.credentialRefreshLeaseOwner).toEqual(expect.any(String));
    // Two provider calls are acceptable ONLY because the first attempt never
    // persisted (hung forever) — the generation advanced EXACTLY once.
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(storedRow().credentialGeneration).toBe(1);
    expect(storedRow().credentialRefreshLeaseExpiresAt).toBeNull();
    expect(storedRow().credentialRefreshLeaseOwner).toBeNull();
    expect(successfulPersists()).toHaveLength(1);
    expect(refreshedAuditCount()).toBe(1);
    // The hung winner's eventual settlement can never land now: swallow it so
    // the dangling promise does not surface as an unhandled rejection later.
    void promiseA.catch(() => undefined);
  });

  // ─── 5. Auth-class rejection: winner INVALID + loser gets the same conflict ─

  it('auth-class rejection marks INVALID once and a CONCURRENT loser gets ConflictException (never a false success)', async () => {
    ctraderClient.refreshAccessToken.mockImplementation(async () => {
      await delay(50);
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'CH_ACCESS_TOKEN_INVALID: the refresh token is dead',
      );
    });
    const instanceA = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000, // >> provider delay: B can never steal mid-flight
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });
    const instanceB = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });

    const outcomes = await Promise.allSettled([
      instanceA.ensureFreshTokens(connectionFixture(), staleCredentials()),
      instanceB.ensureFreshTokens(connectionFixture(), staleCredentials()),
    ]);

    // The winner refreshed (and was rejected) EXACTLY once; the loser never
    // called the provider — it observed the winner's INVALID verdict.
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
    for (const outcome of outcomes) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    }
    // INVALID persisted once + the lease released (BOTH columns).
    const row = storedRow();
    expect(row.credentialStatus).toBe(BrokerCredentialStatus.INVALID);
    expect(row.credentialRefreshLeaseExpiresAt).toBeNull();
    expect(row.credentialRefreshLeaseOwner).toBeNull();
    // The INVALID write happened exactly ONCE (the loser never writes) and is
    // owner-token fenced (no IS NULL alternative).
    const invalidWrites = repo.ops.filter(
      (op) => op.set.credentialStatus === BrokerCredentialStatus.INVALID,
    );
    expect(invalidWrites).toHaveLength(1);
    expect(invalidWrites[0].where).toContain('credential_refresh_lease_owner = :ownerToken');
    expect(invalidWrites[0].where).not.toContain('IS NULL');
    // No false success anywhere: zero rotations, zero rotation audits.
    expect(refreshedAuditCount()).toBe(0);
    expect(successfulPersists()).toHaveLength(0);
  });

  // ─── 6. Transient provider failure: no poisoning, lease released, retry works

  it('transient provider failure propagates WITHOUT poisoning state; the next attempt refreshes successfully', async () => {
    ctraderClient.refreshAccessToken
      .mockRejectedValueOnce(
        new BrokerAdapterError(
          BrokerErrorCode.CONNECTION_TIMEOUT,
          'cTrader token endpoint is unreachable.',
          undefined,
          true,
        ),
      )
      .mockResolvedValueOnce({
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresIn: 2_628_000,
      });
    const service = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });

    // First attempt: transient failure → typed error propagates.
    const err = await service
      .ensureFreshTokens(connectionFixture(), staleCredentials())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerAdapterError);
    expect((err as BrokerAdapterError).code).toBe(BrokerErrorCode.CONNECTION_TIMEOUT);
    expect((err as BrokerAdapterError).isRetryable).toBe(true);
    // The stored credential is NOT poisoned: status/generation unchanged and
    // the lease was RELEASED (BOTH columns — owner token cleared) so the next
    // attempt need not wait for expiry.
    const rowAfterFailure = storedRow();
    expect(rowAfterFailure.credentialStatus).toBe(BrokerCredentialStatus.VERIFIED);
    expect(rowAfterFailure.credentialGeneration).toBe(0);
    expect(rowAfterFailure.credentialRefreshLeaseExpiresAt).toBeNull();
    expect(rowAfterFailure.credentialRefreshLeaseOwner).toBeNull();
    expect(repo.ops.map((op) => op.set.credentialStatus)).not.toContain(
      BrokerCredentialStatus.INVALID,
    );
    const firstOwner = claimOps()[0].set.credentialRefreshLeaseOwner;

    // The next attempt claims the freed lease (minting a NEW DISTINCT owner
    // token) and completes the refresh.
    const result = await service.ensureFreshTokens(connectionFixture(), staleCredentials());
    expect(result.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(storedRow().credentialGeneration).toBe(1);
    expect(storedRow().credentialRefreshLeaseExpiresAt).toBeNull();
    expect(storedRow().credentialRefreshLeaseOwner).toBeNull();
    expect(claimOps().length).toBe(2);
    expect(claimOps()[claimOps().length - 1].set.credentialRefreshLeaseOwner).not.toBe(firstOwner);
    expect(refreshedAuditCount()).toBe(1);
  });
});
