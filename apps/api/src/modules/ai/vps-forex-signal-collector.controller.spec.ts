import { VpsForexSignalCollectorController } from './vps-forex-signal-collector.controller';
import { VpsForexSignalCollectorService } from './vps-forex-signal-collector.service';

describe('VpsForexSignalCollectorController', () => {
  it('scopes status to the authenticated user and exposes no configuration secrets', async () => {
    const getStatus = jest.fn().mockResolvedValue({
      providerCode: 'vps-twelvedata-six-pair-v7',
      enabled: false,
      configured: false,
      state: 'WAITING_FOR_CONFIGURATION',
      paperOnly: true,
    });
    const controller = new VpsForexSignalCollectorController({
      getStatus,
    } as unknown as VpsForexSignalCollectorService);

    const result = await controller.getStatus('user-1');

    expect(getStatus).toHaveBeenCalledWith('user-1');
    expect(result).not.toHaveProperty('apiKey');
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('brokerConnectionId');
  });
});
