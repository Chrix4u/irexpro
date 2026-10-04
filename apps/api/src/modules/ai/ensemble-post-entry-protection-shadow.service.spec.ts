import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import {
  EnsemblePostEntryProtectionShadowService,
  parseV85ShadowDecisionFeatures,
} from './ensemble-post-entry-protection-shadow.service';

function components(outcome?: Record<string, unknown>) {
  return {
    candidateScore: 0.72,
    extensionAtr: 0.8,
    volatilityScore: 0.3,
    emaSeparation: 0.2,
    mtfStrength: 0.6,
    rsi14: 61,
    stopLoss: 1.099,
    ...(outcome ? { outcome } : {}),
  };
}

describe('EnsemblePostEntryProtectionShadowService', () => {
  it('parses immutable ensemble decision features and optional terminal outcome time', () => {
    expect(parseV85ShadowDecisionFeatures(components())).toMatchObject({
      stopLoss: 1.099,
      candidateScore: 0.72,
      extensionAtr: 0.8,
      volatilityScore: 0.3,
      emaSeparation: 0.2,
      mtfStrength: 0.6,
      rsi14: 61,
      outcomeResolvedAt: null,
    });

    const parsed = parseV85ShadowDecisionFeatures(
      components({ resolvedAt: '2026-10-05T10:12:00Z' }),
    );
    expect(parsed?.outcomeResolvedAt?.toISOString()).toBe('2026-10-05T10:12:00.000Z');
    expect(parseV85ShadowDecisionFeatures({ candidateScore: 0.72 })).toBeNull();
  });

  it('scores a due virtual checkpoint from broker-native data and persists authority NONE', async () => {
    const now = new Date('2026-10-05T10:06:00Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          shadow_decision_id: '00000000-0000-0000-0000-000000000001',
          user_id: '00000000-0000-0000-0000-000000000002',
          instrument: 'EURUSD',
          direction: 'BUY',
          evaluated_at: '2026-10-05T10:00:00Z',
          entry_price: '1.10000000',
          confidence: '0.68000000',
          components: components(),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 1 }]);

    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'vpsForexScanner.userId') {
          return '00000000-0000-0000-0000-000000000002';
        }
        if (key === 'multimodelBrokerExpert.enabled') return true;
        if (key === 'multimodelBrokerExpert.sourceConnectionId') {
          return '00000000-0000-0000-0000-000000000099';
        }
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const aiEngineClient = {
      scorePlanBV85PostEntryBrokerCheckpoint: jest.fn().mockResolvedValue({
        state: 'READY',
        reason: null,
        status: null,
        checkpoint_at: '2026-10-05T10:05:00Z',
        market_data_sources: { M1: 'metaapi', M5: 'metaapi' },
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
    } as unknown as AiEngineClient;

    const service = new EnsemblePostEntryProtectionShadowService(
      config,
      dataSource,
      aiEngineClient,
    );
    (service as unknown as { artifactReady: boolean }).artifactReady = true;

    await service.runOnce(now);

    expect(aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerConnectionId: '00000000-0000-0000-0000-000000000099',
        instrument: 'EURUSD',
        direction: 'BUY',
        checkpointMinutes: 5,
        confidence: 0.68,
        candidateScore: 0.72,
      }),
    );
    expect(String(query.mock.calls[2]?.[0])).toContain(
      'INSERT INTO trading.ensemble_post_entry_shadow_observations',
    );
    expect(String(query.mock.calls[2]?.[0])).toContain("execution_authority = 'NONE'");
    expect(service.getStatus()).toMatchObject({
      cohort: 'ENSEMBLE_SHADOW_DECISIONS',
      modifiesExecution: false,
      lastScored: 1,
      lastCandidates: 1,
      observedCheckpoints: 1,
      lastError: null,
    });
  });

  it('does not create checkpoints after the virtual position resolved', async () => {
    const now = new Date('2026-10-05T10:31:00Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          shadow_decision_id: '00000000-0000-0000-0000-000000000001',
          user_id: '00000000-0000-0000-0000-000000000002',
          instrument: 'EURUSD',
          direction: 'BUY',
          evaluated_at: '2026-10-05T10:00:00Z',
          entry_price: '1.10000000',
          confidence: '0.68000000',
          components: components({ resolvedAt: '2026-10-05T10:12:00Z' }),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 2 }]);

    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'vpsForexScanner.userId') {
          return '00000000-0000-0000-0000-000000000002';
        }
        if (key === 'multimodelBrokerExpert.enabled') return true;
        if (key === 'multimodelBrokerExpert.sourceConnectionId') return 'broker-native-1';
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const aiEngineClient = {
      scorePlanBV85PostEntryBrokerCheckpoint: jest.fn().mockResolvedValue({
        state: 'NOT_YET_ELIGIBLE',
        reason: 'CURRENT_PROFIT_BELOW_TRAINED_FLOOR',
        status: null,
        score: null,
      }),
    } as unknown as AiEngineClient;

    const service = new EnsemblePostEntryProtectionShadowService(
      config,
      dataSource,
      aiEngineClient,
    );
    (service as unknown as { artifactReady: boolean }).artifactReady = true;
    await service.runOnce(now);

    expect(aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint).toHaveBeenCalledTimes(2);
    expect(
      (aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint as jest.Mock).mock.calls.map(
        (call) => call[0].checkpointMinutes,
      ),
    ).toEqual([5, 10]);
  });

  it('scopes lifecycle observation counts to the requesting user', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ count: 7 }]);
    const service = new EnsemblePostEntryProtectionShadowService(
      {
        get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
      } as unknown as ConfigService,
      { query } as unknown as DataSource,
      {} as AiEngineClient,
    );
    (service as unknown as { artifactReady: boolean }).artifactReady = true;

    const status = await service.getUserStatus('00000000-0000-0000-0000-000000000002');

    expect(status.observedCheckpoints).toBe(7);
    expect(String(query.mock.calls[0]?.[0])).toContain('WHERE user_id = $1');
    expect(query.mock.calls[0]?.[1]).toEqual([
      '00000000-0000-0000-0000-000000000002',
      'plan-b-v85-profitable-state-giveback-classifier-v1',
    ]);
  });

  it('persists retryable waiting evidence when broker-native source is not configured', async () => {
    const now = new Date('2026-10-05T10:06:00Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          shadow_decision_id: '00000000-0000-0000-0000-000000000001',
          user_id: '00000000-0000-0000-0000-000000000002',
          instrument: 'EURUSD',
          direction: 'BUY',
          evaluated_at: '2026-10-05T10:00:00Z',
          entry_price: '1.10000000',
          confidence: '0.68000000',
          components: components(),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);

    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'vpsForexScanner.userId') {
          return '00000000-0000-0000-0000-000000000002';
        }
        if (key === 'multimodelBrokerExpert.enabled') return false;
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const aiEngineClient = {
      scorePlanBV85PostEntryBrokerCheckpoint: jest.fn(),
    } as unknown as AiEngineClient;

    const service = new EnsemblePostEntryProtectionShadowService(
      config,
      dataSource,
      aiEngineClient,
    );
    (service as unknown as { artifactReady: boolean }).artifactReady = true;
    await service.runOnce(now);

    expect(aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint).not.toHaveBeenCalled();
    const persistArgs = query.mock.calls[2]?.[1] as unknown[];
    expect(persistArgs).toContain('WAITING_FOR_BROKER_DATA');
    expect(persistArgs).toContain('BROKER_SOURCE_NOT_CONFIGURED');
  });
});
