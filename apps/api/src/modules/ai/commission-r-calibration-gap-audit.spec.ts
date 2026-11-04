export {};

// Read-only, owner-scoped, cTrader DEMO research; no execution imports.
type MeanSummary = {
  trades: number;
  validEntryAllocationRisk: number;
  completeRecordedCosts: number;
  pairedRealizedNetR: number;
  skippedIncompleteCostOrRisk: number;
  allocationRiskFallbacks: number;
  meanRealizedGrossR: number | null;
  meanRealizedNetR: number | null;
  meanRecordedCommissionR: number | null;
  recordedCommissionR_P50: number | null;
  recordedCommissionR_P90: number | null;
  meanModeledSpreadOnlyCostR: number | null;
  grossPositiveNetNonPositive: number;
  m1ExpectedNetR: {
    pairedCount: number;
    meanForecastR: number | null;
    meanRealizedMinusForecastR: number | null;
  };
  planBGovernanceNetExpectedR: {
    pairedCount: number;
    meanForecastR: number | null;
    meanRealizedMinusForecastR: number | null;
  };
};
type Report = {
  artifact: string;
  researchOnly: boolean;
  modifiesExecution: boolean;
  executionAuthority: string;
  byCurrency: Record<string, MeanSummary>;
  byStrategyRoute: Record<string, MeanSummary>;
  byEngineAndRoute: Record<string, MeanSummary>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const audit = require('../../../scripts/audit-commission-r-calibration-gap.cjs') as {
  SCOPE_SQL: string;
  TRADE_SQL: string;
  evaluateRows: (rows: Array<Record<string, unknown>>, from: string, asOf: string) => Report;
  runAudit: (input: Record<string, unknown>) => Promise<Report>;
};
const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const from = '2026-11-04T08:00:00Z';
const asOf = '2026-11-04T11:00:00Z';

function row(overrides: Record<string, unknown> = {}) {
  return {
    instrument: 'GBPUSD',
    direction: 'BUY',
    currency: 'EUR',
    route: 'TREND_CONTINUATION',
    engine: 'external-irexpro-multimodel-ensemble',
    openedAt: '2026-11-04T09:00:00Z',
    closedAt: '2026-11-04T09:05:00Z',
    allocationCreatedAt: '2026-11-04T08:59:00Z',
    allocationRiskAtStop: '10.00',
    fallbackAllocationRisk: '12.00',
    grossPnl: '3.00',
    commission: '-1.00',
    swap: '0',
    modeledSpreadCostR: '0.05',
    modeledCostSource: 'BROKER_OBSERVED_P90',
    m1ExpectedNetR: '0.22',
    planBExpectedNetR: '0.28',
    ...overrides,
  };
}

class FakeClient {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(
    private readonly rows: Array<Record<string, unknown>>,
    private readonly demo = true,
  ) {}
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes('FROM broker.broker_connections')) {
      return { rows: this.demo ? [{ asOf }] : [] };
    }
    if (sql.includes('FROM trading.trades')) return { rows: this.rows };
    return { rows: [] };
  }
}

