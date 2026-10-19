import {
  classifyHighConvictionOverlay,
  summarizeHighConvictionOverlayCohort,
} from './high-conviction-overlay';
import type { PlanBV4BrokerScoreResponse } from '../ai-engine-client/ai-engine-client.service';

function ready(overrides: Partial<PlanBV4BrokerScoreResponse> = {}): PlanBV4BrokerScoreResponse {
  return {
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
    status: {} as PlanBV4BrokerScoreResponse['status'],
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
    ...overrides,
  };
}

describe('classifyHighConvictionOverlay', () => {
  const closeTime = new Date('2026-10-05T10:00:00Z');

  it('confirms an admitted broker-native score in the same direction', () => {
    const result = classifyHighConvictionOverlay(ready(), 'BUY', closeTime);
    expect(result.state).toBe('CONFIRM');
    expect(result.allBrokerNative).toBe(true);
    expect(result.modifiesExecution).toBe(false);
  });

  it('flags an admitted opposite-direction score as conflict', () => {
    const response = ready();
    response.score!.direction = 'SELL';
    const result = classifyHighConvictionOverlay(response, 'BUY', closeTime);
    expect(result.state).toBe('CONFLICT');
  });

  it('keeps non-admitted high-conviction scores as abstentions', () => {
    const response = ready();
    response.score!.admitted = false;
    const result = classifyHighConvictionOverlay(response, 'BUY', closeTime);
    expect(result.state).toBe('ABSTAIN');
  });

  it('rejects stale broker scores without changing execution', () => {
    const result = classifyHighConvictionOverlay(
      ready({ decision_time: '2026-10-05T09:40:00Z' }),
      'BUY',
      closeTime,
    );
    expect(result.state).toBe('STALE');
    expect(result.reason).toBe('BROKER_MTF_TIME_MISMATCH');
    expect(result.modifiesExecution).toBe(false);
  });

  it('requires all five timeframes to be broker-native', () => {
    const response = ready();
    response.market_data_sources = {
      ...response.market_data_sources!,
      H4: 'paper-broker',
    };
    const result = classifyHighConvictionOverlay(response, 'BUY', closeTime);
    expect(result.state).toBe('STALE');
    expect(result.reason).toBe('BROKER_NATIVE_MTF_REQUIRED');
  });

  it('fails observationally when the scorer is unavailable', () => {
    const result = classifyHighConvictionOverlay(
      ready({
        state: 'WAITING_FOR_BROKER_DATA',
        reason: 'BROKER_NATIVE_REQUIRED',
        score: null,
      }),
      'BUY',
      closeTime,
    );
    expect(result.state).toBe('UNAVAILABLE');
    expect(result.reason).toBe('BROKER_NATIVE_REQUIRED');
  });
});

describe('summarizeHighConvictionOverlayCohort', () => {
  it('summarizes resolved net-R evidence without treating ambiguous bars as returns', () => {
    const cohort = summarizeHighConvictionOverlayCohort('CONFIRM', 4, [
      {
        version: 'm5-first-hit-72bar-side-aware-v4',
        status: 'WIN',
        resolvedAt: '2026-10-05T10:10:00Z',
        barsObserved: 2,
        exitPrice: 1.1,
        grossR: 1.5,
        netR: 1.4,
        reason: 'TAKE_PROFIT_HIT',
        postEntryTelemetry: null,
      },
      {
        version: 'm5-first-hit-72bar-side-aware-v4',
        status: 'LOSS',
        resolvedAt: '2026-10-06T10:10:00Z',
        barsObserved: 3,
        exitPrice: 1.0,
        grossR: -1,
        netR: -1.1,
        reason: 'STOP_LOSS_HIT',
        postEntryTelemetry: null,
      },
      {
        version: 'm5-first-hit-72bar-side-aware-v4',
        status: 'AMBIGUOUS',
        resolvedAt: '2026-10-07T10:10:00Z',
        barsObserved: 1,
        exitPrice: null,
        grossR: null,
        netR: null,
        reason: 'SAME_BAR_SL_TP',
        postEntryTelemetry: null,
      },
    ]);

    expect(cohort.observations).toBe(4);
    expect(cohort.resolved).toBe(3);
    expect(cohort.evaluableResolved).toBe(2);
    expect(cohort.wins).toBe(1);
    expect(cohort.losses).toBe(1);
    expect(cohort.ambiguous).toBe(1);
    expect(cohort.netR).toBeCloseTo(0.3, 8);
    expect(cohort.profitFactor).toBeCloseTo(1.4 / 1.1, 8);
  });

  it('keeps cohorts with no resolved outcomes statistically empty', () => {
    const cohort = summarizeHighConvictionOverlayCohort('CONFLICT', 7, []);
    expect(cohort.observations).toBe(7);
    expect(cohort.resolved).toBe(0);
    expect(cohort.profitFactor).toBeNull();
    expect(cohort.sharpe).toBeNull();
    expect(cohort.maxDrawdown).toBeNull();
  });
});
