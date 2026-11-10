import { DataSource } from 'typeorm';
import { M1ReversalTimingFusionShadowService } from './m1-reversal-timing-fusion-shadow.service';
import { M1_REVERSAL_TIMING_FUSION_SHADOW_ARTIFACT } from './m1-reversal-timing-fusion-shadow';

const t = new Date('2026-11-10T16:16:00Z');
const start = Date.parse('2026-11-10T16:17:00Z');
const candidate = {
  instrument: 'AUDUSD',
  direction: 'SELL',
  decisionTime: t,
  directionQuality: 0.69,
  alignedMomentum1Atr: 0.5,
  alignedMomentum3Atr: 0.6,
  alignedMomentum5Atr: 0.5,
  alignedEmaSlopeAtr: 0.2,
  alignedM5BodyPressure3: 0.3,
  alignedM5Momentum3Atr: 0.4,
  alignedM5Momentum1Atr: 0.3,
  alignedM5LatestBodyPressure: 0.4,
  failedBreakoutAgainstDirection: false,
  stopDistance: 0.0005,
  targetDistance: 0.0008,
};
const row = {
  id: 'decision-01',
  user_id: 'owner-01',
  broker_connection_id: 'pepperstone-01',
  account_currency: 'USD',
  instrument: 'AUDUSD',
  direction: 'SELL',
  route: 'ABSTAIN',
  evaluated_at: t,
  candidate,
  blockers: ['MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'],
  planb_route: 'CONFIRMED_REVERSAL',
  planb_paper_admitted: true,
  planb_paper_governance_passed: true,
  event_risk: 'CLEAR',
  drift_state: 'NORMAL',
};
const minute = (i: number) => {
  const time = start + i * 60000;
  const low = i === 2 ? 0.6905 : 0.6914;
  return {
    bucket_time: new Date(time),
    open: 0.6915,
    high: 0.6916,
    low,
    close: 0.69145,
    source: 'ctrader-broker-native',
    sample_count: 5,
    positive_quote_sample_count: 5,
    first_sample_at: new Date(time + 250),
    last_quote_sample_at: new Date(time + 55_000),
  };
};

describe('M1ReversalTimingFusionShadowService', () => {
  it('stores a 60m broker-native quote replay and as-of cost sensitivity, never opens trades', async () => {
    const query = jest.fn().mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes('FROM trading.m1_tactical_decisions d')) return [row];
      if (
        sql.includes('FROM market_data.provider_quote_candles') &&
        sql.includes('SELECT bucket_time')
      ) {
        expect(args[0]).toBe('pepperstone-01');
        expect(args[1]).toBe('AUDUSD');
        return Array.from({ length: 60 }, (_, i) => minute(i));
      }
      if (sql.includes('FROM trading.trades t')) return [{ sample_count: 5, p90_fee_r: 0.12 }];
      if (sql.includes('FROM market_data.provider_quote_candles') && sql.includes('p90_spread')) {
        expect(sql).toContain('last_quote_sample_at < $3::timestamptz');
        expect(args[2]).toBe(t.toISOString());
        return [{ sample_count: 11, p90_spread: 0.00003 }];
      }
      if (sql.includes('UPDATE trading.m1_tactical_decisions')) return [];
      throw new Error('Unexpected DB query');
    });
    const svc = new M1ReversalTimingFusionShadowService({ query } as unknown as DataSource);
    await svc.runOnce(new Date('2026-11-10T19:00:00Z'));
    expect(query).toHaveBeenCalledTimes(5);
    const select = String(query.mock.calls[0][0]);
    expect(select).toContain("bc.account_type='DEMO'");
    expect(select).toContain("d.execution_authority='NONE'");
    expect(select).toContain('d.blockers @>');
    expect(select).toContain('CONFIRMED_REVERSAL');
    const update = String(query.mock.calls[4][0]);
    expect(update).toContain("execution_authority='NONE'");
    expect(update).toContain("governance->'reversalTimingFusionShadow60m' IS NULL");
    const audit = JSON.parse(query.mock.calls[4][1][3]);
    expect(audit).toMatchObject({
      artifact: M1_REVERSAL_TIMING_FUSION_SHADOW_ARTIFACT,
      state: 'ALTERNATIVE_CONFIRMATION_CANDIDATE',
      wouldConfirmWithoutFailedBreakout: true,
      originalRoute: 'ABSTAIN',
      originalGovernanceClean: true,
      quoteReplay: { state: 'TARGET_QUOTE_TOUCH', indicativeGrossR: 1.6 },
      costStress: { state: 'ESTIMABLE_STRESS_ONLY', executionAuthority: 'NONE' },
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
    expect(
      query.mock.calls.some(([sql]) =>
        /UPDATE\s+trading\.trades|INSERT\s+INTO\s+trading\.trades|executeTrade\(/i.test(
          String(sql),
        ),
      ),
    ).toBe(false);
    svc.onModuleDestroy();
  });

  it('stores failed model conditions without reading future candles or guessing returns', async () => {
    const rows = [{ ...row, candidate: { ...candidate, alignedMomentum1Atr: 0.1 } }];
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM trading.m1_tactical_decisions d')) return rows;
      if (sql.includes('UPDATE trading.m1_tactical_decisions')) return [];
      throw new Error('Failed qualifications must not read broker quotes or fees');
    });
    const svc = new M1ReversalTimingFusionShadowService({ query } as unknown as DataSource);
    await svc.runOnce(new Date('2026-11-10T19:00:00Z'));
    expect(query).toHaveBeenCalledTimes(2);
    const audit = JSON.parse(query.mock.calls[1][1][3]);
    expect(audit.state).toBe('M1_MULTIBAR_IMPULSE_MISSING');
    expect(audit.quoteReplay).toBeNull();
    expect(audit.costStress).toBeNull();
    expect(audit.executionAuthority).toBe('NONE');
    svc.onModuleDestroy();
  });

  it('avoids overlapping research batches while preserving existing broker execution paths', async () => {
    let release: (() => void) | undefined;
    let first = true;
    const query = jest.fn().mockImplementation(() => {
      if (!first) return Promise.resolve([]);
      first = false;
      return new Promise((resolve) => {
        release = () => resolve([]);
      });
    });
    const svc = new M1ReversalTimingFusionShadowService({ query } as unknown as DataSource);
    const running = svc.runOnce();
    await svc.runOnce();
    expect(query).toHaveBeenCalledTimes(1);
    release?.();
    await running;
    svc.onModuleDestroy();
  });
});
