export {};

// Manually invoked, user-scoped, read-only research. No broker execution imports.
type GroupSummary = {
  entries: number;
  withCompleteCosts: number;
  missingCostsOrOutcome: number;
  afterCostWinners: number;
  afterCostLosers: number;
  grossWinnersNonPositiveNet: number;
  netAfterRecordedCosts: number;
};
type GroupMap = Record<string, GroupSummary>;
type WindowSummary = {
  byCurrency: GroupMap;
  byPairSide: GroupMap;
  byPriorExit: GroupMap;
  byPriorExitAndRoute: GroupMap;
  byPriorExitAndSleeve: GroupMap;
  byEngineTransition: GroupMap;
};
type AuditResult = {
  cumulativeReentryWindows: Record<string, WindowSummary>;
  mutuallyExclusiveEntryGapBins: Record<string, GroupMap>;
  allClosedByCurrency: GroupMap;
  mixedEngineNegativeRouteClusters: Array<Record<string, unknown>>;
  lossClusteringBeforeEntry: { crossEngineFourCloseNetNegative: GroupMap };
  researchOnly: boolean;
  modifiesExecution: boolean;
  executionAuthority: string;
  invalidOrOpenRowsExcluded: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const audit = require('../../../scripts/audit-cross-engine-reentry-churn.cjs') as {
  TRADES_SQL: string;
  SCOPE_SQL: string;
  analyzeReentries: (
    rows: Array<Record<string, unknown>>,
    from: string,
    snapshotAt: string,
  ) => AuditResult;
  runAudit: (input: Record<string, unknown>) => Promise<AuditResult>;
};
const uid = '11111111-1111-4111-8111-111111111111';
const connection = '22222222-2222-4222-8222-222222222222';
const from = '2026-11-04T08:00:00Z';
const asOf = '2026-11-04T11:00:00Z';

function trade(
  tradeId: string,
  opened: string,
  closed: string,
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tradeId,
    instrument: 'GBPUSD',
    direction: 'BUY',
    currency: 'EUR',
    strategyRoute: 'TREND_CONTINUATION',
    strategyCode: 'external-irexpro-m1-tactical',
    openedAt: opened,
    closedAt: closed,
    status: 'CLOSED',
    closeReason: 'AI_CLOSE_SIGNAL',
    realisedPnl: '-2.00',
    commission: '-1.00',
    swap: '0',
    initialRiskPnl: '10.00',
    ...changes,
  };
}
const ensemble = 'external-irexpro-multimodel-ensemble';

class FakeClient {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(
    private readonly trades: Array<Record<string, unknown>>,
    private readonly demo = true,
  ) {}
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes('FROM broker.broker_connections')) {
      return { rows: this.demo ? [{ snapshotAt: asOf }] : [] };
    }
    if (sql.includes('FROM trading.trades')) return { rows: this.trades };
    return { rows: [] };
  }
}
function sequence() {
  return [
    trade('a', '2026-11-04T09:00:00Z', '2026-11-04T09:02:00Z'),
    trade('b', '2026-11-04T09:05:00Z', '2026-11-04T09:07:00Z', {
      strategyCode: ensemble,
      realisedPnl: '1.50',
      commission: '-1.60',
      closeReason: 'PROFIT_PROTECTION',
    }),
    trade('c', '2026-11-04T09:11:00Z', '2026-11-04T09:12:00Z', {
      realisedPnl: '3.00',
      closeReason: 'PROFIT_PROTECTION',
    }),
    trade('d', '2026-11-04T09:20:00Z', '2026-11-04T09:21:00Z', {
      strategyCode: ensemble,
    }),
  ];
}

