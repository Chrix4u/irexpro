import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BrokerOAuthTokenLifecycleService } from './broker-oauth-token-lifecycle.service';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { CredentialEncryptionService } from './credential-encryption.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { BrokerCredentialStatus } from '../authorization/broker-credential-status';
import { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';

/**
 * Sprint 56 correction round 4 — architect finding 1: STALE REFRESH OWNERS
 * can never invalidate a newer credential generation.
 *
 * The successful token-persistence path always carried generation-CAS
 * protection; the failure path (markRefreshRejected) previously wrote
 * INVALID by connection id ALONE. This suite proves the corrected contract
 * on the shared in-memory row store (the pg-integration suite re-proves the
 * same guarantees against real PostgreSQL):
 *
 * A. A's lease expires → B persists N+1 → A returns AUTHENTICATION_FAILED
 *    → N+1 stays usable; ZERO stale INVALID overwrite; NO false failure
 *    audit against N+1.
 * B. A's lease expires → B persists N+1 → A's own persistence THROWS
 *    → B's N+1 stays authoritative; stale A cannot invalidate it (A adopts).
 * C. GENUINE owner gets an auth rejection BEFORE any takeover
 *    → generation N becomes INVALID EXACTLY ONCE with exactly one audit.
 * D. Twenty concurrent callers, no lease-expiry takeover
 *    → the round-2 one-refresh behavior is fully preserved.
 * E. A stale owner whose lease was TAKEN OVER (live lease, same generation)
 *    → never writes, never audits; the current lease owner decides.
 * F. A stale owner with NO takeover but a dead pair (expired, unreclaimed
 *    lease) → the honest fail-closed INVALID still lands (provider evidence
 *    is authoritative for that generation).
 */

const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!!';
const ACCESS_TOKEN = 'original-access-token';
const REFRESH_TOKEN = 'original-refresh-token';
const NEW_ACCESS_TOKEN = 'NEW-ACCESS-TOKEN-XYZ';
const NEW_REFRESH_TOKEN = 'NEW-REFRESH-TOKEN-ABC';
const B_ACCESS_TOKEN = 'B-ACCESS-TOKEN-TAKEOVER';
const B_REFRESH_TOKEN = 'B-REFRESH-TOKEN-TAKEOVER';
const CONN_ID = 'conn-1';
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Shared in-memory row store with REAL conditional-UPDATE semantics ──────

const COLUMN_OF: Record<string, string> = {
  id: 'id',
  userId: 'user_id',
  brokerId: 'broker_id',
  brokerName: 'broker_name',
  accountId: 'account_id',
  credentialStatus: 'credential_status',
  credentialGeneration: 'credential_generation',
  credentialRefreshLeaseExpiresAt: 'credential_refresh_lease_expires_at',
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
    this.repo.conditionalUpdateAttempts += 1;
    if (this.repo.failConditionalUpdateAttempt === this.repo.conditionalUpdateAttempts) {
      throw new Error('simulated conditional UPDATE failure');
    }
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
  failConditionalUpdateAttempt: number | null = null;
  conditionalUpdateAttempts = 0;

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

const makeInstance = (
  repo: InMemoryBrokerConnectionRepo,
  encryption: CredentialEncryptionService,
  client: { refreshAccessToken: jest.Mock },
  audit: { log: jest.Mock },
  seams: { leaseMs?: number; waitBudgetMs?: number; pollIntervalMs?: number } = {},
): BrokerOAuthTokenLifecycleService =>
  new (class extends BrokerOAuthTokenLifecycleService {
    constructor() {
      super(
        repo as unknown as Repository<BrokerConnection>,
        encryption,
        client as unknown as CTraderClientService,
        audit as unknown as AuditService,
      );
      if (seams.leaseMs !== undefined) this.leaseMs = seams.leaseMs;
      if (seams.waitBudgetMs !== undefined) this.waitBudgetMs = seams.waitBudgetMs;
      if (seams.pollIntervalMs !== undefined) this.pollIntervalMs = seams.pollIntervalMs;
    }
  })();

describe('BrokerOAuthTokenLifecycleService stale-owner fencing (Sprint 56 correction round 4 — architect finding 1)', () => {
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
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
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

  const invalidOps = (): FakeOp[] =>
    repo.ops.filter(
      (op) => op.set.credentialStatus === BrokerCredentialStatus.INVALID && op.affected === 1,
    );

  const refreshFailedAudits = (): unknown[] =>
    audit.log.mock.calls
      .map((c) => c[0])
      .filter(
        (entry) =>
          (entry as { action: string }).action === AuditAction.BROKER_OAUTH_TOKEN_REFRESH_FAILED,
      );

  const authRejection = () =>
    new BrokerAdapterError(
      BrokerErrorCode.AUTHENTICATION_FAILED,
      'CH_ACCESS_TOKEN_INVALID: the refresh token is dead',
    );

  // ─── A. Expired lease + takeover + late AUTHENTICATION_FAILED ──────────────

  it('A: expired-lease stale winner CANNOT invalidate the takeover generation N+1 (no write, no audit)', async () => {
    // A claims the lease (leaseMs = 40) and its provider request stays in
    // flight LONGER than the lease; B steals the expired lease, refreshes,
    // and CAS-persists generation 1 BEFORE A's rejection lands.
    ctraderClient.refreshAccessToken
      .mockImplementationOnce(async () => {
        await delay(120);
        throw authRejection(); // A's late rejection
      })
      .mockImplementation(async () => ({
        // B's takeover refresh succeeds
        accessToken: B_ACCESS_TOKEN,
        refreshToken: B_REFRESH_TOKEN,
        expiresIn: 2_628_000,
      }));
    const instanceA = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 40,
      waitBudgetMs: 3_000,
      pollIntervalMs: 5,
    });
    const instanceB = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 3_000,
      pollIntervalMs: 5,
    });

    const promiseA = instanceA.ensureFreshTokens(connectionFixture(), staleCredentials());
    await delay(60); // A's lease (40ms) has EXPIRED; A's provider call is still in flight
    const resultB = await instanceB.ensureFreshTokens(connectionFixture(), staleCredentials());
    const resultA = await promiseA;

    // B's takeover pair is usable and persisted at generation 1.
    expect(resultB.apiKey).toBe(B_ACCESS_TOKEN);
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(storedRow().credentialGeneration).toBe(1);
    // A CONVERGES onto B's authoritative pair (no error, no poison).
    expect(resultA.apiKey).toBe(B_ACCESS_TOKEN);
    expect(resultA.additionalParams?.refreshToken).toBe(B_REFRESH_TOKEN);
    // ZERO stale INVALID overwrite — no op ever wrote INVALID.
    expect(invalidOps()).toHaveLength(0);
    expect(storedRow().credentialStatus).not.toBe(BrokerCredentialStatus.INVALID);
    // NO false authoritative "refresh failed" audit against generation N+1.
    expect(refreshFailedAudits()).toHaveLength(0);
    // Exactly one successful persist (B's), exactly one rotation audit.
    expect(
      repo.ops.filter((op) => 'encryptedCredentials' in op.set && op.affected === 1),
    ).toHaveLength(1);
    expect(
      audit.log.mock.calls.filter((c) => c[0].action === AuditAction.BROKER_OAUTH_TOKENS_REFRESHED),
    ).toHaveLength(1);
    // The decrypted stored pair is B's (never A's stale view).
    expect(decryptStored().apiKey).toBe(B_ACCESS_TOKEN);
  });

  // ─── B. Expired lease + takeover + A's provider success + A's persistence THROWS ──

  it("B: stale A receives new provider tokens but its persistence fails → B's N+1 stays authoritative", async () => {
    ctraderClient.refreshAccessToken
      .mockImplementationOnce(async () => {
        // A's provider refresh SUCCEEDS (late — after B's takeover persist).
        await delay(120);
        return {
          accessToken: NEW_ACCESS_TOKEN,
          refreshToken: NEW_REFRESH_TOKEN,
          expiresIn: 2_628_000,
        };
      })
      .mockImplementation(async () => ({
        accessToken: B_ACCESS_TOKEN,
        refreshToken: B_REFRESH_TOKEN,
        expiresIn: 2_628_000,
      }));
    const instanceA = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 40,
      waitBudgetMs: 3_000,
      pollIntervalMs: 5,
    });
    const instanceB = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 3_000,
      pollIntervalMs: 5,
    });

    const promiseA = instanceA.ensureFreshTokens(connectionFixture(), staleCredentials());
    await delay(60); // A's lease expired; A's provider call still in flight
    await instanceB.ensureFreshTokens(connectionFixture(), staleCredentials()); // B persists generation 1
    // A's CAS persist now THROWS (DB failure on the stale owner's write):
    // attempt 1 = A claim, 2 = B claim, 3 = B persist, 4 = A persist (throws).
    repo.failConditionalUpdateAttempt = repo.conditionalUpdateAttempts + 1;
    const resultA = await promiseA;

    // B's N+1 remains authoritative and usable — A could not invalidate it.
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(storedRow().credentialGeneration).toBe(1);
    expect(decryptStored().apiKey).toBe(B_ACCESS_TOKEN);
    expect(invalidOps()).toHaveLength(0);
    expect(refreshFailedAudits()).toHaveLength(0);
    // A adopts B's pair rather than surfacing a false dead-credential state.
    expect(resultA.apiKey).toBe(B_ACCESS_TOKEN);
  });

  // ─── C. Genuine owner rejection BEFORE takeover → INVALID exactly once ────

  it('C: genuine current-owner auth rejection marks generation N INVALID EXACTLY ONCE with one audit', async () => {
    ctraderClient.refreshAccessToken.mockRejectedValue(authRejection());
    const instance = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 30_000,
      waitBudgetMs: 2_000,
      pollIntervalMs: 5,
    });

    await expect(
      instance.ensureFreshTokens(connectionFixture(), staleCredentials()),
    ).rejects.toThrow(ConflictException);

    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.INVALID);
    expect(storedRow().credentialGeneration).toBe(0);
    expect(storedRow().credentialRefreshLeaseExpiresAt).toBeNull();
    expect(invalidOps()).toHaveLength(1);
    expect(invalidOps()[0].where).toContain('credential_generation = :observedGeneration');
    expect(refreshFailedAudits()).toHaveLength(1);
    expect(
      (refreshFailedAudits()[0] as { metadata: { credentialGeneration: number } }).metadata
        .credentialGeneration,
    ).toBe(0);
  });

  // ─── D. Twenty concurrent callers, no takeover → one-refresh preserved ────

  it('D: 20 concurrent callers with no lease-expiry takeover → exactly one refresh, no false INVALID', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const service = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 5_000,
      waitBudgetMs: 3_000,
      pollIntervalMs: 5,
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.ensureFreshTokens(connectionFixture(), staleCredentials()),
      ),
    );

    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(20);
    for (const result of results) {
      expect(result.apiKey).toBe(NEW_ACCESS_TOKEN);
    }
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(storedRow().credentialGeneration).toBe(1);
    expect(invalidOps()).toHaveLength(0);
    expect(refreshFailedAudits()).toHaveLength(0);
  });

  // ─── E. Stale owner while a LIVE takeover lease holds the same generation ──

  it('E: stale owner rejected while B holds a LIVE lease on the same generation → no write, no audit', async () => {
    // A claims (leaseMs = 40); lease expires; B claims and holds a LONG lease
    // while its provider call is in flight; A's rejection lands mid-B.
    const holder: {
      resolveB?: (tokens: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    } = {};
    ctraderClient.refreshAccessToken
      .mockImplementationOnce(async () => {
        await delay(80);
        throw authRejection(); // A's rejection (stale owner)
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            holder.resolveB = resolve; // B's in-flight refresh — stays pending
          }),
      );
    const instanceA = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 40,
      waitBudgetMs: 3_000,
      pollIntervalMs: 5,
    });
    const instanceB = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 30_000,
      waitBudgetMs: 3_000,
      pollIntervalMs: 5,
    });

    const promiseA = instanceA.ensureFreshTokens(connectionFixture(), staleCredentials());
    const rejectionA = expect(promiseA).rejects.toThrow(ConflictException);
    await delay(60);
    const promiseB = instanceB.ensureFreshTokens(connectionFixture(), staleCredentials());
    await delay(40); // B claimed the expired lease; its refresh is in flight

    // A's rejection lands: A must NOT write INVALID and must NOT audit —
    // the LIVE lease owner (B) decides this generation's fate.
    await rejectionA;
    expect(invalidOps()).toHaveLength(0);
    expect(refreshFailedAudits()).toHaveLength(0);
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.VERIFIED);
    expect(storedRow().credentialGeneration).toBe(0);
    // The current lease owner's claim is INTACT (A never released B's lease).
    expect(storedRow().credentialRefreshLeaseExpiresAt).not.toBeNull();

    // B completes its refresh → the generation legitimately rotates.
    holder.resolveB?.({
      accessToken: B_ACCESS_TOKEN,
      refreshToken: B_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const resultB = await promiseB;
    expect(resultB.apiKey).toBe(B_ACCESS_TOKEN);
    expect(storedRow().credentialGeneration).toBe(1);
    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
  });

  // ─── F. Stale owner, NO takeover, dead pair → honest fail-closed INVALID ──

  it('F: stale owner with an unreclaimed expired lease and a dead pair → the honest INVALID still lands', async () => {
    // A's lease expired but nobody took over; the provider then rejects the
    // pair. The stale lease value is still A's own claim — the guarded write
    // matches and the dead generation is marked INVALID (fail-closed).
    ctraderClient.refreshAccessToken.mockImplementationOnce(async () => {
      await delay(80);
      throw authRejection();
    });
    const instanceA = makeInstance(repo, encryption, ctraderClient, audit, {
      leaseMs: 40,
      waitBudgetMs: 3_000,
      pollIntervalMs: 5,
    });

    const promiseA = instanceA.ensureFreshTokens(connectionFixture(), staleCredentials());
    const rejectionA = expect(promiseA).rejects.toThrow(ConflictException);
    await delay(90); // lease long expired, no takeover, rejection landed
    await rejectionA;

    expect(storedRow().credentialStatus).toBe(BrokerCredentialStatus.INVALID);
    expect(invalidOps()).toHaveLength(1);
    expect(refreshFailedAudits()).toHaveLength(1);
    expect(storedRow().credentialRefreshLeaseExpiresAt).toBeNull();
  });
});