describe('commission vs ex-ante spread-only cost research audit', () => {
  it('normalizes full closed-trade return by the recorded pre-entry final risk at stop', () => {
    const r = audit.evaluateRows([row()], from, asOf);
    expect(r).toMatchObject({
      researchOnly: true,
      modifiesExecution: false,
      executionAuthority: 'NONE',
    });
    const x = r.byCurrency['EUR | ALL'];
    expect(x).toMatchObject({
      trades: 1,
      pairedRealizedNetR: 1,
      meanRealizedGrossR: 0.3,
      meanRealizedNetR: 0.2,
      meanRecordedCommissionR: 0.1,
      meanModeledSpreadOnlyCostR: 0.05,
      m1ExpectedNetR: {
        pairedCount: 1,
        meanForecastR: 0.22,
        meanRealizedMinusForecastR: -0.02,
      },
      planBGovernanceNetExpectedR: {
        pairedCount: 1,
        meanForecastR: 0.28,
        meanRealizedMinusForecastR: -0.08,
      },
    });
  });

  it('counts a gross-winning position that became a loser after commission', () => {
    const x = audit.evaluateRows([row({ grossPnl: '1', commission: '-2' })], from, asOf).byCurrency[
      'EUR | ALL'
    ];
    expect(x.grossPositiveNetNonPositive).toBe(1);
    expect(x.meanRealizedGrossR).toBe(0.1);
    expect(x.meanRealizedNetR).toBe(-0.1);
    expect(x.meanRecordedCommissionR).toBe(0.2);
  });

  it('never substitutes the fallback for an explicitly invalid final-risk field', () => {
    const x = audit.evaluateRows([row({ allocationRiskAtStop: '-2' })], from, asOf).byCurrency[
      'EUR | ALL'
    ];
    expect(x).toMatchObject({
      validEntryAllocationRisk: 0,
      pairedRealizedNetR: 0,
      skippedIncompleteCostOrRisk: 1,
      meanRealizedNetR: null,
    });
  });

  it('uses the fallback only when no final risk was recorded and marks its source', () => {
    const x = audit.evaluateRows([row({ allocationRiskAtStop: null })], from, asOf).byCurrency[
      'EUR | ALL'
    ];
    expect(x.pairedRealizedNetR).toBe(1);
    expect(x.allocationRiskFallbacks).toBe(1);
    expect(x.meanRecordedCommissionR).toBe(0.083);
  });

  it('excludes trades missing valid close, open or risk-allocation timestamps', () => {
    const x = audit.evaluateRows(
      [row({ openedAt: null }), row({ closedAt: null }), row({ allocationCreatedAt: null }), row()],
      from,
      asOf,
    ).byCurrency['EUR | ALL'];
    expect(x.trades).toBe(4);
    expect(x.pairedRealizedNetR).toBe(1);
    expect(x.skippedIncompleteCostOrRisk).toBe(3);
  });

  it('excludes allocations created after the trade opened', () => {
    const x = audit.evaluateRows([row({ allocationCreatedAt: '2026-11-04T09:00:01Z' })], from, asOf)
      .byCurrency['EUR | ALL'];
    expect(x.pairedRealizedNetR).toBe(0);
    expect(x.skippedIncompleteCostOrRisk).toBe(1);
    expect(audit.TRADE_SQL).toContain('ca0.created_at<=t.opened_at');
  });

  it('does not silently set missing commission or swap to zero', () => {
    const report = audit.evaluateRows(
      [row({ commission: null }), row({ swap: null }), row()],
      from,
      asOf,
    );
    const x = report.byCurrency['EUR | ALL'];
    expect(x.trades).toBe(3);
    expect(x.completeRecordedCosts).toBe(1);
    expect(x.pairedRealizedNetR).toBe(1);
    expect(x.skippedIncompleteCostOrRisk).toBe(2);
  });

  it('does not aggregate across account currencies or strategy routes', () => {
    const report = audit.evaluateRows(
      [
        row({ currency: 'EUR', route: 'TREND_CONTINUATION' }),
        row({ currency: 'USD', route: 'EARLY_TRANSITION' }),
      ],
      from,
      asOf,
    );
    expect(Object.keys(report.byCurrency)).toEqual(['EUR | ALL', 'USD | ALL']);
    expect(Object.keys(report.byStrategyRoute)).toEqual([
      'EUR | TREND_CONTINUATION',
      'USD | EARLY_TRANSITION',
    ]);
  });

  it('calculates robust median and P90 commission burden from observed rows', () => {
    const x = audit.evaluateRows(
      [row({ commission: '-1.00' }), row({ commission: '-2.00' }), row({ commission: '-3.00' })],
      from,
      asOf,
    ).byCurrency['EUR | ALL'];
    expect(x.meanRecordedCommissionR).toBe(0.2);
    expect(x.recordedCommissionR_P50).toBe(0.2);
    expect(x.recordedCommissionR_P90).toBe(0.28);
  });

  it('runs an owner-verified cTrader DEMO scope in a read-only transaction', async () => {
    const c = new FakeClient([row()]);
    const report = await audit.runAudit({ client: c, userId, connectionId, since: from });
    expect(report.byCurrency['EUR | ALL'].pairedRealizedNetR).toBe(1);
    expect(c.calls[0].sql).toContain('REPEATABLE READ READ ONLY');
    expect(c.calls.at(-1)?.sql).toBe('COMMIT');
    expect(audit.SCOPE_SQL).toContain("account_type='DEMO'");
    expect(c.calls.map((x) => x.sql).join(' ')).not.toMatch(
      /\b(?:UPDATE|DELETE|INSERT|ALTER|DROP)\b/i,
    );
  });

  it('rejects missing DEMO scope, invalid IDs, oversized windows and truncated trade rows', async () => {
    const blocked = new FakeClient([], false);
    await expect(
      audit.runAudit({ client: blocked, userId, connectionId, since: from }),
    ).rejects.toThrow('OWNER_CTRADER_DEMO_NOT_FOUND');
    expect(blocked.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(blocked.calls.some((x) => x.sql.includes('FROM trading.trades'))).toBe(false);
    await expect(
      audit.runAudit({ client: blocked, userId: 'bad', connectionId, since: from }),
    ).rejects.toThrow('INVALID_DEMO_SCOPE');
    const truncated = new FakeClient([row(), row()]);
    await expect(
      audit.runAudit({
        client: truncated,
        userId,
        connectionId,
        since: from,
        maxRows: 1,
      }),
    ).rejects.toThrow('TRUNCATED_TRADE_HISTORY');
    expect(truncated.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(() => audit.evaluateRows([row()], '2026-10-01T00:00:00Z', asOf)).toThrow(
      'INVALID_WINDOW',
    );
  });
});
