import { ConfigService } from '@nestjs/config';
import { AiEngineClient } from './ai-engine-client.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';

describe('AiEngineClient', () => {
  let client: AiEngineClient;
  let configService: jest.Mocked<Partial<ConfigService>>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'aiEngine.schedulerEnabled') return true;
        if (key === 'aiEngine.baseUrl') return 'http://localhost:8001/api/v1';
        if (key === 'internalApi.key') return 'test-internal-key';
        return undefined;
      }),
    };
    client = new AiEngineClient(configService as unknown as ConfigService);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('scheduler integration is disabled by default in config schema', () => {
    const disabledConfig = {
      get: jest.fn().mockReturnValue(false),
    };
    const disabledClient = new AiEngineClient(disabledConfig as unknown as ConfigService);
    expect(disabledClient.isSchedulerIntegrationEnabled()).toBe(false);
  });

  it('notifySessionStarted posts to AI engine when enabled', async () => {
    await client.notifySessionStarted({
      userId: 'user-1',
      tradingSessionId: 'session-1',
      brokerConnectionId: 'conn-1',
      instruments: ['EURUSD'],
      timeframe: 'H1',
      source: 'broker',
      mode: ExecutionMode.PAPER_ONLY,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/v1/scheduler/sessions/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-irexpro-internal-api-key': 'test-internal-key',
        }),
      }),
    );
  });

  it('notifySessionStopped posts to AI engine when enabled', async () => {
    await client.notifySessionStopped({ tradingSessionId: 'session-1' });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/v1/scheduler/sessions/stop',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('skips notification when scheduler integration is disabled', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'aiEngine.schedulerEnabled') return false;
      return undefined;
    });

    await client.notifySessionStarted({
      userId: 'user-1',
      tradingSessionId: 'session-1',
      brokerConnectionId: 'conn-1',
      instruments: ['EURUSD'],
      timeframe: 'H1',
      source: 'broker',
      mode: ExecutionMode.PAPER_ONLY,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
