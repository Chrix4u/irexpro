import type { DataSource } from 'typeorm';
import { M1ProbationMissedOpportunityShadowService } from './m1-probation-missed-opportunity-shadow.service';
import { M1_PROBATION_MISSED_OPPORTUNITY_ARTIFACT } from './m1-probation-missed-opportunity-shadow';

const t = new Date('2026-11-10T15:34:00.000Z');
const first = Date.parse('2026-11-10T15:35:00.000Z');
const candidate = {
  id: 'decision1',
  user_id: 'user1',
  broker_connection_id: 'broker1',
  instrument: 'EURUSD',
  direction: 'SELL',
  route: 'M1_TREND_CONTINUATION',
  evaluated_at: t,
  candidate: {
    entry: 1.1235,
    stopDistance: 0.0005,
    targetDistance: 0.0008,
    confidence: 0.68,
    directionQuality: 0.72,
  },
  governance: { demoPrimaryOnlyProbation: { chosenAuthorityPath: 'BOOTSTRAP_CONTINUATION' } },
};
const bar = (i: number) => {
  const at = first + i * 60_000;
  const low = i === 12 ? 1.1224 : 1.1234;
  return {
    bucket_time: new Date(at),
    open: 1.1235,
    high: 1.1237,
    low,
    close: i === 12 ? 1.1225 : 1.12355,
    source: 'ctrader-broker-native',
    sample_count: 3,
    positive_quote_sample_count: 3,
    first_sample_at: new Date(at + 300),
    last_quote_sample_at: new Date(at + 53_000),
  };
};

describe('M1ProbationMissedOpportunityShadowService', () => {
  it('audits only isolated DEMO broker decisions whose sole blocker is probation', async () => {
    const query = jest.fn().mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes('WITH eligible AS (')) return [candidate];
      if (sql.includes('FROM market_data.provider_quote_candles')) {
        expect(args[0]).toBe('broker1');
        expect(args[1]).toBe('EURUSD');
        expect(args[2]).toBe('2026-11-10T15:35:00.000Z');
        return Array.from({ length: 60 }, (_, i) => bar(i));
      }
      if (sql.includes('UPDATE trading.m1_tactical_decisions')) return [];
      throw new Error('Unexpected SQL');
    });
    const svc = new M1ProbationMissedOpportunityShadowService({ query } as unknown as DataSource);
    await svc.runOnce(new Date('2026-11-10T18:00:00Z'));
    expect(query).toHaveBeenCalledTimes(3);
    const select = String(query.mock.calls[0][0]);
    expect(select).toContain("bc.account_type='DEMO'");
    expect(select).toContain('AND d.blockers=');
    expect(select).toContain('ROW_NUMBER() OVER');
    expect(select).toContain('episode_rank=1');
    expect(select).toContain("d.execution_authority='NONE'");
    expect(query.mock.calls[0][1][2]).toBe(1800);
    const update = String(query.mock.calls[2][0]);
    const args = query.mock.calls[2][1];
    expect(update).toContain("execution_authority='NONE'");
    expect(update).toContain('AND blockers=');
    expect(update).toContain("governance->'probationMissedOpportunity60m' IS NULL");
    expect(args.slice(0, 3)).toEqual(['decision1', 'user1', 'broker1']);
    const response = JSON.parse(args[3] as string);
    expect(response).toMatchObject({
      artifact: M1_PROBATION_MISSED_OPPORTUNITY_ARTIFACT,
      state: 'TARGET_QUOTE_TOUCH',
      indicativeGrossR: 1.6,
      observedMinutes: 13,
      feesModeled: false,
      modifiesExecution: false,
      executionAuthority: 'NONE',
      replayEpisodePolicy: 'EARLIEST_SOLE_PROBATION_CANDIDATE_PER_PAIR_SIDE_PER_FIXED_30M_UTC',
      originalAuthorityPath: 'BOOTSTRAP_CONTINUATION',
    });
    expect(
      query.mock.calls.some(([sql]) =>
        /\bINSERT INTO trading\.trades|UPDATE trading\.trades|closeTrade\(/i.test(String(sql)),
      ),
    ).toBe(false);
    svc.onModuleDestroy();
  });
  it('does not issue overlapping research DB passes when an earlier pass is pending', async () => {
    let release: (() => void) | undefined;
    let firstQuery = true;
    const query = jest.fn().mockImplementation(async () => {
      if (firstQuery) {
        firstQuery = false;
        return await new Promise((resolve) => {
          release = () => resolve([]);
        });
      }
      return [];
    });
    const svc = new M1ProbationMissedOpportunityShadowService({ query } as unknown as DataSource);
    const running = svc.runOnce();
    await svc.runOnce();
    expect(query).toHaveBeenCalledTimes(1);
    release?.();
    await running;
    svc.onModuleDestroy();
  });
});
