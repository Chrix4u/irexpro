import {
  demoDrawdownGuardDue,
  shouldCloseDemoDrawdown,
  PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES,
  PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R,
  PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES,
} from './post-entry-demo-drawdown-guard.service';

describe('post-entry DEMO drawdown guard policy', () => {
  it('acts only inside the causal 5-to-7 minute window', () => {
    const openedAt = new Date('2026-10-30T10:00:00.000Z');
    expect(PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES).toBe(5);
    expect(PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES).toBe(7);
    expect(demoDrawdownGuardDue(openedAt, new Date('2026-10-30T10:04:59.999Z'))).toBe(false);
    expect(demoDrawdownGuardDue(openedAt, new Date('2026-10-30T10:05:00.000Z'))).toBe(true);
    expect(demoDrawdownGuardDue(openedAt, new Date('2026-10-30T10:06:59.999Z'))).toBe(true);
    expect(demoDrawdownGuardDue(openedAt, new Date('2026-10-30T10:07:00.001Z'))).toBe(false);
  });

  it('closes only at or beyond the evidence-selected -0.40R drawdown', () => {
    expect(PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R).toBe(-0.4);
    expect(shouldCloseDemoDrawdown(-0.399999)).toBe(false);
    expect(shouldCloseDemoDrawdown(-0.4)).toBe(true);
    expect(shouldCloseDemoDrawdown(-0.55)).toBe(true);
    expect(shouldCloseDemoDrawdown(Number.NaN)).toBe(false);
  });
});

import { DataSource } from 'typeorm';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import { ExecutionService } from '../execution/execution.service';
import { TradeCloseReason, TradeStatus } from '../execution/entities/trade.entity';
import { PostEntryDemoDrawdownGuardService } from './post-entry-demo-drawdown-guard.service';

const candidate = {
  trade_id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  trade_intent_id: '33333333-3333-4333-8333-333333333333',
  execution_broker_connection_id: '44444444-4444-4444-8444-444444444444',
  instrument: 'AUDUSD',
  direction: 'BUY' as const,
  entry_price: '0.6500',
  stop_loss: '0.6450',
  opened_at: '2026-10-30T10:00:00.000Z',
  metadata: {
    confidenceScore: 0.72,
    feature_candidate_score: 0.64,
    feature_extension_atr: 0.54,
    feature_volatility_score: 0.15,
    feature_ema_separation: 0.30,
    feature_mtf_strength: 0.10,
    feature_rsi14: 55,
  },
};

function readyScore(currentR: number) {
  return {
    state: 'READY',
    reason: null,
    status: null,
    checkpoint_at: '2026-10-30T10:05:00.000Z',
    market_data_sources: { M1: 'broker' },
    score: {
      artifact: 'plan-b-v85-profitable-state-giveback-classifier-v1',
      mode: 'PROSPECTIVE_SHADOW_ONLY',
      probability: 0.55,
      threshold: 0.6,
      current_r: currentR,
      eligible_profit_state: false,
      action: 'OBSERVE',
      execution_authority: 'NONE',
      modifies_execution: false,
      paper_promotion_eligible: false,
    },
  } as any;
}

function harness(score: unknown, closeResult: unknown = { status: TradeStatus.CLOSED }) {
  const query = jest.fn().mockResolvedValueOnce([candidate]).mockResolvedValue([]);
  const aiEngine = {
    scorePlanBV85PostEntryBrokerCheckpoint: jest.fn().mockResolvedValue(score),
    getPlanBV85PostEntryStatus: jest.fn().mockResolvedValue({ loaded: true, execution_authority: 'NONE' }),
  } as unknown as AiEngineClient;
  const execution = {
    closeTrade: jest.fn().mockResolvedValue(closeResult),
  } as unknown as ExecutionService;
  const service = new PostEntryDemoDrawdownGuardService(
    { query } as unknown as DataSource,
    aiEngine,
    execution,
  );
  return { service, query, aiEngine: aiEngine as any, execution: execution as any };
}

