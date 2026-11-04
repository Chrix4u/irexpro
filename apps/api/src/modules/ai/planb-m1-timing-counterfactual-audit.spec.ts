import { evaluateM1CausalOutcome15m } from './m1-causal-outcome';

interface TimingResearchGroup {
  episodes: number;
  observed: number;
  unobservable: number;
  ambiguous: number;
  positive: number;
  negative: number;
  netR: number;
  timingOnly: number;
}
interface TimingResearchReport {
  artifact: string;
  executionAuthority: string;
  modifiesExecution: boolean;
  promotionEligible: boolean;
  qualificationEvidence: boolean;
  evaluatedDecisionRows: number;
  observedQuoteCandles: number;
  timingRejectedEpisodes: number;
  byM1Reason: Record<string, TimingResearchGroup>;
}

// Deliberately exercise the deployable, manually invoked read-only CommonJS entrypoint.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require('../../../scripts/audit-planb-m1-timing-counterfactual.cjs') as {
  ARTIFACT: string;
  SCOPE_SQL: string;
  DECISIONS_SQL: string;
  CANDLES_SQL: string;
  selectEpisodeLeaders: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  runPlanBTimingCounterfactualAudit: (
    input: Record<string, unknown>,
  ) => Promise<TimingResearchReport>;
};

const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const snapshotAt = '2026-11-04T09:00:00.000Z';
const since = '2026-11-04T08:00:00.000Z';

function decision(
  evaluatedAt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    barTime: new Date(new Date(evaluatedAt).getTime() - 60_000).toISOString(),
    evaluatedAt,
    instrument: 'USDJPY',
    direction: 'BUY',
    route: 'ABSTAIN',
    m1Route: 'ABSTAIN',
    m1Reason: 'NO_VALID_ROUTE',
    planBAdmitted: 'true',
    planBRegime: 'TREND_HEALTHY',
    planBRoute: 'TREND_CONTINUATION',
    planBRegimeAllowed: 'true',
    authorityBlockers: ['MULTIMODEL_CONTINUATION_TIMING_NOT_READY'],
    stopDistance: '0.1',
    targetDistance: '0.2',
    estimatedCostR: '0.05',
    ...overrides,
  };
}

function quoteBars(startMinute: string, count: number) {
  const base = new Date(startMinute).getTime();
  return Array.from({ length: count }, (_, i) => ({
    instrument: 'USDJPY',
    timestamp: new Date(base + i * 60_000).toISOString(),
    open: 150,
    high: 150.02,
    low: 149.99,
    close: 150.01,
  }));
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(
    private readonly decisions: Array<Record<string, unknown>>,
    private readonly candles: Array<Record<string, unknown>>,
    private readonly demoScope = true,
  ) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) {
      return { rows: this.demoScope ? [{ snapshotAt, brokerId: 'ctrader' }] : [] };
    }
    if (sql.includes('FROM trading.m1_tactical_decisions')) {
      return { rows: this.decisions };
    }
    if (sql.includes('FROM market_data.provider_quote_candles')) {
      return { rows: this.candles };
    }
    return { rows: [] };
  }
}

function audit(client: FakeClient) {
  return runner.runPlanBTimingCounterfactualAudit({
    client,
    userId,
    connectionId,
    since,
    evaluateOutcome: evaluateM1CausalOutcome15m,
  });
}

describe('Plan-B-admitted / M1-timing-rejected missed-entry research audit', () => {
  it('deduplicates the same strategy-side episode regardless of M1 abstention reason', () => {
    const rows = [
      decision('2026-11-04T08:31:00.000Z'),
      decision('2026-11-04T08:33:00.000Z', { m1Reason: 'HIGHER_TIMEFRAME_CONFLICT' }),
      decision('2026-11-04T08:40:00.000Z'),
      decision('2026-11-04T08:42:00.000Z', {
        authorityBlockers: ['DRIFT_OUT_OF_DISTRIBUTION'],
      }),
      decision('2026-11-04T08:43:00.000Z', { planBAdmitted: 'false' }),
      decision('2026-11-04T08:44:00.000Z', { direction: 'SELL' }),
    ];
    const leaders = runner.selectEpisodeLeaders(rows);
    expect(leaders).toHaveLength(3);
    expect(leaders.map((x) => [x.evaluatedAt, x.direction])).toEqual([
      ['2026-11-04T08:31:00.000Z', 'BUY'],
      ['2026-11-04T08:40:00.000Z', 'BUY'],
      ['2026-11-04T08:44:00.000Z', 'SELL'],
    ]);
  });

  it('uses complete post-decision M1 quote candles, deducts recorded cost and never implies a trade', async () => {
    const client = new FakeClient(
      [decision('2026-11-04T08:31:00.000Z'), decision('2026-11-04T08:32:00.000Z')],
      quoteBars('2026-11-04T08:32:00.000Z', 15),
    );
    const result = await audit(client);
    expect(result).toMatchObject({
      artifact: runner.ARTIFACT,
      executionAuthority: 'NONE',
      modifiesExecution: false,
      promotionEligible: false,
      qualificationEvidence: false,
      timingRejectedEpisodes: 1,
      byM1Reason: {
        NO_VALID_ROUTE: {
          episodes: 1,
          observed: 1,
          positive: 1,
          netR: 0.05,
          timingOnly: 1,
        },
      },
    });
    expect(result.evaluatedDecisionRows).toBe(2);
    expect(result.observedQuoteCandles).toBe(15);
    expect(client.calls[0]?.sql).toContain('READ ONLY');
    expect(client.calls.map((x) => x.sql).join(' ')).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i,
    );
    expect(runner.CANDLES_SQL).toContain('positive_quote_sample_count > 0');
    expect(runner.CANDLES_SQL).toContain("source = 'ctrader-broker-native'");
    expect(runner.DECISIONS_SQL).toContain('policy_version = $3');
  });

  it('marks missing contiguous broker candles as unobservable, not losses or wins', async () => {
    const client = new FakeClient(
      [decision('2026-11-04T08:31:00.000Z')],
      quoteBars('2026-11-04T08:32:00.000Z', 14),
    );
    const result = await audit(client);
    expect(result.byM1Reason.NO_VALID_ROUTE).toMatchObject({
      episodes: 1,
      observed: 0,
      unobservable: 1,
      positive: 0,
      negative: 0,
      netR: 0,
    });
  });

  it('rejects a missing or non-DEMO broker scope without retrieving private decisions', async () => {
    const client = new FakeClient([], [], false);
    await expect(audit(client)).rejects.toThrow('CTRADER_DEMO_SCOPE_UNAVAILABLE');
    expect(client.calls.some((x) => x.sql.includes('FROM trading.m1_tactical_decisions'))).toBe(
      false,
    );
    expect(client.calls.at(-1)?.sql).toBe('ROLLBACK');
    await expect(
      runner.runPlanBTimingCounterfactualAudit({
        client,
        userId: 'invalid',
        connectionId,
        since,
        evaluateOutcome: evaluateM1CausalOutcome15m,
      }),
    ).rejects.toThrow('INVALID_AUDIT_SCOPE');
  });
});
