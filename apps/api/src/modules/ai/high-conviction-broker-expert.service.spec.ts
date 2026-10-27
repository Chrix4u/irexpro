import { HighConvictionBrokerExpertService } from './high-conviction-broker-expert.service';
import type { PlanBV4BrokerScoreResponse } from '../ai-engine-client/ai-engine-client.service';

function readyResponse(overrides: Partial<PlanBV4BrokerScoreResponse> = {}): PlanBV4BrokerScoreResponse {
  return {
    state: 'READY',
    reason: null,
    status: {
      artifact: 'plan-b-v4-oof-three-expert-consensus-challenger',
      mode: 'PROSPECTIVE_SHADOW_ONLY',
      configured: true,
      loaded: true,
      load_error: null,
      manifest_path: '/models/manifest.json',
      feature_count: 128,
      frozen_consensus: { opp_floor: 0.55, margin_floor: 0, votes_required: 3 },
      qualification_cutoff: null,
      sealed_future_holdout_touched: false,
      historical_validation: {
        n: 1000,
        profit_factor: 1.2,
        sharpe: 1.1,
        balanced_accuracy: 0.55,
        max_drawdown: 0.08,
        positive_fold_fraction: 0.7,
        positive_instrument_fraction: 0.83,
        median_gap_minutes: 5,
      },
      execution_authority: 'NONE',
      paper_promotion_eligible: false,
    },
    decision_time: '2026-10-27T20:30:00.000Z',
    market_data_sources: { M1: 'broker', M5: 'broker', M15: 'broker', H1: 'broker', H4: 'broker' },
    score: {
      artifact: 'plan-b-v4-oof-three-expert-consensus-challenger',
      mode: 'PROSPECTIVE_SHADOW_ONLY',
      modifies_execution: false,
      instrument: 'EURUSD',
      direction: 'BUY',
      admitted: true,
      ensemble_confidence: 0.76,
      mean_opportunity_probability: 0.63,
      mean_direction_confidence: 0.74,
      long_votes: 3,
      short_votes: 0,
      vote_margin: 1,
      votes_required: 3,
      opportunity_floor: 0.55,
      regime: 'calm',
      paper_promotion_eligible: false,
    },
    ...overrides,
  };
}

class FakeAiEngineClient {
  calls: Array<{ userId: string; brokerConnectionId: string; instrument: string }> = [];
  response: PlanBV4BrokerScoreResponse = readyResponse();
  error: Error | null = null;

  async scorePlanBV4ChallengerBroker(input: {
    userId: string;
    brokerConnectionId: string;
    instrument: string;
  }): Promise<PlanBV4BrokerScoreResponse> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return this.response;
  }
}

describe('HighConvictionBrokerExpertService', () => {
  it('scores the exact cTrader broker connection without a MetaTrader-only gate', async () => {
    const client = new FakeAiEngineClient();
    const service = new HighConvictionBrokerExpertService(client as never);

    const result = await service.evaluate({
      userId: 'user-1',
      brokerConnectionId: 'ctrader-demo-connection',
      instrument: 'EURUSD',
      candidateDirection: 'BUY',
      candidateCloseTime: new Date('2026-10-27T20:30:00.000Z'),
    });

    expect(client.calls).toEqual([
      { userId: 'user-1', brokerConnectionId: 'ctrader-demo-connection', instrument: 'EURUSD' },
    ]);
    expect(result).toMatchObject({
      state: 'CONFIRM',
      allBrokerNative: true,
      direction: 'BUY',
      admitted: true,
      longVotes: 3,
      shortVotes: 0,
    });
  });

  it('fails closed when the trained scorer reports mixed/non-broker provenance', async () => {
    const client = new FakeAiEngineClient();
    client.response = readyResponse({
      market_data_sources: { M1: 'paper-broker', M5: 'broker', M15: 'broker', H1: 'broker', H4: 'broker' },
    });
    const service = new HighConvictionBrokerExpertService(client as never);

    const result = await service.evaluate({
      userId: 'user-1',
      brokerConnectionId: 'ctrader-demo-connection',
      instrument: 'EURUSD',
      candidateDirection: 'BUY',
      candidateCloseTime: new Date('2026-10-27T20:30:00.000Z'),
    });

    expect(result.state).toBe('STALE');
    expect(result.reason).toBe('BROKER_NATIVE_MTF_REQUIRED');
  });

  it('fails closed when the trained scorer request fails', async () => {
    const client = new FakeAiEngineClient();
    client.error = new Error('AI engine unavailable');
    const service = new HighConvictionBrokerExpertService(client as never);

    const result = await service.evaluate({
      userId: 'user-1',
      brokerConnectionId: 'ctrader-demo-connection',
      instrument: 'EURUSD',
      candidateDirection: 'BUY',
      candidateCloseTime: new Date('2026-10-27T20:30:00.000Z'),
    });

    expect(result).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'TRAINED_EXPERT_REQUEST_FAILED',
      allBrokerNative: false,
      modifiesExecution: false,
    });
  });
});
