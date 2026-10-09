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

    const candidateSql = String(query.mock.calls[0]?.[0]);
    expect(candidateSql).toContain('admitted = true');
    expect(candidateSql).toContain("components ->> 'paperAdmitted' = 'true'");
    expect(candidateSql).toContain("components -> 'governance' ->> 'netExpectedR'");
    expect(candidateSql).toContain("components -> 'governance' ->> 'executionSpreadEvidenceValid'");
    expect(candidateSql).toContain('NOT EXISTS');
    expect(candidateSql).toContain("interval '15 minutes'");
    expect(candidateSql).toContain('prior.evaluated_at = decision.evaluated_at');
    expect(candidateSql).toContain('prior.id < decision.id');

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
    const refreshSql = String(query.mock.calls[3]?.[0]);
    expect(refreshSql).toContain('decision.model_version = $3');
    expect(query.mock.calls[0]?.[1]).toEqual([
      'irexpro-multimodel-ensemble-v1',
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1',
      '00000000-0000-0000-0000-000000000002',
      now.toISOString(),
    ]);
    expect(query.mock.calls[3]?.[1]).toEqual([
      'plan-b-v85-profitable-state-giveback-classifier-v1',
      'irexpro-multimodel-ensemble-v1',
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1',
    ]);
    expect(service.getStatus()).toMatchObject({
      cohort: 'ENSEMBLE_SHADOW_DECISIONS',
      sourcePolicyVersion:
        'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1',
      modifiesExecution: false,
      lastScored: 1,
      lastCandidates: 1,
      observedCheckpoints: 1,
      lastError: null,
    });
  });

  it('isolates strong rejected-edge outcome tracking from admitted post-entry evidence', async () => {
    const now = new Date('2026-10-05T10:06:00Z');
    const rejectedArtifact = 'plan-b-rejected-edge-outcome-shadow-v1';
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          shadow_decision_id: '00000000-0000-0000-0000-000000000010',
          user_id: '00000000-0000-0000-0000-000000000002',
          instrument: 'GBPUSD',
          direction: 'SELL',
          evaluated_at: '2026-10-05T10:00:00Z',
          entry_price: '1.33000000',
          confidence: '0.67000000',
          components: components(),
          observation_artifact: rejectedArtifact,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);

    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'vpsForexScanner.userId') return '00000000-0000-0000-0000-000000000002';
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
          probability: 0.52,
          threshold: 0.6,
          current_r: 0.31,
          eligible_profit_state: false,
          action: 'OBSERVE',
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

    expect(query.mock.calls[1]?.[1]?.[1]).toBe(rejectedArtifact);
    expect(query.mock.calls[2]?.[1]?.[3]).toBe(rejectedArtifact);
    expect(String(query.mock.calls[2]?.[0])).toContain("'NONE',false");
    expect(query.mock.calls[3]?.[1]?.[0]).toBe(
      'plan-b-v85-profitable-state-giveback-classifier-v1',
    );
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
    const query = jest.fn().mockResolvedValueOnce([
      {
        observed_checkpoints: 7,
        distinct_decisions_observed: 4,
        eligible_profit_decisions: 2,
        protect_recommendations: 1,
        observe_recommendations: 3,
      },
    ]);
    const service = new EnsemblePostEntryProtectionShadowService(
      {
        get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
      } as unknown as ConfigService,
      { query } as unknown as DataSource,
      {} as AiEngineClient,
    );
    (service as unknown as { artifactReady: boolean }).artifactReady = true;

    const status = await service.getUserStatus('00000000-0000-0000-0000-000000000002');

    expect(status).toMatchObject({
      observedCheckpoints: 7,
      distinctDecisionsObserved: 4,
      eligibleProfitDecisions: 2,
      protectRecommendations: 1,
      observeRecommendations: 3,
      evidenceMinimums: { distinctDecisions: 100, eligibleProfitDecisions: 30 },
      sampleMinimumSatisfied: false,
      evidenceState: 'COLLECTING_PROSPECTIVE_EVIDENCE',
      paperPromotionEligible: false,
      promotionBlocker: 'MINIMUM_PROSPECTIVE_SAMPLE_NOT_MET',
    });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'count(DISTINCT observation.ensemble_shadow_decision_id)',
    );
    const statusSql = String(query.mock.calls[0]?.[0]);
    expect(statusSql).toContain('observation.user_id = $1');
    expect(statusSql).toContain('decision.engine_code = $3');
    expect(statusSql).toContain('decision.model_version = $4');
    expect(query.mock.calls[0]?.[1]).toEqual([
      '00000000-0000-0000-0000-000000000002',
      'plan-b-v85-profitable-state-giveback-classifier-v1',
      'irexpro-multimodel-ensemble-v1',
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1',
    ]);
  });

  it('meets the sample floor without granting PAPER execution authority', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        observed_checkpoints: 240,
        distinct_decisions_observed: 100,
        eligible_profit_decisions: 30,
        protect_recommendations: 18,
        observe_recommendations: 52,
      },
    ]);
    const service = new EnsemblePostEntryProtectionShadowService(
      {
        get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
      } as unknown as ConfigService,
      { query } as unknown as DataSource,
      {} as AiEngineClient,
    );
    (service as unknown as { artifactReady: boolean }).artifactReady = true;

    const status = await service.getUserStatus('00000000-0000-0000-0000-000000000002');

    expect(status).toMatchObject({
      sampleMinimumSatisfied: true,
      evidenceState: 'SAMPLE_FLOOR_MET_REVIEW_REQUIRED',
      paperPromotionEligible: false,
      promotionBlocker: 'OUTCOME_QUALITY_REVIEW_REQUIRED',
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
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
  it('summarizes 30m rejected-edge evidence for PAPER canary qualification', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        global_samples: '15',
        global_positive: '12',
        global_avg_r: '1.088',
        global_min_r: '-0.381',
        global_max_r: '5.786',
        pair_samples: '2',
        pair_positive: '1',
        pair_avg_r: '0.254',
        pair_min_r: '-0.381',
        pair_max_r: '0.888',
      },
    ]);
    const service = new EnsemblePostEntryProtectionShadowService(
      {} as unknown as ConfigService,
      { query } as unknown as DataSource,
      {} as unknown as AiEngineClient,
    );

    await expect(
      service.getRejectedEdgeCanaryEvidence(
        '00000000-0000-0000-0000-000000000002',
        'GBPUSD',
        'SELL',
      ),
    ).resolves.toEqual({
      global30m: { samples: 15, positive: 12, avgR: 1.088, minR: -0.381, maxR: 5.786 },
      pairSide30m: { samples: 2, positive: 1, avgR: 0.254, minR: -0.381, maxR: 0.888 },
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('checkpoint_minutes = 30');
    expect(query.mock.calls[0]?.[1]).toEqual([
      'irexpro-multimodel-ensemble-v1',
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1',
      '00000000-0000-0000-0000-000000000002',
      'GBPUSD',
      'SELL',
      'plan-b-rejected-edge-outcome-shadow-v1',
    ]);
  });
});
