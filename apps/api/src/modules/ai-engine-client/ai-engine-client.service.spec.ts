import { ConfigService } from '@nestjs/config';
import { AiEngineClient } from './ai-engine-client.service';
import { BrokerMode } from '../broker/interfaces/broker-adapter.interface';
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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        registered: true,
        trading_session_id: 'session-1',
        message: 'Session scheduler registered',
      }),
    });
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
      accountType: BrokerMode.DEMO,
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

  it('reads scheduler runtime status when enabled', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        enabled: true,
        registered: true,
        trading_session_id: 'session-1',
        active: true,
        instruments: ['EURUSD'],
        timeframe: 'H1',
        interval_seconds: 60,
        source: 'broker',
        last_run_at: null,
        next_run_at: '2026-09-19T11:30:00.000Z',
        last_decision: null,
        last_reason: null,
        last_confidence_score: null,
        confidence_threshold: 0.6,
        last_publish_failed: false,
      }),
    });

    const status = await client.getSessionStatus('session-1');

    expect(status.registered).toBe(true);
    expect(status.active).toBe(true);
    expect(status.confidence_threshold).toBe(0.6);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/v1/scheduler/sessions/status',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fails closed when the internal API key is missing', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'aiEngine.schedulerEnabled') return true;
      if (key === 'aiEngine.baseUrl') return 'http://localhost:8001/api/v1';
      if (key === 'internalApi.key') return undefined;
      return undefined;
    });

    await expect(client.getSessionStatus('session-1')).rejects.toThrow(
      'AI engine internal API key is not configured',
    );
    expect(global.fetch).not.toHaveBeenCalled();
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
      accountType: BrokerMode.DEMO,
      mode: ExecutionMode.PAPER_ONLY,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
