import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
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

const ctraderConnection = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'conn-1',
    userId: 'user-1',
    brokerId: 'ctrader',
    accountId: '1234567',
    accountType: 'DEMO',
    encryptedCredentials: 'ciphertext',
    credentialIv: 'iv',
    credentialTag: 'tag',
    encryptionKeyId: 'env-key-v1',
    credentialStatus: BrokerCredentialStatus.VERIFIED,
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

describe('BrokerOAuthTokenLifecycleService (Sprint 56 correction — audit point 1)', () => {
  let service: BrokerOAuthTokenLifecycleService;
  let connectionRepo: { update: jest.Mock };
  let encryption: CredentialEncryptionService;
  let ctraderClient: { refreshAccessToken: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrokerOAuthTokenLifecycleService,
        {
          provide: getRepositoryToken(BrokerConnection),
          useValue: { update: jest.fn().mockResolvedValue({ affected: 1 }) },
        },
        {
          provide: CredentialEncryptionService,
          useValue: new CredentialEncryptionService({
            get: (key: string) => (key === 'BROKER_ENCRYPTION_KEY' ? TEST_ENCRYPTION_KEY : ''),
          } as unknown as ConfigService),
        },
        { provide: CTraderClientService, useValue: { refreshAccessToken: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(BrokerOAuthTokenLifecycleService);
    connectionRepo = module.get(getRepositoryToken(BrokerConnection));
    encryption = module.get(CredentialEncryptionService);
    ctraderClient = module.get(CTraderClientService);
    audit = module.get(AuditService);
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
    expect(connectionRepo.update).not.toHaveBeenCalled();
  });

  it('passes through when the credential carries no refresh token (access-token-only)', async () => {
    const credentials: DecryptedBrokerCredentials = {
      apiKey: ACCESS_TOKEN,
      accountId: '1234567',
    };
    const result = await service.ensureFreshTokens(ctraderConnection(), credentials);
    expect(result).toBe(credentials);
    expect(ctraderClient.refreshAccessToken).not.toHaveBeenCalled();
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
  });

  // ─── Refresh + ATOMIC persistence ───────────────────────────────────────────

  it('refreshes an EXPIRED token and persists the new pair ATOMICALLY before returning it', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    const connection = ctraderConnection();
    const credentials = credentialsWithTokens();

    const result = await service.ensureFreshTokens(connection, credentials);

    // The provider saw the OLD refresh token.
    expect(ctraderClient.refreshAccessToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    // The caller receives the NEW pair (reconnect uses the refreshed token).
    expect(result.apiKey).toBe(NEW_ACCESS_TOKEN);
    expect(result.additionalParams?.refreshToken).toBe(NEW_REFRESH_TOKEN);
    expect(result.accountId).toBe('1234567');
    // Expiry tracking installed: ISO timestamp ≈ now + expiresIn.
    const expiryMs = Date.parse(result.additionalParams!.accessTokenExpiresAt!);
    expect(expiryMs).toBeGreaterThan(Date.now() + 2_600_000_000);
    expect(expiryMs).toBeLessThan(Date.now() + 2_660_000_000);
    // ATOMIC persistence: ONE update carrying ciphertext + IV + tag + keyId +
    // ROTATED status — the new pair is durable BEFORE any consumer sees it.
    expect(connectionRepo.update).toHaveBeenCalledTimes(1);
    const [id, patch] = connectionRepo.update.mock.calls[0];
    expect(id).toBe('conn-1');
    expect(patch.credentialStatus).toBe(BrokerCredentialStatus.ROTATED);
    expect(patch.encryptedCredentials).toBeDefined();
    expect(patch.credentialIv).toBeDefined();
    expect(patch.credentialTag).toBeDefined();
    // The persisted ciphertext decrypts to exactly the NEW pair (cTrader
    // invalidated the previous pair — the old one must NOT be stored).
    const decrypted = encryption.decrypt({
      ciphertext: patch.encryptedCredentials,
      iv: patch.credentialIv,
      tag: patch.credentialTag,
      keyId: patch.encryptionKeyId,
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
    // INVALID persisted + the auth-failure audit recorded.
    expect(connectionRepo.update).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ credentialStatus: BrokerCredentialStatus.INVALID }),
    );
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
    // No INVALID write — the old pair may still be alive; no state change.
    const statuses = connectionRepo.update.mock.calls.map((c) => c[1]?.credentialStatus);
    expect(statuses).not.toContain(BrokerCredentialStatus.INVALID);
  });

  it('marks INVALID when the refreshed pair cannot be PERSISTED (atomicity guarantee)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    connectionRepo.update.mockRejectedValue(new Error('db write failed'));
    await expect(
      service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens()),
    ).rejects.toThrow(ConflictException);
    // The provider issued a new pair but persistence failed: the STORED pair
    // is dead — the honest fail-closed state is INVALID.
    expect(connectionRepo.update).toHaveBeenLastCalledWith(
      'conn-1',
      expect.objectContaining({ credentialStatus: BrokerCredentialStatus.INVALID }),
    );
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
    });
  });

  it('NEVER leaks tokens into the persisted plaintext columns (ciphertext only)', async () => {
    ctraderClient.refreshAccessToken.mockResolvedValue({
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    await service.ensureFreshTokens(ctraderConnection(), credentialsWithTokens());
    const patch = connectionRepo.update.mock.calls[0][1];
    const serializedPatch = JSON.stringify(patch);
    // Token material never appears in ANY persisted field — only inside the
    // AES-256-GCM ciphertext blob (which is not the plaintext token).
    expect(serializedPatch).not.toContain(NEW_ACCESS_TOKEN);
    expect(serializedPatch).not.toContain(NEW_REFRESH_TOKEN);
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
