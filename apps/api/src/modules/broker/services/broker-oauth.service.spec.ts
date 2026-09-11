import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { BrokerOAuthService } from './broker-oauth.service';
import { BrokerService } from '../broker.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { CtraderDiscoveredAccount } from '../adapters/ctrader/ctrader-message-types';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import { ConnectBrokerDto } from '../dto/connect-broker.dto';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerMode } from '../interfaces/broker-adapter.interface';
import { BrokerOAuthFlow } from '../entities/broker-oauth-flow.entity';
import { CredentialEncryptionService } from './credential-encryption.service';
import { BrokerLinkOutboxService } from './broker-link-outbox.service';
import { BrokerLogicalAccountConflictError } from '../interfaces/broker-connection.errors';

/**
 * BrokerOAuthService unit+store spec (Sprint 56 correction round 2 — architect
 * findings 2 + 4).
 *
 * The flow store is exercised against a REAL in-memory sqlite DataSource
 * (synchronize: true) — the repository-backed state machine, CAS transitions,
 * encrypted-at-rest token columns, digest-only handoff tokens, and the lazy
 * sweep all run against actual rows. Cross-replica behavior (two service
 * instances sharing one store) is proven separately in
 * broker-oauth.cross-instance.spec.ts.
 *
 * Provider collaborators (BrokerService / CTraderClientService / AuditService
 * / ConfigService) stay mocked exactly as in the round-1 spec; the encryption
 * service is REAL so the ciphertext assertions are meaningful.
 */

const USER = '11111111-1111-1111-1111-111111111111';
const FOREIGN_USER = '22222222-2222-2222-2222-222222222222';
const WEB_REDIRECT = 'https://app.irexpro.com/onboarding/broker/callback';
const MOBILE_REDIRECT = 'irexpro://broker/oauth/callback';
const MOBILE_SLOT = 'https://api.irexpro.com/api/v1/broker/connections/oauth/callback/m1';
const MOBILE_SLOT_PATH = '/api/v1/broker/connections/oauth/callback/m1';
const ENCRYPTION_KEY = 'unit-test-broker-encryption-key-32-bytes!!';
const AUTHORIZATION_CODE = 'the-single-use-code';
const ACCESS_TOKEN = 'SEKRIT-ACCESS-TOKEN';
const REFRESH_TOKEN = 'SEKRIT-REFRESH-TOKEN';

const discoveredAccounts = (): CtraderDiscoveredAccount[] => [
  {
    ctidTraderAccountId: 1234567,
    isLive: false,
    traderLogin: 987654,
    brokerTitleShort: 'Spotware',
  },
  {
    ctidTraderAccountId: 7654321,
    isLive: true,
    traderLogin: 123456,
    brokerTitleShort: 'Pepperstone',
  },
];

