jest.mock('metaapi.cloud-sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    metatraderAccountApi: {
      getAccount: jest.fn(),
    },
  })),
}));

import { ConfigService } from '@nestjs/config';
import MetaApi from 'metaapi.cloud-sdk';
import { MetaApiClientService } from './metaapi-client.service';

describe('MetaApiClientService', () => {
  const accountId = 'metaapi-account-1';
  let service: MetaApiClientService;
  let getAccount: jest.Mock;
  let account: {
    state: string;
    deploy: jest.Mock;
    waitDeployed: jest.Mock;
    getRPCConnection: jest.Mock;
  };
  let connection: {
    connect: jest.Mock;
    waitSynchronized: jest.Mock;
    isSynchronized: jest.Mock;
    close: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    connection = {
      connect: jest.fn().mockResolvedValue(undefined),
      waitSynchronized: jest.fn().mockResolvedValue(undefined),
      isSynchronized: jest.fn().mockReturnValue(true),
      close: jest.fn().mockResolvedValue(undefined),
    };
    account = {
      state: 'DEPLOYED',
      deploy: jest.fn().mockResolvedValue(undefined),
      waitDeployed: jest.fn().mockResolvedValue(undefined),
      getRPCConnection: jest.fn().mockReturnValue(connection),
    };

    service = new MetaApiClientService({
      get: jest.fn().mockReturnValue('test-token'),
    } as unknown as ConfigService);

    const sdk = (MetaApi as unknown as jest.Mock).mock.results[0].value;
    getAccount = sdk.metatraderAccountApi.getAccount;
    getAccount.mockResolvedValue(account);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('shares one in-flight RPC connection creation across concurrent callers', async () => {
    const [first, second, third] = await Promise.all([
      service.getOrCreateConnection(accountId),
      service.getOrCreateConnection(accountId),
      service.getOrCreateConnection(accountId),
    ]);

    expect(first).toBe(connection);
    expect(second).toBe(connection);
    expect(third).toBe(connection);
    expect(getAccount).toHaveBeenCalledTimes(1);
    expect(account.getRPCConnection).toHaveBeenCalledTimes(1);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(connection.waitSynchronized).toHaveBeenCalledTimes(1);
  });
});