describe('cross-engine commission-aware re-entry churn audit (research-only)', () => {
  it('joins recent same-pair same-side closes across M1 and ensemble engines', () => {
    const r = audit.analyzeReentries(sequence(), from, asOf);
    const h15 = r.cumulativeReentryWindows['15m'];
    expect(h15.byCurrency['EUR | ALL']).toMatchObject({
      entries: 3,
      withCompleteCosts: 3,
      afterCostWinners: 1,
      afterCostLosers: 2,
      grossWinnersNonPositiveNet: 1,
      netAfterRecordedCosts: -1.1,
    });
    expect(h15.byEngineTransition['EUR | CROSS_ENGINE'].entries).toBe(3);
    expect(h15.byPriorExit['EUR | PROFIT_PROTECTION'].entries).toBe(2);
    expect(h15.byPairSide['EUR | GBPUSD/BUY'].entries).toBe(3);
    expect(h15.byPriorExitAndRoute['EUR | PROFIT_PROTECTION/TREND_CONTINUATION'].entries).toBe(2);
    expect(
      h15.byPriorExitAndSleeve['EUR | PROFIT_PROTECTION/GBPUSD/BUY/TREND_CONTINUATION'].entries,
    ).toBe(2);
  });

  it('reports mutually exclusive bins and cumulative 5/10/15/30 windows', () => {
    const r = audit.analyzeReentries(sequence(), from, asOf);
    expect(r.cumulativeReentryWindows['5m'].byCurrency['EUR | ALL'].entries).toBe(2);
    expect(r.cumulativeReentryWindows['10m'].byCurrency['EUR | ALL'].entries).toBe(3);
    expect(r.mutuallyExclusiveEntryGapBins['0-5m']['EUR | ALL'].entries).toBe(2);
    expect(r.mutuallyExclusiveEntryGapBins['5-10m']['EUR | ALL'].entries).toBe(1);
    expect(r.mutuallyExclusiveEntryGapBins['10-15m']).toEqual({});
    expect(r.researchOnly).toBe(true);
    expect(r.modifiesExecution).toBe(false);
    expect(r.executionAuthority).toBe('NONE');
  });

  it('uses closure chronology for overlapping positions instead of entry order', () => {
    const rows = [
      trade('a', '2026-11-04T09:00:00Z', '2026-11-04T09:20:00Z'),
      trade('b', '2026-11-04T09:05:00Z', '2026-11-04T09:06:00Z', { strategyCode: ensemble }),
      trade('c', '2026-11-04T09:08:00Z', '2026-11-04T09:09:00Z'),
    ];
    const r = audit.analyzeReentries(rows, from, asOf);
    expect(r.cumulativeReentryWindows['5m'].byCurrency['EUR | ALL']).toMatchObject({
      entries: 1,
      netAfterRecordedCosts: -3,
    });
  });

  it('finds a recent close even when the prior position opened before the history buffer', () => {
    const history = [
      trade('old', '2026-10-31T09:00:00Z', '2026-11-04T07:59:00Z'),
      trade('new', '2026-11-04T08:02:00Z', '2026-11-04T08:05:00Z', {
        strategyCode: ensemble,
      }),
    ];
    const report = audit.analyzeReentries(history, from, asOf);
    expect(report.cumulativeReentryWindows['5m'].byCurrency['EUR | ALL'].entries).toBe(1);
    expect(audit.TRADES_SQL).toContain('t.closed_at BETWEEN');
  });

  it('does not treat missing commission as zero-profit evidence', () => {
    const rows = [sequence()[0], { ...sequence()[1], commission: null }];
    const r = audit.analyzeReentries(rows, from, asOf);
    expect(r.cumulativeReentryWindows['5m'].byCurrency['EUR | ALL']).toMatchObject({
      entries: 1,
      withCompleteCosts: 0,
      missingCostsOrOutcome: 1,
      netAfterRecordedCosts: 0,
    });
  });

  it('never sums EUR and USD and never merges opposite-side closes', () => {
    const rows = [
      sequence()[0],
      { ...sequence()[1], currency: 'USD' },
      trade('other-direction', '2026-11-04T09:08:00Z', '2026-11-04T09:09:00Z', {
        direction: 'SELL',
      }),
      trade('other-buy', '2026-11-04T09:10:00Z', '2026-11-04T09:11:00Z', {
        strategyCode: ensemble,
      }),
    ];
    const r = audit.analyzeReentries(rows, from, asOf);
    expect(Object.keys(r.allClosedByCurrency)).toEqual(['EUR | ALL', 'USD | ALL']);
    expect(r.cumulativeReentryWindows['5m'].byCurrency).toMatchObject({
      'EUR | ALL': { entries: 1 },
      'USD | ALL': { entries: 1 },
    });
  });

  it('reports recent negative route clusters across both engines without issuing a brake', () => {
    const r = audit.analyzeReentries(sequence(), from, asOf);
    expect(r.mixedEngineNegativeRouteClusters).toEqual([
      expect.objectContaining({
        instrument: 'GBPUSD',
        direction: 'BUY',
        route: 'TREND_CONTINUATION',
        engineCount: 2,
        entries: 4,
        grossWinnersNonPositiveNet: 1,
        netAfterRecordedCosts: -4.1,
      }),
    ]);
    expect(r.lossClusteringBeforeEntry.crossEngineFourCloseNetNegative).toEqual({});
  });

  it('deduplicates one trade identity and excludes OPEN / missing-closure outcomes', () => {
    const rows = [
      ...sequence(),
      sequence()[1],
      {
        ...sequence()[2],
        tradeId: 'open',
        status: 'OPEN',
        closedAt: null,
      },
    ];
    const r = audit.analyzeReentries(rows, from, asOf);
    expect(r.cumulativeReentryWindows['15m'].byCurrency['EUR | ALL'].entries).toBe(3);
    expect(r.invalidOrOpenRowsExcluded).toBe(1);
  });

  it('forbids uncapped or oversized windows', () => {
    expect(() => audit.analyzeReentries(sequence(), from, '2026-10-10T00:00:00Z')).toThrow(
      'INVALID_RESEARCH_WINDOW',
    );
    expect(() => audit.analyzeReentries(sequence(), '2026-10-01T00:00:00Z', asOf)).toThrow(
      'INVALID_RESEARCH_WINDOW',
    );
  });

  it('queries exact user-owned cTrader DEMO in read-only transaction', async () => {
    const client = new FakeClient(sequence());
    const report = await audit.runAudit({
      client,
      userId: uid,
      connectionId: connection,
      since: from,
    });
    expect(report.cumulativeReentryWindows['15m'].byCurrency['EUR | ALL'].entries).toBe(3);
    expect(client.calls[0].sql).toContain('REPEATABLE READ READ ONLY');
    expect(client.calls.at(-1)?.sql).toBe('COMMIT');
    expect(audit.SCOPE_SQL).toContain("account_type = 'DEMO'");
    expect(audit.TRADES_SQL).toContain('ti.strategy_code IN');
    expect(client.calls.map((x) => x.sql).join(' ')).not.toMatch(
      /\b(?:UPDATE|INSERT|DELETE|ALTER|DROP)\b/i,
    );
  });

  it('rolls back and refuses wrong account, invalid UUID and history truncation', async () => {
    const wrong = new FakeClient([], false);
    await expect(
      audit.runAudit({ client: wrong, userId: uid, connectionId: connection, since: from }),
    ).rejects.toThrow('OWNER_CTRADER_DEMO_NOT_FOUND');
    expect(wrong.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(wrong.calls.some((x) => x.sql.includes('FROM trading.trades'))).toBe(false);
    await expect(
      audit.runAudit({
        client: wrong,
        userId: 'bad-id',
        connectionId: connection,
        since: from,
      }),
    ).rejects.toThrow('INVALID_DEMO_SCOPE');
    const truncated = new FakeClient(sequence());
    await expect(
      audit.runAudit({
        client: truncated,
        userId: uid,
        connectionId: connection,
        since: from,
        maxTrades: 2,
      }),
    ).rejects.toThrow('TRUNCATED_TRADE_HISTORY');
    expect(truncated.calls.at(-1)?.sql).toBe('ROLLBACK');
  });
});
