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

  it('reads the frozen high-conviction challenger status', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        artifact: 'plan-b-v4-oof-three-expert-consensus-challenger',
        mode: 'PROSPECTIVE_SHADOW_ONLY',
        configured: true,
        loaded: true,
        load_error: null,
        manifest_path: '/research/manifest.json',
        feature_count: 128,
        frozen_consensus: { opp_floor: 0.55, margin_floor: 0, votes_required: 3 },
        qualification_cutoff: '2026-09-02T19:59:00+00:00',
        sealed_future_holdout_touched: false,
        historical_validation: {
          n: 30,
          profit_factor: 2.15,
          sharpe: 1.4,
          balanced_accuracy: 0.525,
          max_drawdown: 0.0015,
          positive_fold_fraction: 1,
          positive_instrument_fraction: 2 / 3,
          median_gap_minutes: 245,
        },
        execution_authority: 'NONE',
        paper_promotion_eligible: false,
      }),
    });

    const status = await client.getPlanBV4ChallengerStatus();

    expect(status.loaded).toBe(true);
    expect(status.feature_count).toBe(128);
    expect(status.execution_authority).toBe('NONE');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/v1/models/challengers/plan-b-v4/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('scores the frozen challenger from broker-native MTF data', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        state: 'READY',
        reason: null,
        decision_time: '2026-10-05T10:00:00Z',
        market_data_sources: {
          M1: 'broker',
          M5: 'broker',
          M15: 'broker',
          H1: 'broker',
          H4: 'broker',
        },
        status: {},
        score: {
          artifact: 'plan-b-v4-oof-three-expert-consensus-challenger',
          mode: 'PROSPECTIVE_SHADOW_ONLY',
          modifies_execution: false,
          instrument: 'EURUSD',
          direction: 'BUY',
          admitted: true,
          ensemble_confidence: 0.72,
          mean_opportunity_probability: 0.61,
          mean_direction_confidence: 0.69,
          long_votes: 3,
          short_votes: 0,
          vote_margin: 1,
          votes_required: 3,
          opportunity_floor: 0.55,
          regime: 'calm',
          paper_promotion_eligible: false,
        },
      }),
    });

    const result = await client.scorePlanBV4ChallengerBroker({
      userId: 'user-1',
      brokerConnectionId: 'broker-native-1',
      instrument: 'EURUSD',
    });

    expect(result.state).toBe('READY');
    expect(result.score?.admitted).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/v1/models/challengers/plan-b-v4/score-broker',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          user_id: 'user-1',
          broker_connection_id: 'broker-native-1',
          instrument: 'EURUSD',
        }),
      }),
    );
  });

  it('reads v8.5 status and maps checkpoint scoring payload exactly', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          artifact: 'plan-b-v85-profitable-state-giveback-classifier-v1',
          mode: 'PROSPECTIVE_SHADOW_ONLY',
          configured: true,
          loaded: true,
          load_error: null,
          manifest_path: '/research/v85/manifest.json',
          manifest_sha256_pinned: true,
          manifest_sha256_verified: true,
          feature_count: 41,
          checkpoint_minutes: [5, 10, 15, 30, 60, 120, 240],
          minimum_current_profit_r: 0.25,
          giveback_label_r: 0.4,
          probability_threshold: 0.6,
          development_delta: {
            n: 1287,
            net_r: 40.33,
            profit_factor: 1.62,
            sharpe: 2.67,
            max_drawdown: 0.076,
          },
          sealed_future_holdout_touched: false,
          execution_authority: 'NONE',
          modifies_execution: false,
          paper_promotion_eligible: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          state: 'READY',
          reason: null,
          status: {},
          checkpoint_at: '2026-10-05T10:05:00Z',
          market_data_sources: { M1: 'metaapi' },
          score: {
            artifact: 'plan-b-v85-profitable-state-giveback-classifier-v1',
            mode: 'PROSPECTIVE_SHADOW_ONLY',
            probability: 0.71,
            threshold: 0.6,
            current_r: 0.55,
            eligible_profit_state: true,
            action: 'PROTECT_SHADOW',
            modifies_execution: false,
            execution_authority: 'NONE',
            paper_promotion_eligible: false,
          },
        }),
      });

    const status = await client.getPlanBV85PostEntryStatus();
    expect(status.loaded).toBe(true);
    expect(status.execution_authority).toBe('NONE');

    const result = await client.scorePlanBV85PostEntryBrokerCheckpoint({
      userId: 'user-1',
      brokerConnectionId: 'broker-native-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      entryPrice: 1.1,
      stopLoss: 1.099,
      openedAt: new Date('2026-10-05T10:00:00Z'),
      checkpointMinutes: 5,
      confidence: 0.68,
      candidateScore: 0.72,
      extensionAtr: 0.8,
      volatilityScore: 0.3,
      emaSeparation: 0.2,
      mtfStrength: 0.6,
      rsi14: 61,
    });

    expect(result.score?.action).toBe('PROTECT_SHADOW');
    expect(global.fetch).toHaveBeenLastCalledWith(
      'http://localhost:8001/api/v1/models/challengers/plan-b-v85/score-broker-checkpoint',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          user_id: 'user-1',
          broker_connection_id: 'broker-native-1',
          instrument: 'EURUSD',
          direction: 'BUY',
          entry_price: 1.1,
          stop_loss: 1.099,
          opened_at: '2026-10-05T10:00:00.000Z',
          checkpoint_minutes: 5,
          confidence: 0.68,
          candidate_score: 0.72,
          extension_atr: 0.8,
          volatility_score: 0.3,
          ema_separation: 0.2,
          mtf_strength: 0.6,
          rsi14: 61,
        }),
      }),
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
