import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { AuditService } from '../../audit/audit.service';
import type { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import type { BrokerOAuthFlow } from '../entities/broker-oauth-flow.entity';
import type { BrokerService } from '../broker.service';
import type { BrokerLinkOutboxService } from './broker-link-outbox.service';
import type { CredentialEncryptionService } from './credential-encryption.service';
import { BrokerOAuthService } from './broker-oauth.service';

describe('BrokerOAuthService cTrader application approval gate', () => {
  it('fails closed before creating an OAuth flow while Spotware approval is pending', async () => {
    const ctraderClient = {
      isAvailable: jest.fn().mockReturnValue(true),
      buildAuthorizationUrl: jest.fn(),
    } as unknown as CTraderClientService;
    const config = {
      get: jest.fn((key: string, fallback?: string) =>
        key === 'broker.ctraderAppApprovalStatus' ? 'pending' : fallback,
      ),
    } as unknown as ConfigService;
    const flowRepo = {
      count: jest.fn(),
      save: jest.fn(),
    } as unknown as Repository<BrokerOAuthFlow>;

    const service = new BrokerOAuthService(
      {} as BrokerService,
      ctraderClient,
      {} as AuditService,
      config,
      {} as CredentialEncryptionService,
      flowRepo,
      {} as BrokerLinkOutboxService,
    );

    await expect(service.startAuthorization('user-1', 'ctrader')).rejects.toThrow(
      'cTrader Open API access is awaiting Spotware application approval.',
    );
    expect(ctraderClient.buildAuthorizationUrl).not.toHaveBeenCalled();
    expect(flowRepo.count).not.toHaveBeenCalled();
    expect(flowRepo.save).not.toHaveBeenCalled();
  });
});
