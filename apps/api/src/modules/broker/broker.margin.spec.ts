import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BrokerService } from './broker.service';
import { BrokerConnection } from './entities/broker-connection.entity';
import { BrokerAccount } from './entities/broker-account.entity';
import { BrokerAdapterRegistry } from './adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from './registry/broker-provider-registry.service';
import { CredentialEncryptionService } from './services/credential-encryption.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { BrokerMode } from './interfaces/broker-adapter.interface';

describe('BrokerService — account-scoped required margin', () => {
  it('passes decrypted provider account reference and clears credentials', async () => {
    const credentials: Record<string, string | null> = {
      apiKey: 'k',
      apiSecret: 's',
      accountId: 'metaapi-account-A',
    };
    const adapter = {
      setMode: jest.fn(),
      getRequiredMargin: jest.fn().mockResolvedValue('100.00'),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrokerService,
        {
          provide: getRepositoryToken(BrokerConnection),
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: 'conn-1',
              brokerId: 'metatrader5',
              accountType: BrokerMode.LIVE,
              // A3: connected + usable credential state
              status: 'CONNECTED',
              credentialStatus: 'VERIFIED',
              encryptedCredentials: 'cipher',
              credentialIv: 'iv',
              credentialTag: 'tag',
              encryptionKeyId: 'key',
            }),
          },
        },
        { provide: getRepositoryToken(BrokerAccount), useValue: {} },
        {
          provide: BrokerAdapterRegistry,
          useValue: { getAdapter: jest.fn().mockReturnValue(adapter) },
        },
        {
          provide: BrokerProviderRegistryService,
          useValue: { supportsEnvironment: jest.fn().mockReturnValue(true) },
        },
        {
          provide: CredentialEncryptionService,
          useValue: { decrypt: jest.fn().mockReturnValue(credentials) },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
      ],
    }).compile();
    const service = module.get(BrokerService);
    await expect(
      service.getRequiredMargin('conn-1', {
        instrument: 'EURUSD',
        lotSize: '0.10',
        direction: 'BUY',
      }),
    ).resolves.toBe('100.00');
    expect(adapter.getRequiredMargin).toHaveBeenCalledWith(
      expect.objectContaining({ connectionReference: 'metaapi-account-A' }),
    );
    expect(credentials.apiKey).toBeNull();
    expect(credentials.apiSecret).toBeNull();
    expect(credentials.accountId).toBeNull();
  });

  it('clears decrypted credentials when required-margin calculation throws', async () => {
    const credentials: Record<string, string | null> = {
      apiKey: 'k',
      apiSecret: 's',
      accountId: 'metaapi-account-B',
    };
    const adapter = {
      setMode: jest.fn(),
      getRequiredMargin: jest.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrokerService,
        {
          provide: getRepositoryToken(BrokerConnection),
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: 'conn-2',
              brokerId: 'metatrader5',
              accountType: BrokerMode.LIVE,
              // A3: connected + usable credential state
              status: 'CONNECTED',
              credentialStatus: 'VERIFIED',
              encryptedCredentials: 'cipher',
              credentialIv: 'iv',
              credentialTag: 'tag',
              encryptionKeyId: 'key',
            }),
          },
        },
        { provide: getRepositoryToken(BrokerAccount), useValue: {} },
        {
          provide: BrokerAdapterRegistry,
          useValue: { getAdapter: jest.fn().mockReturnValue(adapter) },
        },
        {
          provide: BrokerProviderRegistryService,
          useValue: { supportsEnvironment: jest.fn().mockReturnValue(true) },
        },
        {
          provide: CredentialEncryptionService,
          useValue: { decrypt: jest.fn().mockReturnValue(credentials) },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: DomainEventBus, useValue: { publish: jest.fn() } },
      ],
    }).compile();
    const service = module.get(BrokerService);
    await expect(
      service.getRequiredMargin('conn-2', {
        instrument: 'EURUSD',
        lotSize: '0.10',
        direction: 'SELL',
      }),
    ).resolves.toBeNull();
    expect(credentials.apiKey).toBeNull();
    expect(credentials.apiSecret).toBeNull();
    expect(credentials.accountId).toBeNull();
  });
});