describe('PostEntryDemoDrawdownGuardService', () => {
  const now = new Date('2026-10-30T10:05:30.000Z');

  it('loads only OPEN cTrader DEMO multimodel trades inside the 5-to-7 minute window', async () => {
    const { service, query } = harness(readyScore(-0.39));
    await service.runOnce(now);

    const sql = String(query.mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(sql).toContain("t.status = 'OPEN'");
    expect(sql).toContain("bc.account_type = 'DEMO'");
    expect(sql).toContain("bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')");
    expect(sql).toContain("t.opened_at <= $1::timestamptz - interval '5 minutes'");
    expect(sql).toContain("t.opened_at >= $1::timestamptz - interval '7 minutes'");
    expect(sql).toContain("ti.metadata->>'external_provider_code' = 'irexpro-multimodel-ensemble-v1'");
    expect(sql).toContain('NOT EXISTS');
    expect(sql).not.toContain("bc.account_type = 'LIVE'");
  });

  it('records NO_ACTION above -0.40R and never closes', async () => {
    const { service, query, execution } = harness(readyScore(-0.39));
    await service.runOnce(now);

    expect(execution.closeTrade).not.toHaveBeenCalled();
    const persist = query.mock.calls.find((call: unknown[]) => String(call[0]).includes('INSERT INTO trading.post_entry_shadow_observations'));
    expect(persist).toBeDefined();
    expect(persist?.[1]).toEqual(expect.arrayContaining(['NO_ACTION', 'DRAWDOWN_NOT_SEVERE', -0.39, 'OBSERVE', false]));
  });

  it('closes exactly once at -0.40R using the existing AI close path', async () => {
    const { service, query, execution } = harness(readyScore(-0.4));
    await service.runOnce(now);

    expect(execution.closeTrade).toHaveBeenCalledTimes(1);
    expect(execution.closeTrade).toHaveBeenCalledWith(
      candidate.trade_id,
      candidate.user_id,
      TradeCloseReason.AI_CLOSE_SIGNAL,
    );
    const persist = query.mock.calls.find((call: unknown[]) => String(call[0]).includes('INSERT INTO trading.post_entry_shadow_observations'));
    expect(persist?.[1]).toEqual(expect.arrayContaining(['CLOSED', 'DRAWDOWN_GUARD_CLOSED', -0.4, 'CLOSE_DEMO', true]));
    expect(String(persist?.[0])).toContain("'DEMO_ONLY'");
  });

  it('never closes when the 5-minute checkpoint is not explicitly broker-sourced shadow evidence', async () => {
    const nonBroker = readyScore(-0.55);
    nonBroker.market_data_sources = { M1: 'cache' };
    const { service, execution } = harness(nonBroker);

    await service.runOnce(now);
    expect(execution.closeTrade).not.toHaveBeenCalled();
  });

  it('never closes when the broker checkpoint is not READY', async () => {
    const waiting = {
      state: 'WAITING_FOR_BROKER_DATA',
      reason: 'M1_BROKER_CANDLE_UNAVAILABLE',
      status: null,
      checkpoint_at: '2026-10-30T10:05:00.000Z',
      score: null,
    } as any;
    const { service, execution } = harness(waiting);
    await service.runOnce(now);
    expect(execution.closeTrade).not.toHaveBeenCalled();
  });

  it('records a failed close without pretending the trade was closed', async () => {
    const { service, query, execution } = harness(readyScore(-0.55));
    execution.closeTrade.mockRejectedValueOnce(new Error('provider refused'));

    await expect(service.runOnce(now)).resolves.toBeUndefined();
    const persist = query.mock.calls.find((call: unknown[]) => String(call[0]).includes('INSERT INTO trading.post_entry_shadow_observations'));
    expect(persist?.[1]).toEqual(expect.arrayContaining(['CLOSE_FAILED', 'EXECUTION_CLOSE_FAILED', -0.55, 'CLOSE_DEMO', true]));
  });
});