describe('BrokerOAuthService (Sprint 56 correction round 2 — findings 2 + 4)', () => {
  let service: BrokerOAuthService;
  let flowRepo: Repository<BrokerOAuthFlow>;
  let encryption: CredentialEncryptionService;
  let dataSource: DataSource;
  let brokerService: { createConnection: jest.Mock; findLiveConnectionByLogicalKey: jest.Mock };
  let linkOutbox: { enqueue: jest.Mock; enqueueWithinTransaction: jest.Mock; sweep: jest.Mock };
  let ctraderClient: {
    isAvailable: jest.Mock;
    buildAuthorizationUrl: jest.Mock;
    exchangeAuthorizationCode: jest.Mock;
    discoverAccounts: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let config: { get: jest.Mock };

  beforeAll(async () => {
    // REAL in-memory sqlite store — the entity schema is created by
    // synchronize (the production DDL comes from migration 1753800000000).
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [BrokerOAuthFlow],
    });
    await dataSource.initialize();
    flowRepo = dataSource.getRepository(BrokerOAuthFlow);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrokerOAuthService,
        {
          provide: BrokerService,
          useValue: {
            createConnection: jest.fn(),
            // Sprint 56 correction round 5 (#332): the durable-idempotency
            // adoption pre-check (no existing live connection by default).
            findLiveConnectionByLogicalKey: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: CTraderClientService,
          useValue: {
            isAvailable: jest.fn().mockReturnValue(true),
            buildAuthorizationUrl: jest
              .fn()
              .mockReturnValue(
                'https://id.ctrader.com/my/settings/openapi/grantingaccess/?client_id=pub-client-id&scope=trading&product=web',
              ),
            exchangeAuthorizationCode: jest.fn().mockResolvedValue({
              accessToken: ACCESS_TOKEN,
              refreshToken: REFRESH_TOKEN,
              expiresIn: 2_628_000,
            }),
            discoverAccounts: jest.fn().mockResolvedValue(discoveredAccounts()),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'broker.ctraderRedirectUris') {
                return `${WEB_REDIRECT},${MOBILE_REDIRECT}`;
              }
              if (key === 'broker.ctraderMobileCallbackUris') {
                return MOBILE_SLOT;
              }
              if (key === 'BROKER_ENCRYPTION_KEY') {
                return ENCRYPTION_KEY;
              }
              return undefined;
            }),
          },
        },
        CredentialEncryptionService,
        { provide: getRepositoryToken(BrokerOAuthFlow), useValue: flowRepo },
        // Sprint 56 correction round 5 (#332): the durable outbox (mocked at
        // this service seam — its real sweep semantics are proven in
        // broker-link-outbox.service.spec.ts and the end-to-end durable-link
        // behavior in broker-oauth.durable-link.spec.ts).
        {
          provide: BrokerLinkOutboxService,
          useValue: {
            enqueue: jest.fn().mockResolvedValue(undefined),
            enqueueWithinTransaction: jest.fn().mockResolvedValue(undefined),
            sweep: jest.fn().mockResolvedValue({ delivered: 0, failed: 0, deferred: 0 }),
          },
        },
      ],
    }).compile();
    service = module.get(BrokerOAuthService);
    encryption = module.get(CredentialEncryptionService);
    brokerService = module.get(BrokerService);
    linkOutbox = module.get(BrokerLinkOutboxService);
    ctraderClient = module.get(CTraderClientService);
    audit = module.get(AuditService);
    config = module.get(ConfigService);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Restore the default collaborator behavior (tests may override it) —
    // the module is compiled once in beforeAll, so mock state must be reset
    // per test exactly as the round-1 spec rebuilt its TestingModule.
    ctraderClient.isAvailable.mockReturnValue(true);
    ctraderClient.buildAuthorizationUrl.mockReturnValue(
      'https://id.ctrader.com/my/settings/openapi/grantingaccess/?client_id=pub-client-id&scope=trading&product=web',
    );
    ctraderClient.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    ctraderClient.discoverAccounts.mockResolvedValue(discoveredAccounts());
    brokerService.createConnection.mockReset();
    brokerService.findLiveConnectionByLogicalKey.mockReset();
    brokerService.findLiveConnectionByLogicalKey.mockResolvedValue(null);
    linkOutbox.enqueue.mockClear();
    linkOutbox.enqueueWithinTransaction.mockClear();
    linkOutbox.sweep.mockClear();
    // Restore the default config behavior (tests may override it).
    config.get.mockImplementation((key: string) => {
      if (key === 'broker.ctraderRedirectUris') {
        return `${WEB_REDIRECT},${MOBILE_REDIRECT}`;
      }
      if (key === 'broker.ctraderMobileCallbackUris') {
        return MOBILE_SLOT;
      }
      if (key === 'BROKER_ENCRYPTION_KEY') {
        return ENCRYPTION_KEY;
      }
      return undefined;
    });
    await flowRepo.clear();
  });

  const startFlow = (channel?: 'web' | 'mobile', redirectUri?: string) =>
    service.startAuthorization(USER, 'ctrader', undefined, redirectUri, channel);

  const completeFlow = (flowId: string, code = AUTHORIZATION_CODE) =>
    service.completeAuthorization(USER, flowId, code);

  const authorizedFlowId = async (): Promise<string> => {
    const start = await startFlow();
    await completeFlow(start.flowId);
    return start.flowId;
  };

  const row = (flowId: string) => flowRepo.findOne({ where: { id: flowId } });

  // ─── Step 1: authorize ──────────────────────────────────────────────────────

  describe('startAuthorization', () => {
    it('creates a single-use server-side flow and returns the official consent URL', async () => {
      const result = await startFlow();
      expect(result.authorizationUrl).toContain('https://id.ctrader.com/');
      expect(result.authorizationUrl).toContain('scope=trading');
      expect(result.flowId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.expiresAt).toBeDefined();
      // The consent URL is built with the DEFAULT (web) redirect.
      expect(ctraderClient.buildAuthorizationUrl).toHaveBeenCalledWith(WEB_REDIRECT);
      // The flow is PERSISTED in the shared store (replica-safe), user-bound,
      // broker-bound, and redirect-bound with the PENDING state + hard TTL.
      const stored = await row(result.flowId);
      expect(stored).toMatchObject({
        userId: USER,
        brokerId: 'ctrader',
        redirectUri: WEB_REDIRECT,
        state: 'PENDING',
      });
      expect(stored!.tokenCiphertext).toBeNull();
      // Audit: started, host-only redirect metadata.
      const started = audit.log.mock.calls.find(
        (c) => c[0].action === AuditAction.BROKER_OAUTH_FLOW_STARTED,
      );
      expect(started).toBeDefined();
      expect(started[0].metadata).toMatchObject({
        brokerId: 'ctrader',
        redirectHost: 'app.irexpro.com',
      });
    });

    it('rejects an allowlisted custom-scheme redirect for the WEB channel (finding 4)', async () => {
      // Custom app schemes are no longer production provider callbacks — the
      // provider code must be exchanged by the SERVER (registered HTTPS
      // callback), never delivered raw to a client-controlled scheme.
      await expect(startFlow('web', MOBILE_REDIRECT)).rejects.toThrow(BadRequestException);
      expect(ctraderClient.buildAuthorizationUrl).not.toHaveBeenCalled();
      expect(await flowRepo.count()).toBe(0);
    });

    it('rejects redirect URIs outside the server-configured allowlist', async () => {
      await expect(startFlow('web', 'https://evil.example.com/cb')).rejects.toThrow(
        BadRequestException,
      );
      expect(ctraderClient.buildAuthorizationUrl).not.toHaveBeenCalled();
    });

    it('rejects non-cTrader-family brokers (the flow is cTrader-only)', async () => {
      await expect(service.startAuthorization(USER, 'metatrader5')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.startAuthorization(USER, 'oanda')).rejects.toThrow(BadRequestException);
      // Family aliases ARE accepted.
      await expect(service.startAuthorization(USER, 'pepperstone-ctrader')).resolves.toBeDefined();
      await expect(service.startAuthorization(USER, 'icmarkets-ctrader')).resolves.toBeDefined();
    });

    it('fails closed with the honest blocker when platform app credentials are unconfigured', async () => {
      ctraderClient.isAvailable.mockReturnValue(false);
      const err = await service.startAuthorization(USER, 'ctrader').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain('CTRADER_CLIENT_ID');
    });

    it('fails closed when no redirect URI is configured', async () => {
      config.get.mockImplementation(() => undefined);
      await expect(service.startAuthorization(USER, 'ctrader')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('claims a configured mobile callback slot for the MOBILE channel (client redirect ignored)', async () => {
      const result = await startFlow('mobile', 'https://evil.example.com/cb');
      expect(ctraderClient.buildAuthorizationUrl).toHaveBeenCalledWith(MOBILE_SLOT);
      const stored = await row(result.flowId);
      expect(stored!.redirectUri).toBe(MOBILE_SLOT);
      expect(stored!.state).toBe('PENDING');
    });

    it('fails closed with operator guidance when no mobile callback slot is configured', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'broker.ctraderRedirectUris' ? WEB_REDIRECT : undefined,
      );
      const err = await startFlow('mobile').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain('CTRADER_MOBILE_CALLBACK_URIS');
    });

    it('reports all slots busy when the single configured slot is held (serialize)', async () => {
      await startFlow('mobile');
      await expect(startFlow('mobile')).rejects.toThrow(ConflictException);
    });
  });

  // ─── Step 3 (web): complete ─────────────────────────────────────────────────

  describe('completeAuthorization', () => {
    it('exchanges the code with the PLATFORM app credentials and returns sanitized accounts', async () => {
      const start = await startFlow();
      const result = await completeFlow(start.flowId);

      expect(ctraderClient.exchangeAuthorizationCode).toHaveBeenCalledWith(
        AUTHORIZATION_CODE,
        WEB_REDIRECT,
      );
      expect(ctraderClient.discoverAccounts).toHaveBeenCalledWith('DEMO', ACCESS_TOKEN);
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0]).toMatchObject({
        ctidTraderAccountId: '1234567',
        isLive: false,
        traderLogin: 987654,
        brokerTitleShort: 'Spotware',
      });
      // ADVERSARIAL: the response carries NO token material.
      expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(result)).not.toContain(REFRESH_TOKEN);
    });

    it('persists the token bundle ENCRYPTED at rest (ciphertext columns, decryptable server-side)', async () => {
      const start = await startFlow();
      await completeFlow(start.flowId);

      const stored = await row(start.flowId);
      expect(stored!.state).toBe('AUTHORIZED');
      expect(stored!.tokenCiphertext).toBeTruthy();
      expect(stored!.tokenIv).toBeTruthy();
      expect(stored!.tokenTag).toBeTruthy();
      // Ciphertext is hex — no plaintext token material in ANY persisted
      // column, and the sanitized accounts column carries no tokens either.
      const serializedRow = JSON.stringify(stored);
      expect(serializedRow).not.toContain(ACCESS_TOKEN);
      expect(serializedRow).not.toContain(REFRESH_TOKEN);
      expect(serializedRow).not.toContain(AUTHORIZATION_CODE);
      // The bundle round-trips through the real AES-256-GCM service.
      const bundle = encryption.decryptJson({
        ciphertext: stored!.tokenCiphertext!,
        iv: stored!.tokenIv!,
        tag: stored!.tokenTag!,
        keyId: stored!.tokenKeyId!,
      });
      expect(bundle).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
    });

    it('audits completion with counts and expiry ONLY (no tokens)', async () => {
      const start = await startFlow();
      await completeFlow(start.flowId);
      const completed = audit.log.mock.calls.find(
        (c) => c[0].action === AuditAction.BROKER_OAUTH_AUTHORIZATION_COMPLETED,
      );
      expect(completed).toBeDefined();
      const serialized = JSON.stringify(completed[0].metadata);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(REFRESH_TOKEN);
      expect(completed[0].metadata).toMatchObject({
        brokerId: 'ctrader',
        accountCount: 2,
        liveAccountCount: 1,
        demoAccountCount: 1,
        accessTokenExpiresAt: expect.any(String),
      });
    });

    it('treats an unknown flow and a FOREIGN flow identically (no existence oracle)', async () => {
      const start = await startFlow();
      await expect(service.completeAuthorization(FOREIGN_USER, start.flowId, 'x')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.completeAuthorization(USER, 'missing-flow', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('consumes the flow when the code exchange FAILS (no replay window)', async () => {
      ctraderClient.exchangeAuthorizationCode.mockRejectedValue(
        new BrokerAdapterError(BrokerErrorCode.AUTHENTICATION_FAILED, 'INVALID_CODE'),
      );
      const start = await startFlow();
      await expect(completeFlow(start.flowId)).rejects.toThrow(BadRequestException);
      // The flow is DEAD (row deleted via CAS) — even a later VALID code
      // cannot complete it.
      ctraderClient.exchangeAuthorizationCode.mockResolvedValue({
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresIn: 2_628_000,
      });
      await expect(completeFlow(start.flowId)).rejects.toThrow(NotFoundException);
      // Failed-exchange audit recorded (sanitized).
      const failed = audit.log.mock.calls.find(
        (c) => c[0].action === AuditAction.BROKER_OAUTH_AUTHORIZATION_FAILED,
      );
      expect(failed).toBeDefined();
      expect(JSON.stringify(failed[0].metadata)).not.toContain(ACCESS_TOKEN);
    });

    it('consumes the flow when account discovery FAILS (fail-closed)', async () => {
      ctraderClient.discoverAccounts.mockRejectedValue(
        new BrokerAdapterError(BrokerErrorCode.BROKER_SERVER_ERROR, 'DISCOVERY'),
      );
      const start = await startFlow();
      await expect(completeFlow(start.flowId)).rejects.toThrow(BadRequestException);
      await expect(completeFlow(start.flowId)).rejects.toThrow(NotFoundException);
    });

    it('rejects completing a flow twice (single-use states)', async () => {
      const start = await startFlow();
      await completeFlow(start.flowId);
      await expect(completeFlow(start.flowId, 'another-code')).rejects.toThrow(ConflictException);
    });

    it('rejects an expired PENDING flow and sweeps its row', async () => {
      const start = await startFlow();
      await flowRepo.update(start.flowId, {
        expiresAt: new Date(Date.now() - 1_000),
      });
      await expect(completeFlow(start.flowId)).rejects.toThrow(ConflictException);
      expect(await row(start.flowId)).toBeNull();
    });

    it('never logs token material (adversarial log spy)', async () => {
      const logged: string[] = [];
      const logger = (service as unknown as { logger: Record<string, jest.Mock> }).logger;
      const spies = ['log', 'warn', 'error'].map((level) =>
        jest.spyOn(logger, level).mockImplementation((m: unknown) => {
          logged.push(String(m));
        }),
      );
      try {
        const start = await startFlow();
        await completeFlow(start.flowId);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
      const all = logged.join('\n');
      expect(all).not.toContain(ACCESS_TOKEN);
      expect(all).not.toContain(REFRESH_TOKEN);
    });
  });

  // ─── Steps 2b + 3 (mobile): server callback + handoff exchange ──────────────

  describe('handleMobileCallback + exchangeHandoffToken (finding 4)', () => {
    it('completes SERVER-side and issues a high-entropy one-time handoff token', async () => {
      const start = await startFlow('mobile');
      // The provider code goes to the SERVER callback, never to the app.
      const result = await service.handleMobileCallback(MOBILE_SLOT_PATH, AUTHORIZATION_CODE);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      // High-entropy: 32 random bytes → ≥ 43 base64url chars.
      expect(result.handoffToken.length).toBeGreaterThanOrEqual(43);
      expect(result.handoffToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.flowId).toBe(start.flowId);

      // The exchange used the flow's SLOT redirect URI, server-side.
      expect(ctraderClient.exchangeAuthorizationCode).toHaveBeenCalledWith(
        AUTHORIZATION_CODE,
        MOBILE_SLOT,
      );

      // The store keeps ONLY the SHA-256 digest — never the raw token — and
      // the tokens remain encrypted at rest.
      const stored = await row(start.flowId);
      expect(stored!.state).toBe('AUTHORIZED');
      expect(stored!.handoffTokenHash).toBe(
        createHash('sha256').update(result.handoffToken, 'utf8').digest('hex'),
      );
      expect(stored!.handoffTokenHash).not.toBe(result.handoffToken);
      expect(stored!.handoffExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
      expect(JSON.stringify(stored)).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(stored)).not.toContain(REFRESH_TOKEN);
    });

    it('exchanges the handoff token for sanitized accounts, single-use', async () => {
      const start = await startFlow('mobile');
      const cb = await service.handleMobileCallback(MOBILE_SLOT_PATH, AUTHORIZATION_CODE);
      expect(cb.status).toBe('ok');
      if (cb.status !== 'ok') return;

      const exchanged = await service.exchangeHandoffToken(USER, cb.handoffToken);
      expect(exchanged.flowId).toBe(start.flowId);
      expect(exchanged.accounts).toHaveLength(2);
      // No token material in the exchange response.
      expect(JSON.stringify(exchanged)).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(exchanged)).not.toContain(REFRESH_TOKEN);
      // Replay fails closed as not-found (digest consumed).
      await expect(service.exchangeHandoffToken(USER, cb.handoffToken)).rejects.toThrow(
        NotFoundException,
      );
      // Audited with brokerId ONLY.
      const audited = audit.log.mock.calls.find(
        (c) => c[0].action === AuditAction.BROKER_OAUTH_HANDOFF_EXCHANGED,
      );
      expect(audited).toBeDefined();
      expect(audited[0].metadata).toEqual({ brokerId: 'ctrader' });
    });

    it('rejects a FOREIGN user exchanging the handoff token (cross-user = not-found)', async () => {
      await startFlow('mobile');
      const cb = await service.handleMobileCallback(MOBILE_SLOT_PATH, AUTHORIZATION_CODE);
      expect(cb.status).toBe('ok');
      if (cb.status !== 'ok') return;
      await expect(service.exchangeHandoffToken(FOREIGN_USER, cb.handoffToken)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects an EXPIRED handoff token (fail closed)', async () => {
      await startFlow('mobile');
      const cb = await service.handleMobileCallback(MOBILE_SLOT_PATH, AUTHORIZATION_CODE);
      expect(cb.status).toBe('ok');
      if (cb.status !== 'ok') return;
      await flowRepo.update(cb.flowId, {
        handoffExpiresAt: new Date(Date.now() - 1_000),
      });
      await expect(service.exchangeHandoffToken(USER, cb.handoffToken)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('errors with unknown-or-expired when no PENDING flow holds the slot', async () => {
      const result = await service.handleMobileCallback(MOBILE_SLOT_PATH, AUTHORIZATION_CODE);
      expect(result).toEqual({ status: 'error', reason: 'unknown-or-expired' });
      expect(ctraderClient.exchangeAuthorizationCode).not.toHaveBeenCalled();
    });

    it('errors with missing-code when the provider redirect carries no code', async () => {
      await startFlow('mobile');
      const result = await service.handleMobileCallback(MOBILE_SLOT_PATH, undefined);
      expect(result).toEqual({ status: 'error', reason: 'missing-code' });
      expect(ctraderClient.exchangeAuthorizationCode).not.toHaveBeenCalled();
    });

    it('fails closed HARD on an ambiguous callback (two PENDING flows, one slot) — no exchange', async () => {
      // Simulate a slot-claim race/corruption: two PENDING rows on one slot.
      await startFlow('mobile');
      await startFlow('mobile').catch(() => undefined); // second may Conflict
      const seeded = flowRepo.create({
        userId: FOREIGN_USER,
        brokerId: 'ctrader',
        redirectUri: MOBILE_SLOT,
        state: 'PENDING',
        stateChangedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await flowRepo.save(seeded);

      const result = await service.handleMobileCallback(MOBILE_SLOT_PATH, AUTHORIZATION_CODE);
      expect(result).toEqual({ status: 'error', reason: 'ambiguous' });
      // NEVER guess — no provider exchange happened at all.
      expect(ctraderClient.exchangeAuthorizationCode).not.toHaveBeenCalled();
      expect((await flowRepo.find({ where: { state: 'PENDING' as never } })).length).toBe(2);
    });

    it('errors with exchange-failed when the server-side code exchange fails (no retry data)', async () => {
      ctraderClient.exchangeAuthorizationCode.mockRejectedValue(
        new BrokerAdapterError(BrokerErrorCode.AUTHENTICATION_FAILED, 'INVALID_CODE'),
      );
      await startFlow('mobile');
      const result = await service.handleMobileCallback(MOBILE_SLOT_PATH, AUTHORIZATION_CODE);
      expect(result).toEqual({ status: 'error', reason: 'exchange-failed' });
      // The flow is consumed (fail-closed — no replay window) and no token
      // material leaked anywhere.
      expect(await flowRepo.count()).toBe(0);
    });
  });

  // ─── Step 4: link ───────────────────────────────────────────────────────────

  describe('linkAccount', () => {
    const linkedConnection = {
      id: 'new-conn-1',
      brokerId: 'ctrader',
      accountType: BrokerMode.DEMO,
    } as unknown as BrokerConnection;

    it('links a DEMO account through the CANONICAL createConnection path with encrypted tokens', async () => {
      brokerService.createConnection.mockResolvedValue(linkedConnection);
      const flowId = await authorizedFlowId();

      const result = await service.linkAccount(USER, flowId, '1234567', 'My Demo');

      expect(result).toBe(linkedConnection);
      expect(brokerService.createConnection).toHaveBeenCalledTimes(1);
      const dto: ConnectBrokerDto = brokerService.createConnection.mock.calls[0][0];
      // The environment derives from the SERVER-REPORTED isLive flag.
      expect(dto.accountType).toBe(BrokerMode.DEMO);
      expect(dto.accountId).toBe('1234567');
      // The OAuth tokens (decrypted from the store) ride the write-only
      // credential fields (encrypted at rest inside createConnection — never
      // returned).
      expect(dto.apiKey).toBe(ACCESS_TOKEN);
      expect(dto.additionalParams).toMatchObject({
        refreshToken: REFRESH_TOKEN,
        accessTokenExpiresAt: expect.any(String),
      });
      expect(dto.displayName).toBe('My Demo');
      // Sprint 56 correction round 5 (#332): the link path passes the
      // SERVER-COMPUTED logical account key + the OAuth link audit through the
      // INTERNAL serverDerived channel — they commit atomically with the
      // (mocked here) connection and are delivered by the outbox sweep.
      const serverDerived = brokerService.createConnection.mock.calls[0][3];
      expect(serverDerived.providerBrokerIdentity).toBe('spotware');
      expect(serverDerived.logicalAccountKey).toBe('ctrader|spotware|1234567');
      expect(serverDerived.flowId).toBe(flowId);
      expect(serverDerived.linkAudit.payload.action).toBe(
        AuditAction.BROKER_OAUTH_ACCOUNT_LINKED,
      );
      // Linked audit metadata: no tokens.
      expect(serverDerived.linkAudit.payload.metadata).toMatchObject({
        brokerId: 'ctrader',
        accountId: '1234567',
        accountType: BrokerMode.DEMO,
        via: 'oauth',
      });
      expect(JSON.stringify(serverDerived.linkAudit.payload.metadata)).not.toContain(ACCESS_TOKEN);
      // The linked audit is NO LONGER emitted synchronously on the critical
      // path (the old defect vector) — it is durable outbox work.
      const linked = audit.log.mock.calls.find(
        (c) => c[0].action === AuditAction.BROKER_OAUTH_ACCOUNT_LINKED,
      );
      expect(linked).toBeUndefined();
    });

    it('derives LIVE from the account flag and PROPAGATES the fail-closed LIVE rejection', async () => {
      // The production-LIVE gate lives inside createConnection (unverified
      // brokers reject LIVE) — OAuth must NOT weaken it.
      brokerService.createConnection.mockRejectedValue(
        new ForbiddenException(
          'Broker ctrader is not production-LIVE verified — LIVE connections are fail-closed (BETA is DEMO-only)',
        ),
      );
      const flowId = await authorizedFlowId();
      await expect(service.linkAccount(USER, flowId, '7654321')).rejects.toThrow(
        ForbiddenException,
      );
      const dto: ConnectBrokerDto = brokerService.createConnection.mock.calls[0][0];
      expect(dto.accountType).toBe(BrokerMode.LIVE);
    });

    it('consumes the flow after a successful link (single-use, tokens zeroed)', async () => {
      brokerService.createConnection.mockResolvedValue(linkedConnection);
      const flowId = await authorizedFlowId();
      await service.linkAccount(USER, flowId, '1234567');
      // The durable CONSUMED row fails closed on a second link (the in-memory
      // store previously returned NotFound after deletion — the security
      // property "exactly once" is unchanged).
      await expect(service.linkAccount(USER, flowId, '1234567')).rejects.toThrow(ConflictException);
      // The consumed row holds NO token material at all.
      const stored = await row(flowId);
      expect(stored!.state).toBe('CONSUMED');
      expect(stored!.tokenCiphertext).toBeNull();
      expect(stored!.accounts).toBeNull();
    });

    it('keeps the flow alive when linking FAILS (user can pick a DEMO account instead)', async () => {
      brokerService.createConnection.mockRejectedValueOnce(
        new ForbiddenException('not production-LIVE verified'),
      );
      const flowId = await authorizedFlowId();
      await expect(service.linkAccount(USER, flowId, '7654321')).rejects.toThrow(
        ForbiddenException,
      );
      // The LIVE attempt failed — the flow was RESTORED to AUTHORIZED, so the
      // DEMO account from the SAME authorization still links.
      expect((await row(flowId))!.state).toBe('AUTHORIZED');
      brokerService.createConnection.mockResolvedValue(linkedConnection);
      await expect(service.linkAccount(USER, flowId, '1234567')).resolves.toBe(linkedConnection);
    });

    // ─── Sprint 56 correction round 5 (architect issue #332): the
    // proof-based durable-linking contract (mocked-seam proofs — the
    // end-to-end durable proofs live in broker-oauth.durable-link.spec.ts).

    it('PROOF-BASED contract: a pre-persistence createConnection failure restores AUTHORIZED (zero durable side effects)', async () => {
      // With the outbox, createConnection throws ⟺ its transaction rolled
      // back — so ANY exception it throws proves zero durable rows and the
      // AUTHORIZED restore is retry-safe.
      brokerService.createConnection.mockRejectedValueOnce(
        new Error('transaction rolled back (simulated INSERT failure)'),
      );
      const flowId = await authorizedFlowId();
      await expect(service.linkAccount(USER, flowId, '1234567')).rejects.toThrow(
        'transaction rolled back (simulated INSERT failure)',
      );
      expect((await row(flowId))!.state).toBe('AUTHORIZED');
      expect((await row(flowId))!.tokenCiphertext).toBeTruthy();
      // Retry on the SAME flow succeeds (retry-safe).
      brokerService.createConnection.mockResolvedValue(linkedConnection);
      await expect(service.linkAccount(USER, flowId, '1234567')).resolves.toBe(linkedConnection);
      expect((await row(flowId))!.state).toBe('CONSUMED');
    });

    it('ADOPTS an existing connection when the pre-check finds the durable logical account (issue #332)', async () => {
      // A prior attempt committed the connection but failed to converge the
      // flow (post-commit ambiguous failure). The retry PROVES the durable
      // side effect exists via (userId, logicalAccountKey) and ADOPTS it.
      const existing = {
        id: 'existing-conn-9',
        brokerId: 'ctrader',
        accountType: BrokerMode.DEMO,
      } as unknown as BrokerConnection;
      brokerService.findLiveConnectionByLogicalKey.mockResolvedValue(existing);
      const flowId = await authorizedFlowId();

      const result = await service.linkAccount(USER, flowId, '1234567');

      // No second durable row is ever attempted.
      expect(brokerService.createConnection).not.toHaveBeenCalled();
      expect(result).toBe(existing);
      // The flow CONVERGED to CONSUMED with zeroed tokens (exactly once).
      const stored = await row(flowId);
      expect(stored!.state).toBe('CONSUMED');
      expect(stored!.tokenCiphertext).toBeNull();
      // The adoption audit is durable outbox work (via: oauth, adopted: true).
      expect(linkOutbox.enqueue).toHaveBeenCalledTimes(1);
      const entry = linkOutbox.enqueue.mock.calls[0][0];
      expect(entry.connectionId).toBe('existing-conn-9');
      expect(entry.eventType).toBe('oauth-account-linked-audit');
      expect(entry.payload.metadata).toMatchObject({ via: 'oauth', adopted: true });
      expect(JSON.stringify(entry.payload.metadata)).not.toContain(ACCESS_TOKEN);
    });

    it('ADOPTS an existing connection when createConnection hits the logical-account unique index (issue #332)', async () => {
      // The check-then-insert race: the pre-check missed, the INSERT hit the
      // per-user partial unique index, createConnection throws the typed
      // conflict carrying the existing row — the flow converges and the
      // EXISTING connection is returned (no second row).
      const existing = {
        id: 'existing-conn-raced',
        brokerId: 'ctrader',
        accountType: BrokerMode.DEMO,
      } as unknown as BrokerConnection;
      brokerService.createConnection.mockRejectedValueOnce(
        new BrokerLogicalAccountConflictError('ctrader|spotware|1234567', existing),
      );
      const flowId = await authorizedFlowId();

      const result = await service.linkAccount(USER, flowId, '1234567');

      expect(result).toBe(existing);
      const stored = await row(flowId);
      expect(stored!.state).toBe('CONSUMED');
      expect(stored!.tokenCiphertext).toBeNull();
      expect(linkOutbox.enqueue).toHaveBeenCalledTimes(1);
    });

    it('a logical-conflict ADOPTION still consumes the flow even when the adoption audit enqueue fails (best-effort)', async () => {
      const existing = {
        id: 'existing-conn-adopt',
        brokerId: 'ctrader',
      } as unknown as BrokerConnection;
      brokerService.createConnection.mockRejectedValueOnce(
        new BrokerLogicalAccountConflictError('ctrader|spotware|1234567', existing),
      );
      linkOutbox.enqueue.mockRejectedValueOnce(new Error('outbox insert down'));
      const flowId = await authorizedFlowId();

      const result = await service.linkAccount(USER, flowId, '1234567');

      // The durable truth (existing connection + converged flow) survives the
      // best-effort audit failure.
      expect(result).toBe(existing);
      expect((await row(flowId))!.state).toBe('CONSUMED');
    });

    it('rejects an account that was not part of the discovery', async () => {
      const flowId = await authorizedFlowId();
      await expect(service.linkAccount(USER, flowId, '9999999')).rejects.toThrow(
        BadRequestException,
      );
      expect(brokerService.createConnection).not.toHaveBeenCalled();
    });

    it('rejects a foreign user on every step (tenant isolation)', async () => {
      const start = await startFlow();
      await expect(service.linkAccount(FOREIGN_USER, start.flowId, '1234567')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects linking before authorization completed (state machine)', async () => {
      const start = await startFlow();
      await expect(service.linkAccount(USER, start.flowId, '1234567')).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects an expired AUTHORIZED flow (bounded token retention)', async () => {
      const flowId = await authorizedFlowId();
      await flowRepo.update(flowId, { expiresAt: new Date(Date.now() - 1_000) });
      await expect(service.linkAccount(USER, flowId, '1234567')).rejects.toThrow(ConflictException);
      expect(await row(flowId)).toBeNull();
    });

    it('rejects a link while a LINKING claim is fresh (single-use claim)', async () => {
      const flowId = await authorizedFlowId();
      await flowRepo.update(flowId, {
        state: 'LINKING',
        stateChangedAt: new Date(),
      });
      await expect(service.linkAccount(USER, flowId, '1234567')).rejects.toThrow(ConflictException);
    });

    it('NEVER re-claims a LINKING claim — not even far beyond the former 60s stale threshold (exactly-once, finding 2)', async () => {
      const flowId = await authorizedFlowId();
      // A crashed/abandoned LINKING claim, arbitrarily old. Correction round
      // 4: there is NO automatic stale reclaim — the flow must expire and
      // the user restarts OAuth. Re-claiming would allow a SECOND
      // createConnection side effect with only one final flow winner.
      await flowRepo.update(flowId, {
        state: 'LINKING',
        stateChangedAt: new Date(Date.now() - 300_000),
      });
      await expect(service.linkAccount(USER, flowId, '1234567')).rejects.toThrow(
        'Account linking is already in progress',
      );
      // No connection side effect was attempted by the rejected caller.
      expect(brokerService.createConnection).not.toHaveBeenCalled();
      // The flow row stays LINKING (not consumed, not restored).
      expect((await row(flowId))!.state).toBe('LINKING');
    });

    it('rejects a DIFFERENT-ACCOUNT takeover attempt on a claimed LINKING flow (finding 2)', async () => {
      // Instance A claimed account X ('1234567') and is mid-link. A second
      // call selecting account Y ('7654321') must NEVER link Y through A's
      // claimed flow.
      const flowId = await authorizedFlowId();
      await flowRepo.update(flowId, {
        state: 'LINKING',
        stateChangedAt: new Date(),
      });
      await expect(service.linkAccount(USER, flowId, '7654321')).rejects.toThrow(
        'Account linking is already in progress',
      );
      expect(brokerService.createConnection).not.toHaveBeenCalled();
    });

    it('consumes the flow when the stored token bundle cannot be decrypted (tampering)', async () => {
      const flowId = await authorizedFlowId();
      await flowRepo.update(flowId, {
        tokenCiphertext: 'deadbeefdeadbeefdeadbeef',
      });
      await expect(service.linkAccount(USER, flowId, '1234567')).rejects.toThrow(ConflictException);
      const stored = await row(flowId);
      expect(stored!.state).toBe('CONSUMED');
      expect(stored!.tokenCiphertext).toBeNull();
    });
  });

  // ─── Flow-store hygiene ─────────────────────────────────────────────────────

  describe('flow store bounds', () => {
    it('bounds the number of concurrent LIVE flows (fail-closed under flood)', async () => {
      const seeds = Array.from({ length: 1000 }, (_, i) =>
        flowRepo.create({
          userId: USER,
          brokerId: 'ctrader',
          redirectUri: `${WEB_REDIRECT}?seed=${i}`,
          state: 'PENDING',
          stateChangedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
      await flowRepo.save(seeds);
      await expect(service.startAuthorization(USER, 'ctrader')).rejects.toThrow(ConflictException);
      // CONSUMED/expired rows do NOT count toward the budget.
      await flowRepo.update({ state: 'PENDING' as never }, { state: 'CONSUMED' as never });
      await expect(service.startAuthorization(USER, 'ctrader')).resolves.toBeDefined();
    });

    it('sweeps expired flows so the store stays bounded over time', async () => {
      const stale = await startFlow();
      await flowRepo.update(stale.flowId, {
        expiresAt: new Date(Date.now() - 2 * 60 * 60_000),
      });
      // A new start sweeps rows past the 1h grace horizon.
      const fresh = await startFlow();
      expect(await row(stale.flowId)).toBeNull();
      expect(await row(fresh.flowId)).toBeDefined();
      expect(await flowRepo.count()).toBe(1);
    });
  });
});
