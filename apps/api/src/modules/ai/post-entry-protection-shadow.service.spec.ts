import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import {
  PostEntryProtectionShadowService,
  dueV85Checkpoints,
  parseV85EntryFeatures,
} from './post-entry-protection-shadow.service';

describe('PostEntryProtectionShadowService', () => {
  it('parses the immutable entry snapshot required by v8.5', () => {
    expect(
      parseV85EntryFeatures({
        confidenceScore: 0.68,
        feature_candidate_score: 0.72,
        feature_extension_atr: 0.8,
        feature_volatility_score: 0.3,
        feature_ema_separation: 0.2,
        feature_mtf_strength: 0.6,
        feature_rsi14: 61,
      }),
    ).toEqual({
      confidence: 0.68,
      candidateScore: 0.72,
      extensionAtr: 0.8,
      volatilityScore: 0.3,
      emaSeparation: 0.2,
      mtfStrength: 0.6,
      rsi14: 61,
    });

    expect(parseV85EntryFeatures({ confidenceScore: 0.68 })).toBeNull();
  });

  it('returns only checkpoints that occurred while the trade was open and are not terminal', () => {
    const openedAt = new Date('2026-10-05T10:00:00Z');
    const observationEnd = new Date('2026-10-05T10:31:00Z');
    expect(dueV85Checkpoints(openedAt, observationEnd, new Set([10]))).toEqual([5, 15, 30]);

    const closedAt = new Date('2026-10-05T10:12:00Z');
    expect(dueV85Checkpoints(openedAt, closedAt, new Set())).toEqual([5, 10]);
  });

  it('scores a due checkpoint from the broker-native source and persists shadow-only evidence', async () => {
    const now = new Date('2026-10-05T10:06:00Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          trade_id: '00000000-0000-0000-0000-000000000001',
          user_id: '00000000-0000-0000-0000-000000000002',
          trade_intent_id: '00000000-0000-0000-0000-000000000003',
          execution_broker_connection_id: '00000000-0000-0000-0000-000000000004',
          instrument: 'EURUSD',
          direction: 'BUY',
          entry_price: '1.10000000',
          stop_loss: '1.09900000',
          opened_at: '2026-10-05T10:00:00Z',
          closed_at: null,
          metadata: {
            confidenceScore: 0.68,
            feature_candidate_score: 0.72,
            feature_extension_atr: 0.8,
            feature_volatility_score: 0.3,
            feature_ema_separation: 0.2,
            feature_mtf_strength: 0.6,
            feature_rsi14: 61,
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
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

    const service = new PostEntryProtectionShadowService(config, dataSource, aiEngineClient);
    (service as unknown as { artifactReady: boolean }).artifactReady = true;

    await service.runOnce(now);

    expect(aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint).toHaveBeenCalledTimes(1);
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
    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[2]?.[0])).toContain(
      'INSERT INTO trading.post_entry_shadow_observations',
    );
    expect(String(query.mock.calls[2]?.[0])).toContain("execution_authority = 'NONE'");
    expect(service.getStatus().modifiesExecution).toBe(false);
    expect(service.getStatus().lastScored).toBe(1);
  });

  it('persists a retryable WAITING state when no broker-native source is configured', async () => {
    const now = new Date('2026-10-05T10:06:00Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          trade_id: '00000000-0000-0000-0000-000000000001',
          user_id: '00000000-0000-0000-0000-000000000002',
          trade_intent_id: '00000000-0000-0000-0000-000000000003',
          execution_broker_connection_id: '00000000-0000-0000-0000-000000000004',
          instrument: 'EURUSD',
          direction: 'BUY',
          entry_price: '1.10000000',
          stop_loss: '1.09900000',
          opened_at: '2026-10-05T10:00:00Z',
          closed_at: null,
          metadata: {
            confidenceScore: 0.68,
            feature_candidate_score: 0.72,
            feature_extension_atr: 0.8,
            feature_volatility_score: 0.3,
            feature_ema_separation: 0.2,
            feature_mtf_strength: 0.6,
            feature_rsi14: 61,
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'multimodelBrokerExpert.enabled') return false;
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const aiEngineClient = {
      scorePlanBV85PostEntryBrokerCheckpoint: jest.fn(),
    } as unknown as AiEngineClient;

    const service = new PostEntryProtectionShadowService(config, dataSource, aiEngineClient);
    (service as unknown as { artifactReady: boolean }).artifactReady = true;
    await service.runOnce(now);

    expect(aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint).not.toHaveBeenCalled();
    const persistArgs = query.mock.calls[2]?.[1] as unknown[];
    expect(persistArgs).toContain('WAITING_FOR_BROKER_DATA');
    expect(persistArgs).toContain('BROKER_SOURCE_NOT_CONFIGURED');
    expect(service.getStatus().lastScored).toBe(0);
  });

  it('does not retry a checkpoint that was already observed below the trained profit-state floor', async () => {
    const now = new Date('2026-10-05T10:06:00Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          trade_id: '00000000-0000-0000-0000-000000000001',
          user_id: '00000000-0000-0000-0000-000000000002',
          trade_intent_id: '00000000-0000-0000-0000-000000000003',
          execution_broker_connection_id: '00000000-0000-0000-0000-000000000004',
          instrument: 'EURUSD',
          direction: 'BUY',
          entry_price: '1.10000000',
          stop_loss: '1.09900000',
          opened_at: '2026-10-05T10:00:00Z',
          closed_at: null,
          metadata: {
            confidenceScore: 0.68,
            feature_candidate_score: 0.72,
            feature_extension_atr: 0.8,
            feature_volatility_score: 0.3,
            feature_ema_separation: 0.2,
            feature_mtf_strength: 0.6,
            feature_rsi14: 61,
          },
        },
      ])
      .mockResolvedValueOnce([{ checkpoint_minutes: 5, state: 'NOT_YET_ELIGIBLE' }]);
    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'multimodelBrokerExpert.enabled') return true;
        if (key === 'multimodelBrokerExpert.sourceConnectionId') return 'broker-native-1';
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const aiEngineClient = {
      scorePlanBV85PostEntryBrokerCheckpoint: jest.fn(),
    } as unknown as AiEngineClient;

    const service = new PostEntryProtectionShadowService(config, dataSource, aiEngineClient);
    (service as unknown as { artifactReady: boolean }).artifactReady = true;
    await service.runOnce(now);

    expect(aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
