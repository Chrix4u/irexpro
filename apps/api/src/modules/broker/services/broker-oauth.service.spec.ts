import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

const USER = 'user-1';
const FOREIGN_USER = 'user-2';
const WEB_REDIRECT = 'https://app.irexpro.com/onboarding/broker/callback';
const MOBILE_REDIRECT = 'irexpro://broker/oauth/callback';
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

describe('BrokerOAuthService (Sprint 56 correction — audit point 6)', () => {
  let service: BrokerOAuthService;
  let brokerService: { createConnection: jest.Mock };
  let ctraderClient: {
    isAvailable: jest.Mock;
    buildAuthorizationUrl: jest.Mock;
    exchangeAuthorizationCode: jest.Mock;
    discoverAccounts: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrokerOAuthService,
        {
          provide: BrokerService,
          useValue: { createConnection: jest.fn() },
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
              return undefined;
            }),
          },
        },
      ],
    }).compile();
    service = module.get(BrokerOAuthService);
    brokerService = module.get(BrokerService);
    ctraderClient = module.get(CTraderClientService);
    audit = module.get(AuditService);
    config = module.get(ConfigService);
  });

  // ─── Step 1: authorize ──────────────────────────────────────────────────────

  describe('startAuthorization', () => {
    it('creates a single-use server-side flow and returns the official consent URL', async () => {
      const result = await service.startAuthorization(USER, 'ctrader', undefined, undefined);
      expect(result.authorizationUrl).toContain('https://id.ctrader.com/');
      expect(result.authorizationUrl).toContain('scope=trading');
      expect(result.flowId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.expiresAt).toBeDefined();
      // The consent URL is built with the DEFAULT (web) redirect.
      expect(ctraderClient.buildAuthorizationUrl).toHaveBeenCalledWith(WEB_REDIRECT);
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

    it('supports an allowlisted mobile deep-link redirect', async () => {
      await service.startAuthorization(USER, 'ctrader', undefined, MOBILE_REDIRECT);
      expect(ctraderClient.buildAuthorizationUrl).toHaveBeenCalledWith(MOBILE_REDIRECT);
    });

    it('rejects redirect URIs outside the server-configured allowlist', async () => {
      await expect(
        service.startAuthorization(USER, 'ctrader', undefined, 'https://evil.example.com/cb'),
      ).rejects.toThrow(BadRequestException);
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
  });

  // ─── Step 3: complete ───────────────────────────────────────────────────────

  describe('completeAuthorization', () => {
    it('exchanges the code with the PLATFORM app credentials and returns sanitized accounts', async () => {
      const start = await service.startAuthorization(USER, 'ctrader');
      const result = await service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);

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

    it('audits completion with counts and expiry ONLY (no tokens)', async () => {
      const start = await service.startAuthorization(USER, 'ctrader');
      await service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);
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
      });
    });

    it('treats an unknown flow and a FOREIGN flow identically (no existence oracle)', async () => {
      const start = await service.startAuthorization(USER, 'ctrader');
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
      const start = await service.startAuthorization(USER, 'ctrader');
      await expect(
        service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE),
      ).rejects.toThrow(BadRequestException);
      // The flow is DEAD — even a later VALID code cannot complete it.
      ctraderClient.exchangeAuthorizationCode.mockResolvedValue({
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresIn: 2_628_000,
      });
      await expect(
        service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE),
      ).rejects.toThrow(NotFoundException);
      // Failed-exchange audit recorded (sanitized).
      const failed = audit.log.mock.calls.find(
        (c) => c[0].action === AuditAction.BROKER_OAUTH_AUTHORIZATION_FAILED,
      );
      expect(failed).toBeDefined();
      expect(JSON.stringify(failed[0].metadata)).not.toContain(ACCESS_TOKEN);
    });

    it('rejects completing a flow twice (single-use states)', async () => {
      const start = await service.startAuthorization(USER, 'ctrader');
      await service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);
      await expect(
        service.completeAuthorization(USER, start.flowId, 'another-code'),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects an expired PENDING flow', async () => {
      jest.useFakeTimers();
      const start = await service.startAuthorization(USER, 'ctrader');
      await jest.advanceTimersByTimeAsync(11 * 60_000);
      await expect(
        service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE),
      ).rejects.toThrow(ConflictException);
      jest.useRealTimers();
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
        const start = await service.startAuthorization(USER, 'ctrader');
        await service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
      const all = logged.join('\n');
      expect(all).not.toContain(ACCESS_TOKEN);
      expect(all).not.toContain(REFRESH_TOKEN);
    });
  });

  // ─── Step 4: link ───────────────────────────────────────────────────────────

  describe('linkAccount', () => {
    const linkedConnection = {
      id: 'new-conn-1',
      brokerId: 'ctrader',
      accountType: BrokerMode.DEMO,
    } as unknown as BrokerConnection;

    async function authorizedFlow(): Promise<string> {
      const start = await service.startAuthorization(USER, 'ctrader');
      await service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);
      return start.flowId;
    }

    it('links a DEMO account through the CANONICAL createConnection path with encrypted tokens', async () => {
      brokerService.createConnection.mockResolvedValue(linkedConnection);
      const flowId = await authorizedFlow();

      const result = await service.linkAccount(USER, flowId, '1234567', 'My Demo');

      expect(result).toBe(linkedConnection);
      expect(brokerService.createConnection).toHaveBeenCalledTimes(1);
      const dto: ConnectBrokerDto = brokerService.createConnection.mock.calls[0][0];
      // The environment derives from the SERVER-REPORTED isLive flag.
      expect(dto.accountType).toBe(BrokerMode.DEMO);
      expect(dto.accountId).toBe('1234567');
      // The OAuth tokens ride the write-only credential fields (encrypted at
      // rest inside createConnection — never returned).
      expect(dto.apiKey).toBe(ACCESS_TOKEN);
      expect(dto.additionalParams).toMatchObject({
        refreshToken: REFRESH_TOKEN,
        accessTokenExpiresAt: expect.any(String),
      });
      expect(dto.displayName).toBe('My Demo');
      // Linked audit: no tokens.
      const linked = audit.log.mock.calls.find(
        (c) => c[0].action === AuditAction.BROKER_OAUTH_ACCOUNT_LINKED,
      );
      expect(linked[0].metadata).toMatchObject({
        brokerId: 'ctrader',
        accountId: '1234567',
        accountType: BrokerMode.DEMO,
        via: 'oauth',
      });
      expect(JSON.stringify(linked[0].metadata)).not.toContain(ACCESS_TOKEN);
    });

    it('derives LIVE from the account flag and PROPAGATES the fail-closed LIVE rejection', async () => {
      // The production-LIVE gate lives inside createConnection (unverified
      // brokers reject LIVE) — OAuth must NOT weaken it.
      brokerService.createConnection.mockRejectedValue(
        new ForbiddenException(
          'Broker ctrader is not production-LIVE verified — LIVE connections are fail-closed (BETA is DEMO-only)',
        ),
      );
      const flowId = await authorizedFlow();
      await expect(service.linkAccount(USER, flowId, '7654321')).rejects.toThrow(
        ForbiddenException,
      );
      const dto: ConnectBrokerDto = brokerService.createConnection.mock.calls[0][0];
      expect(dto.accountType).toBe(BrokerMode.LIVE);
    });

    it('consumes the flow after a successful link (single-use)', async () => {
      brokerService.createConnection.mockResolvedValue(linkedConnection);
      const flowId = await authorizedFlow();
      await service.linkAccount(USER, flowId, '1234567');
      await expect(service.linkAccount(USER, flowId, '1234567')).rejects.toThrow(NotFoundException);
    });

    it('keeps the flow alive when linking FAILS (user can pick a DEMO account instead)', async () => {
      brokerService.createConnection.mockRejectedValueOnce(
        new ForbiddenException('not production-LIVE verified'),
      );
      const flowId = await authorizedFlow();
      await expect(service.linkAccount(USER, flowId, '7654321')).rejects.toThrow(
        ForbiddenException,
      );
      // The LIVE attempt failed — the DEMO account from the SAME
      // authorization still links.
      brokerService.createConnection.mockResolvedValue(linkedConnection);
      await expect(service.linkAccount(USER, flowId, '1234567')).resolves.toBe(linkedConnection);
    });

    it('rejects an account that was not part of the discovery', async () => {
      const flowId = await authorizedFlow();
      await expect(service.linkAccount(USER, flowId, '9999999')).rejects.toThrow(
        BadRequestException,
      );
      expect(brokerService.createConnection).not.toHaveBeenCalled();
    });

    it('rejects a foreign user on every step (tenant isolation)', async () => {
      const start = await service.startAuthorization(USER, 'ctrader');
      await expect(service.linkAccount(FOREIGN_USER, start.flowId, '1234567')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects linking before authorization completed (state machine)', async () => {
      const start = await service.startAuthorization(USER, 'ctrader');
      await expect(service.linkAccount(USER, start.flowId, '1234567')).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects an expired AUTHORIZED flow (bounded token retention)', async () => {
      jest.useFakeTimers();
      const start = await service.startAuthorization(USER, 'ctrader');
      await service.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);
      await jest.advanceTimersByTimeAsync(6 * 60_000);
      await expect(service.linkAccount(USER, start.flowId, '1234567')).rejects.toThrow(
        ConflictException,
      );
      jest.useRealTimers();
    });
  });

  // ─── Flow-store hygiene ─────────────────────────────────────────────────────

  describe('flow store bounds', () => {
    it('bounds the number of concurrent flows (fail-closed under flood)', async () => {
      const many = await Promise.all(
        Array.from({ length: 1000 }, () => service.startAuthorization(USER, 'ctrader')),
      );
      expect(many).toHaveLength(1000);
      await expect(service.startAuthorization(USER, 'ctrader')).rejects.toThrow(ConflictException);
    });

    it('sweeps expired flows so the store stays bounded over time', async () => {
      jest.useFakeTimers();
      await service.startAuthorization(USER, 'ctrader'); // expires in 10 min
      await jest.advanceTimersByTimeAsync(11 * 60_000);
      // A new start sweeps the expired entry — the store never grows unbounded.
      await service.startAuthorization(USER, 'ctrader');
      // The expired flow is gone (NotFound, not Conflict).
      const logger = (service as unknown as { flows: Map<string, unknown> }).flows;
      expect(logger.size).toBe(1);
      jest.useRealTimers();
    });
  });
});
