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

  it('closes an unsynchronized pooled RPC connection before replacing it', async () => {
    await service.getOrCreateConnection(accountId);
    connection.isSynchronized.mockReturnValue(false);

    const replacement = {
      connect: jest.fn().mockResolvedValue(undefined),
      waitSynchronized: jest.fn().mockResolvedValue(undefined),
      isSynchronized: jest.fn().mockReturnValue(true),
      close: jest.fn().mockResolvedValue(undefined),
    };
    account.getRPCConnection.mockReturnValueOnce(replacement);

    const result = await service.getOrCreateConnection(accountId);

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(result).toBe(replacement);
    expect(replacement.connect).toHaveBeenCalledTimes(1);
  });

  it('closes a half-open RPC connection when synchronization fails', async () => {
    connection.waitSynchronized.mockRejectedValueOnce(new Error('sync timeout'));

    await expect(service.getOrCreateConnection(accountId)).rejects.toThrow('sync timeout');

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(service.hasConnection(accountId)).toBe(false);
  });

  it('closes an unsynchronized shared in-flight connection when a synchronized waiter fails', async () => {
    let releaseConnect!: () => void;
    let markConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    connection.connect.mockImplementationOnce(async () => {
      markConnectStarted();
      await connectGate;
    });
    connection.isSynchronized.mockReturnValue(false);
    connection.waitSynchronized.mockRejectedValueOnce(new Error('shared sync timeout'));

    const unsynchronizedCaller = service.getOrCreateConnection(accountId, {
      requireSynchronization: false,
    });
    await connectStarted;
    const synchronizedCaller = service.getOrCreateConnection(accountId, {
      requireSynchronization: true,
    });
    releaseConnect();

    await expect(unsynchronizedCaller).resolves.toBe(connection);
    await expect(synchronizedCaller).rejects.toThrow('shared sync timeout');
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(service.hasConnection(accountId)).toBe(false);
  });

  it('does not remove a newer pooled connection when asked to invalidate an older connection', async () => {
    await service.getOrCreateConnection(accountId);
    const oldConnection = connection;
    oldConnection.isSynchronized.mockReturnValue(false);
    const replacement = {
      connect: jest.fn().mockResolvedValue(undefined),
      waitSynchronized: jest.fn().mockResolvedValue(undefined),
      isSynchronized: jest.fn().mockReturnValue(true),
      close: jest.fn().mockResolvedValue(undefined),
    };
    account.getRPCConnection.mockReturnValueOnce(replacement);
    await service.getOrCreateConnection(accountId);

    await service.removeConnection(accountId, oldConnection);

    expect(service.hasConnection(accountId)).toBe(true);
    expect(replacement.close).not.toHaveBeenCalled();
  });
});
