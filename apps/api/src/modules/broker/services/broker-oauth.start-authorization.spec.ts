import { BrokerOAuthService } from './broker-oauth.service';

const MOBILE_SLOT =
  'https://irexpro.lightworldtech.com/api/v1/broker/connections/oauth/callback/m1';

describe('BrokerOAuthService mobile authorization prerequisites', () => {
  it('starts mobile OAuth with a mobile callback slot even when no web redirect is configured', async () => {
    const queryBuilder = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const flowRepo = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      count: jest
        .fn()
        .mockResolvedValueOnce(0) // global live-flow budget
        .mockResolvedValueOnce(0) // slot is free
        .mockResolvedValueOnce(1), // race guard sees only our row
      create: jest.fn((input: Record<string, unknown>) => ({
        id: '11111111-1111-4111-8111-111111111111',
        ...input,
      })),
      save: jest.fn(async (flow: unknown) => flow),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const ctraderClient = {
      isAvailable: jest.fn().mockReturnValue(true),
      buildAuthorizationUrl: jest.fn().mockReturnValue('https://id.ctrader.com/authorize'),
    };
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const configService = {
      get: jest.fn((key: string, defaultValue?: string) => {
        if (key === 'broker.ctraderMobileCallbackUris') return MOBILE_SLOT;
        return defaultValue;
      }),
    };

    const service = new BrokerOAuthService(
      {} as never,
      ctraderClient as never,
      auditService as never,
      configService as never,
      {} as never,
      flowRepo as never,
      {} as never,
    );

    const result = await service.startAuthorization(
      'user-1',
      'ctrader',
      undefined,
      undefined,
      'mobile',
    );

    expect(result.flowId).toBe('11111111-1111-4111-8111-111111111111');
    expect(ctraderClient.buildAuthorizationUrl).toHaveBeenCalledWith(MOBILE_SLOT);
    expect(flowRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: MOBILE_SLOT, state: 'PENDING' }),
    );
  });
});
