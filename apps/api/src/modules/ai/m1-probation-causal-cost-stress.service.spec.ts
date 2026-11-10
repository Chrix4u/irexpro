import { DataSource } from 'typeorm';
import { M1ProbationCausalCostStressService } from './m1-probation-causal-cost-stress.service';
import { PROBATION_CAUSAL_COST_STRESS_ARTIFACT } from './m1-probation-causal-cost-stress';

const asOf = new Date('2026-11-10T16:16:00.000Z');
const record = {
  id: 'decision-01',
  user_id: 'owner-01',
  broker_connection_id: 'pepperstone-01',
  account_currency: 'USD',
  instrument: 'AUDUSD',
  evaluated_at: asOf,
  candidate: { stopDistance: 0.0005 },
  observation: { state: 'TARGET_QUOTE_TOUCH', indicativeGrossR: 1.6 },
};

describe('M1ProbationCausalCostStressService', () => {
  it('enriches research only, from prior same-broker account and currency-specific verified costs', async () => {
    const query = jest.fn().mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes('FROM trading.m1_tactical_decisions d')) return [record];
      if (sql.includes('FROM (') && sql.includes('trading.trades')) {
        expect(sql).toContain('t.closed_at < $5::timestamptz');
        expect(sql).toContain('t.account_currency=$4');
        expect(sql).toContain("s.execution_mode='FULL_AUTO'");
        expect(sql).toContain("b.account_type='DEMO'");
        expect(sql).toContain("alloc.sizing_inputs->>'finalRiskAtStop'");
        expect(args).toEqual(['owner-01', 'pepperstone-01', 'AUDUSD', 'USD', asOf.toISOString()]);
        return [{ sample_count: 5, p90_fee_r: '0.12' }];
      }
      if (sql.includes('FROM market_data.provider_quote_candles')) {
        expect(sql).toContain("source='ctrader-broker-native'");
        expect(sql).toContain('last_quote_sample_at < $3::timestamptz');
        expect(args).toEqual(['pepperstone-01', 'AUDUSD', asOf.toISOString()]);
        return [{ sample_count: 10, p90_spread: '0.00003' }];
      }
      if (sql.includes('UPDATE trading.m1_tactical_decisions')) return [];
      throw new Error('Unexpected database access');
    });
    const svc = new M1ProbationCausalCostStressService({ query } as unknown as DataSource);
    await svc.runOnce(new Date('2026-11-10T19:00:00Z'));
    expect(query).toHaveBeenCalledTimes(4);
    const selection = String(query.mock.calls[0][0]);
    expect(selection).toContain("bc.account_type='DEMO'");
    expect(selection).toContain("d.execution_authority='NONE'");
    expect(selection).toContain('d.blockers=');
    expect(selection).toContain('probationMissedOpportunity60m,costStress');
    const update = String(query.mock.calls[3][0]);
    expect(update).toContain("execution_authority='NONE'");
    expect(update).toContain("governance #> '{probationMissedOpportunity60m,costStress}' IS NULL");
    const payload = JSON.parse(query.mock.calls[3][1][3]);
    expect(payload).toMatchObject({
      artifact: PROBATION_CAUSAL_COST_STRESS_ARTIFACT,
      state: 'ESTIMABLE_STRESS_ONLY',
      stressedCostAdjustedR: 1.305,
      brokerFeeP90R: 0.12,
      brokerFeePriorFills: 5,
      brokerSpreadPriorBars: 10,
      priorFeeEvidenceCutoff: asOf.toISOString(),
      priorSpreadEvidenceCutoff: asOf.toISOString(),
      accountCurrency: 'USD',
      brokerConnectionScoped: true,
      executionAuthority: 'NONE',
      modifiesExecution: false,
      noExecutableFillProof: true,
    });
    expect(
      query.mock.calls.some(([sql]) =>
        /UPDATE\s+trading\.trades|INSERT\s+INTO\s+trading\.trade_intents|closeTrade\(/i.test(
          String(sql),
        ),
      ),
    ).toBe(false);
    svc.onModuleDestroy();
  });

  it('records missing same-pair fee samples without calculating a fake net result', async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM trading.m1_tactical_decisions d')) return [record];
      if (sql.includes('FROM (') && sql.includes('trading.trades'))
        return [{ sample_count: 1, p90_fee_r: 0.12 }];
      if (sql.includes('FROM market_data.provider_quote_candles'))
        return [{ sample_count: 10, p90_spread: 0.00003 }];
      if (sql.includes('UPDATE trading.m1_tactical_decisions')) return [];
      throw new Error('Unexpected database query');
    });
    const svc = new M1ProbationCausalCostStressService({ query } as unknown as DataSource);
    await svc.runOnce();
    const payload = JSON.parse(query.mock.calls[3][1][3]);
    expect(payload.state).toBe('INSUFFICIENT_CAUSAL_FEES');
    expect(payload.stressedCostAdjustedR).toBeNull();
    svc.onModuleDestroy();
  });

  it('will not start a second pass while the previous pass remains in flight', async () => {
    let first = true;
    let release: (() => void) | undefined;
    const query = jest.fn().mockImplementation(() => {
      if (!first) return Promise.resolve([]);
      first = false;
      return new Promise((resolve) => {
        release = () => resolve([]);
      });
    });
    const svc = new M1ProbationCausalCostStressService({ query } as unknown as DataSource);
    const running = svc.runOnce();
    await svc.runOnce();
    expect(query).toHaveBeenCalledTimes(1);
    release?.();
    await running;
    svc.onModuleDestroy();
  });
});
