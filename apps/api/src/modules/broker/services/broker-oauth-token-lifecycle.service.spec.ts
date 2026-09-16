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

const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!!';
const ACCESS_TOKEN = 'original-access-token';
const REFRESH_TOKEN = 'original-refresh-token';
const NEW_ACCESS_TOKEN = 'NEW-ACCESS-TOKEN-XYZ';
const NEW_REFRESH_TOKEN = 'NEW-REFRESH-TOKEN-ABC';
const CONN_ID = 'conn-1';

// ─── In-memory BrokerConnection repository with REAL conditional-UPDATE ─────
//
// The lease claim / generation-CAS guarantees hinge on WHERE-clause evaluation
// and affected-rows semantics — call-count mocks would prove nothing. This
// double implements the exact subset of Repository + QueryBuilder the
// lifecycle service uses, against genuine shared row state (property→column
// mapping, Date comparisons, affected counts). (The pg-integration suite
// re-proves the same guarantees against real PostgreSQL; this sandbox has no
// DB driver.)

/** Property → DB column map for the BrokerConnection fields used here. */
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
  /** Property-named set values exactly as the service passed them. */
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

  /** Evaluates the pushed WHERE clauses against one column-named row. */
  private matches(row: Record<string, unknown>): boolean {
    for (const clause of this.clauses) {
      if (!this.evaluate(clause, row)) return false;
    }
    return true;
  }

  private evaluate(clause: string, row: Record<string, unknown>): boolean {
    // Top-level AND split — a parenthesised OR group survives as one token.
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
  /** Column-named rows keyed by id — shared mutable state across instances. */
  readonly rows = new Map<string, Record<string, unknown>>();
  /** Every write attempt, for atomicity/ordering assertions. */
  readonly ops: FakeOp[] = [];
  /** 1-based conditional-UPDATE attempt number that must THROW (fault injection). */
  failConditionalUpdateAttempt: number | null = null;
  conditionalUpdateAttempts = 0;

  seed(fixture: Record<string, unknown>): void {
    const row: Record<string, unknown> = {};
    for (const [prop, value] of Object.entries(fixture)) {
      row[COLUMN_OF[prop] ?? prop] = cloneValue(value);
    }
    this.rows.set(String(row['id']), row);
  }

  /** Raw column-keyed mutation — simulates EXTERNAL/manual writers. */
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

/** Direct construction + protected-seam override for determinism. */
class TestableLifecycleService extends BrokerOAuthTokenLifecycleService {
  constructor(
    repo: InMemoryBrokerConnectionRepo,
    encryption: CredentialEncryptionService,
    client: { refreshAccessToken: jest.Mock },
    audit: { log: jest.Mock },
    seams: { leaseMs?: number; waitBudgetMs?: number; pollIntervalMs?: number } = {},
  ) {
    super(
      repo as unknown as Repository<BrokerConnection>,
      encryption,
      client as unknown as CTraderClientService,
      audit as unknown as AuditService,
      // Round 6 live-execution completion (§1b): authority seams (mocked —
      // the bump/invalidation matrices live in the execution-authority suites).
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
}

const ctraderConnection = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    id: CONN_ID,
    userId: 'user-1',
    brokerId: 'ctrader',
    accountId: '1234567',
    accountType: 'DEMO',
    encryptedCredentials: 'ciphertext',
    credentialIv: 'iv',
    credentialTag: 'tag',
    encryptionKeyId: 'env-key-v1',
    credentialStatus: BrokerCredentialStatus.VERIFIED,
    credentialGeneration: 0,
    ...overrides,
  }) as unknown as BrokerConnection;

const credentialsWithTokens = (
  overrides: Partial<DecryptedBrokerCredentials> = {},
): DecryptedBrokerCredentials => ({
  apiKey: ACCESS_TOKEN,
  accountId: '1234567',
  additionalParams: {
    refreshToken: REFRESH_TOKEN,
    accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(), // expired
  },
  ...overrides,
});

describe('BrokerOAuthTokenLifecycleService (Sprint 56 correction — audit point 1 + finding 3)', () => {
  let repo: InMemoryBrokerConnectionRepo;
  let encryption: CredentialEncryptionService;
  let ctraderClient: { refreshAccessToken: jest.Mock };
  let audit: { log: jest.Mock };
  let service: BrokerOAuthTokenLifecycleService;

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
      encryptedCredentials: 'ciphertext',
      credentialIv: 'iv',
      credentialTag: 'tag',
      encryptionKeyId: 'env-key-v1',
    });
    encryption = new CredentialEncryptionService({
      get: (key: string) => (key === 'BROKER_ENCRYPTION_KEY' ? TEST_ENCRYPTION_KEY : ''),
    } as unknown as ConfigService);
    ctraderClient = { refreshAccessToken: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new TestableLifecycleService(repo, encryption, ctraderClient, audit);
  });

  // ─── Passthrough (no refresh) ───────────────────────────────────────────────

  it('passes through unchanged for non-cTrader-family brokers (no provider/DB interaction)', async () => {
    const credentials = credentialsWithTokens();
    const result = await service.ensureFreshTokens(
      ctraderConnection({ brokerId: 'metatrader5' }),
      credentials,
    );
    expect(result).toBe(credentials);
    expect(ctraderClient.refreshAccessToken).not.toHaveBeenCalled();
    expect(repo.ops).toHaveLength(0);
  });

  it('passes through when the credential carries no refresh token (access-token-only)', async () => {
    const credentials: DecryptedBrokerCredentials = {
      apiKey: ACCESS_TOKEN,
      accountId: '1234567',
    };
    const result = await service.ensureFreshTokens(ctraderConnection(), credentials);
    expect(result).toBe(credentials);
    expect(ctraderClient.refreshAccessToken).not.toHaveBeenCalled();
    expect(repo.ops).toHaveLength(0);
  });

  it('passes through when the access token is still fresh (outside the safety margin)', async () => {
    const credentials = credentialsWithTokens({
      additionalParams: {
        refreshToken: REFRESH_TOKEN,
        accessTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      },
    });
    const result = await service.ensureFreshTokens(ctraderConnection(), credentials);
    expect(result).toBe(credentials);
    expect(ctraderClient.refreshAccessToken).not.toHaveBeenCalled();
    expect(repo.ops).toHaveLength(0);
  });

  it('passes through for cTrader family aliases (pepperstone/icmarkets) with fresh tokens', async () => {
    for (const brokerId of ['pepperstone-ctrader', 'icmarkets-ctrader']) {
      const credentials = credentialsWithTokens({
        additionalParams: {
          refreshToken: REFRESH_TOKEN,
          accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
        },
      });
      expect(await service.ensureFreshTokens(ctraderConnection({ brokerId }), credentials)).toBe(
        credentials,
      );
    }
    expect(repo.ops).toHaveLength(0);
  });

  // ─── Refresh + ATOMIC generation-CAS persistence ────────────────────────────

  it('refreshes an EXPIRED token and persists the new pair ATOMICALLY before returning it', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const connection = ctraderConnection();
    const credentials = credentialsWithTokens();

    const result = await service.ensureFreshTokens(connection, credentials);

    // The provider saw the OLD refresh token — EXACTLY ONE provider refresh.
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    // The caller receives the NEW pair (reconnect uses the refreshed token).
    expect(result.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(result.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
    expect(result.accountId).toBe('1234567');
    // Expiry tracking installed: ISO timestamp ≈ now + expiresIn.
    const expiryMs = Date.parse(result.additionalParams!.accessTokenExpiresAt!);
    expect(expiryMs).toBeGreaterThan(Date.now() + 2_600_000_000);
    expect(expiryMs).toBeLessThan(Date.now() + 2_660_000_000);
    // ATOMIC persistence: exactly ONE guarded UPDATE carrying ciphertext +
    // IV + tag + keyId + ROTATED status + generation bump + lease release —
    // the new pair is durable BEFORE any consumer sees it. Round 6: the
    // claim set BOTH lease columns (expiry + a FRESH owner token) and the
    // persist CAS is OWNER-GATED (exact token, no IS NULL alternative) and
    // clears BOTH columns.
    const persists = repo.ops.filter((op) => 'encryptedCredentials' in op.set);
    expect(persists).toHaveLength(1);
    expect(persists[0].affected).toBe(1);
    expect(persists[0].set.credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(persists[0].set.credentialGeneration).toBe(1);
    expect(persists[0].set.credentialRefreshLeaseExpiresAt).toBeNull();
    expect(persists[0].set.credentialRefreshLeaseOwner).toBeNull();
    expect(persists[0].where).toContain('credential_generation = :observedGeneration');
    expect(persists[0].where).toContain('credential_refresh_lease_owner = :ownerToken');
    expect(persists[0].where).not.toContain('IS NULL');
    // The refresh lease was claimed FIRST (serialization across replicas) —
    // the claim mints BOTH the expiry AND the unique owner token.
    expect(repo.ops[0].set.credentialRefreshLeaseExpiresAt).toBeInstanceOf(Date);
    expect(repo.ops[0].set.credentialRefreshLeaseOwner).toEqual(expect.any(String));
    expect(repo.ops[0].set.credentialRefreshLeaseOwner).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The STORED row now decrypts to exactly the NEW pair (cTrader
    // invalidated the previous pair — the old one must NOT be stored).
    const row = repo.findOne({ where: { id: CONN_ID } })!;
    expect(row.credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(row.credentialGeneration).toBe(1);
    expect(row.credentialRefreshLeaseExpiresAt).toBeNull();
    expect(row.credentialRefreshLeaseOwner).toBeNull();
    const decrypted = encryption.decrypt({
      ciphertext: row.encryptedCredentials as string,
      iv: row.credentialIv as string,
      tag: row.credentialTag as string,
      keyId: row.encryptionKeyId as string,
    });
    expect(decrypted.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(decrypted.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
  });

  it('refreshes when the token is NEAR expiry (inside the 5-minute safety margin)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const credentials = credentialsWithTokens({
      additionalParams: {
        refreshToken: REFRESH_TOKEN,
        accessTokenExpiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      },
    });
    await service.ensureFreshTokens(ctraderConnection(), credentials);
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledWith(REFRESH_TOKEN);
  });

  it('refreshes when the expiry timestamp is ABSENT (legacy credential — installs tracking)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const credentials: DecryptedBrokerCredentials = {
      apiKey: ACCESS_TOKEN,
      accountId: '1234567',
      additionalParams: { refreshToken: REFRESH_TOKEN },
    };
    const result = await service.ensureFreshTokens(ctraderConnection(), credentials);
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    expect(result.additionalParams?.accessTokenExpiresAt).toBeDefined();
  });

  it('never mutates the input credentials object (caller zeroing stays meaningful)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const credentials = credentialsWithTokens();
    await service.ensureFreshTokens(ctraderConnection(), credentials);
    expect(credentials.apiKey).toBe(ACCESS_TOKEN);
    expect(credentials.additionalParams?.refreshToken).toBe(REFRESH_TOKEN);
  });

  // ─── Fail-closed paths ──────────────────────────────────────────────────────

  it('marks the credential INVALID (fail-closed) when the refresh is REJECTED', async () => {
    ctraderClient.refreshAccessToken.mockRejectedValue(
      new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'CH_ACCESS_TOKEN_INVALID: the refresh token is dead',
      ),
    );
    await expect(
      service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens()),
    ).rejects.toThrow(ConflictException);
    // INVALID persisted + the auth-failure audit recorded + lease released
    // (BOTH columns — the owner token dies with the terminal write).
    const row = repo.findOne({ where: { id: CONN_ID } })!;
    expect(row.credentialStatus).toBe(BrokerCredentialStatus.INVALID);
    expect(row.credentialRefreshLeaseExpiresAt).toBeNull();
    expect(row.credentialRefreshLeaseOwner).toBeNull();
    expect(row.lastErrorMessage).toContain('re-authorization required');
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toContain(AuditAction.BROKER_OAUTH_TOKEN_REFRESH_FAILED);
  });

  it('propagates TRANSIENT refresh failures WITHOUT poisoning the stored credential', async () => {
    ctraderClient.refreshAccessToken.mockRejectedValue(
      new BrokerAdapterError(
        BrokerErrorCode.CONNECTION_TIMEOUT,
        'cTrader token endpoint is unreachable.',
        undefined,
        true,
      ),
    );
    await expect(
      service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens()),
    ).rejects.toMatchObject({ code: BrokerErrorCode.CONNECTION_TIMEOUT });
    // No INVALID write — the old pair may still be alive; no state change;
    // the lease is RELEASED (BOTH columns, owner-token-gated) so the next
    // attempt need not wait for expiry.
    const row = repo.findOne({ where: { id: CONN_ID } })!;
    expect(row.credentialStatus).toBe(BrokerCredentialStatus.VERIFIED);
    expect(row.credentialGeneration).toBe(0);
    expect(row.credentialRefreshLeaseExpiresAt).toBeNull();
    expect(row.credentialRefreshLeaseOwner).toBeNull();
    const statuses = repo.ops.map((op) => op.set.credentialStatus);
    expect(statuses).not.toContain(BrokerCredentialStatus.INVALID);
    // The release is fenced by OUR owner token and clears BOTH columns.
    const releases = repo.ops.filter(
      (op) =>
        op.set.credentialRefreshLeaseExpiresAt === null && op.set.credentialStatus === undefined,
    );
    expect(releases).toHaveLength(1);
    expect(releases[0].where).toContain('credential_refresh_lease_owner = :ownerToken');
    expect(releases[0].set.credentialRefreshLeaseOwner).toBeNull();
    expect(releases[0].affected).toBe(1);
  });

  it('marks INVALID when the refreshed pair cannot be PERSISTED (atomicity guarantee)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    // Claim = attempt 1, CAS persist = attempt 2 (THROWS), guarded INVALID = attempt 3.
    repo.failConditionalUpdateAttempt = 2;
    await expect(
      service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens()),
    ).rejects.toThrow(ConflictException);
    // The provider issued a new pair but persistence failed: the STORED pair
    // is dead — the honest fail-closed state is INVALID (and lease released).
    const row = repo.findOne({ where: { id: CONN_ID } })!;
    expect(row.credentialStatus).toBe(BrokerCredentialStatus.INVALID);
    expect(row.credentialRefreshLeaseExpiresAt).toBeNull();
    // Correction round 4 + round 6: the INVALID write is a GUARDED conditional
    // UPDATE (generation + EXACT lease-owner token — architect finding 1),
    // not a blind repo.update by connection id.
    const invalidWrites = repo.ops.filter(
      (op) => op.set.credentialStatus === BrokerCredentialStatus.INVALID,
    );
    expect(invalidWrites).toHaveLength(1);
    expect(invalidWrites[0].kind).toBe('qb-update');
    expect(invalidWrites[0].where).toContain('credential_generation = :observedGeneration');
    expect(invalidWrites[0].where).toContain('credential_refresh_lease_owner = :ownerToken');
    expect(invalidWrites[0].where).not.toContain('IS NULL');
    expect(invalidWrites[0].affected).toBe(1);
    expect(invalidWrites[0].set.credentialRefreshLeaseOwner).toBeNull();
  });

  // ─── Generation CAS: a stale refresh response never overwrites a newer pair ─

  it('adopts the NEWER persisted pair (no write, no audit) when its CAS persist loses', async () => {
    // Simulates a manual/stolen rotation landing BETWEEN the winner's
    // provider refresh and its CAS persist.
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

    const result = await service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens());

    // The service returns the RELOADED newer pair, not its own stale response.
    expect(result.apiKey).toBe('STOLEN-NEWER-ACCESS');
    expect(result.additionalParams?.refreshToken).toBe('STOLEN-NEWER-REFRESH');
    // The stored newer ciphertext is UNTOUCHED by the stale refresh response.
    const row = repo.findOne({ where: { id: CONN_ID } })!;
    expect(row.encryptedCredentials).toBe(newerBundle.ciphertext);
    expect(row.credentialIv).toBe(newerBundle.iv);
    expect(row.credentialTag).toBe(newerBundle.tag);
    expect(row.credentialGeneration).toBe(5);
    expect(row.credentialRefreshLeaseExpiresAt).toBeNull();
    expect(row.credentialRefreshLeaseOwner).toBeNull();
    // The CAS persist FAILED (affected 0) — never a blind overwrite; the
    // WHERE carries the generation AND the exact owner token.
    const persists = repo.ops.filter((op) => 'encryptedCredentials' in op.set);
    expect(persists).toHaveLength(1);
    expect(persists[0].affected).toBe(0);
    expect(persists[0].where).toContain('credential_refresh_lease_owner = :ownerToken');
    // NO rotation audit for the losing attempt.
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).not.toContain(AuditAction.BROKER_OAUTH_TOKENS_REFRESHED);
  });

  it('throws a typed conflict when the newer generation is NOT usable (CAS fail, unusable status)', async () => {
    ctraderClient.refreshAccessToken.mockImplementation(async () => {
      repo.setColumns(CONN_ID, {
        credential_generation: 5,
        credential_status: BrokerCredentialStatus.REVOKED,
      });
      return {
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresIn: 2_628_000,
      };
    });
    await expect(
      service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens()),
    ).rejects.toThrow(ConflictException);
    // Fail-closed without a false INVALID: the row keeps its REVOKED truth.
    const row = repo.findOne({ where: { id: CONN_ID } })!;
    expect(row.credentialStatus).toBe(BrokerCredentialStatus.REVOKED);
    expect(row.credentialGeneration).toBe(5);
    const statuses = repo.ops.map((op) => op.set.credentialStatus);
    expect(statuses).not.toContain(BrokerCredentialStatus.INVALID);
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).not.toContain(AuditAction.BROKER_OAUTH_TOKENS_REFRESHED);
  });

  // ─── Loser path (lease held by another holder) ──────────────────────────────

  it('never calls the provider and throws RETRYABLE RATE_LIMITED when the wait budget is exhausted', async () => {
    // Another holder (another replica) holds a live lease — expiry AND its
    // own owner token.
    repo.setColumns(CONN_ID, {
      credential_refresh_lease_expires_at: new Date(Date.now() + 60_000),
      credential_refresh_lease_owner: 'external-holder-owner-token',
    });
    service = new TestableLifecycleService(repo, encryption, ctraderClient, audit, {
      waitBudgetMs: 20,
      pollIntervalMs: 5,
    });

    const err = await service
      .ensureFreshTokens(ctraderConnection(), credentialsWithTokens())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BrokerAdapterError);
    expect((err as BrokerAdapterError).code).toBe(BrokerErrorCode.RATE_LIMITED);
    expect((err as BrokerAdapterError).isRetryable).toBe(true);
    expect((err as BrokerAdapterError).message).toContain(CONN_ID);
    expect(ctraderClient.refreshAccessToken).not.toHaveBeenCalled();
    // No state change at all (the lease stays with its holder — BOTH columns).
    const row = repo.findOne({ where: { id: CONN_ID } })!;
    expect(row.credentialStatus).toBe(BrokerCredentialStatus.VERIFIED);
    expect(row.credentialGeneration).toBe(0);
    expect(row.credentialRefreshLeaseOwner).toBe('external-holder-owner-token');
    expect(repo.ops.filter((op) => op.affected > 0)).toHaveLength(0);
  });

  it('a LOSER observing an INVALID credential gets the typed conflict — never writes, never refreshes', async () => {
    // The winner's fail-closed path already marked the credential INVALID
    // and still holds the lease (expiry + owner token).
    repo.setColumns(CONN_ID, {
      credential_status: BrokerCredentialStatus.INVALID,
      credential_refresh_lease_expires_at: new Date(Date.now() + 60_000),
      credential_refresh_lease_owner: 'invalid-winner-owner-token',
    });
    service = new TestableLifecycleService(repo, encryption, ctraderClient, audit, {
      waitBudgetMs: 20,
      pollIntervalMs: 5,
    });

    await expect(
      service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens()),
    ).rejects.toThrow(ConflictException);
    expect(ctraderClient.refreshAccessToken).not.toHaveBeenCalled();
    // The loser made NO effective write (claims only, all affected 0).
    expect(repo.ops.filter((op) => op.affected > 0)).toHaveLength(0);
    const row = repo.findOne({ where: { id: CONN_ID } })!;
    expect(row.credentialStatus).toBe(BrokerCredentialStatus.INVALID);
  });

  // ─── Adversarial secrecy (audit point 1) ────────────────────────────────────

  it('NEVER leaks tokens into audit metadata (successful refresh)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    await service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens());
    expect(audit.log).toHaveBeenCalled();
    for (const call of audit.log.mock.calls) {
      const serialized = JSON.stringify(call[0]);
      expect(serialized).not.toContain(NEW_ACCESS_TOKEN);
      expect(serialized).not.toContain(NEW_REFRESH_TOKEN);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(REFRESH_TOKEN);
    }
    // The refresh audit carries ONLY the sanctioned fields.
    const refreshCall = audit.log.mock.calls.find(
      (c) => c[0].action === AuditAction.BROKER_OAUTH_TOKENS_REFRESHED,
    );
    expect(refreshCall[0].metadata).toEqual({
      brokerId: 'ctrader',
      accountId: '1234567',
      accessTokenExpiresAt: expect.any(String),
      credentialGeneration: 1,
    });
  });

  it('NEVER leaks tokens into the persisted plaintext columns (ciphertext only)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    await service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens());
    for (const op of repo.ops) {
      const serializedSet = JSON.stringify(op.set);
      // Token material never appears in ANY persisted field — only inside the
      // AES-256-GCM ciphertext blob (which is not the plaintext token).
      expect(serializedSet).not.toContain(NEW_ACCESS_TOKEN);
      expect(serializedSet).not.toContain(NEW_REFRESH_TOKEN);
    }
  });

  it('NEVER leaks tokens into exception text (rejected refresh path)', async () => {
    ctraderClient.refreshAccessToken.mockRejectedValue(
      new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'rejected refresh_token=SEKRIT-REFRESH rejected',
      ),
    );
    const err = await service
      .ensureFreshTokens(ctraderConnection(), credentialsWithTokens())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const message = (err as ConflictException).message;
    expect(message).not.toContain(REFRESH_TOKEN);
    expect(message).not.toContain('SEKRIT');
    expect(message).toContain('re-authorize');
  });
});
