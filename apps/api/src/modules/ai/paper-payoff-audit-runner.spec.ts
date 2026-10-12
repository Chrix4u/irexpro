import { strict as assert } from 'node:assert';
import * as helpers from './paper-payoff-shadow-audit';
import { PAPER_MARKET_SPECS } from '../broker/services/paper-market-spec';

const { runPaperPayoffAudit } = require('../../../scripts/audit-paper-payoff-shadow.cjs');
const userId = '11111111-1111-1111-1111-111111111111';
const connectionId = '22222222-2222-2222-2222-222222222222';
const since = '2026-10-11T00:00:00Z';
const snapshotAt = '2026-10-12T12:00:00Z';
const trade = {
  instrument: 'EURUSD', direction: 'BUY', lotSize: '0.1', entryPrice: '1.1',
  stopLoss: '1.099', initialStopLoss: '1.099', takeProfit: '1.102',
  initialTakeProfit: '1.102', exitPrice: '1.1002', realisedPnl: '2',
  accountCurrency: 'USD', commission: '0', swap: '0', trailingStopPips: null,
  filledQuantity: '0.1', filledEntryPrice: '1.1', positionRecordCount: 1,
  hasPartialCloseOrder: false, executionRoute: 'NORMAL_PAPER', research: false,
  policyVersion: 'p1', modelVersion: 'm1', costModelVersion: 'c1',
  strategyRoute: 'TREND_CONTINUATION', closeReason: 'PROFIT_PROTECTION',
};

function database(options: { scope?: unknown[]; trades?: unknown[];
  shadows?: unknown[]; links?: unknown[]; failure?: boolean } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const results = [
    options.scope ?? [{ accountCurrency: 'USD', snapshotAt }],
    options.trades ?? [trade], options.shadows ?? [], options.links ?? [],
    [{ lastEvaluatedAt: snapshotAt, decisions: 12, executedTrades: 1,
      postLossBlocks: 2, latestGuardReasons: { WAITING_FOR_POST_LOSS_BAR: 2 } }],
  ];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return { rows: [] };
      if (options.failure && results.length === 4) throw new Error('database unavailable');
      return { rows: results.shift() ?? [] };
    },
  };
}

async function audit(client: ReturnType<typeof database>, overrides: Record<string, unknown> = {}) {
  return runPaperPayoffAudit({ client, helpers, paperMarketSpecs: PAPER_MARKET_SPECS,
    userId, connectionId, since, ...overrides });
}

describe('read-only PAPER payoff audit runner', () => {
  it('reports actual profit-lock R separately from binary TP assumptions', async () => {
    const report = await audit(database());
    assert.ok(report, 'the audit must produce a report');
    assert.equal(report.executionAuthority, 'PAPER_ONLY');
    assert.equal(report.modifiesExecution, false);
    assert.equal(report.realised[0].totals.reportedRealisedPnl, 2);
    assert.ok(Math.abs(report.realised[0].payoff.meanRealisedR - 0.2) < 1e-8);
    assert.ok(Math.abs(report.realised[0].payoff.binaryOverstatementR - 1.8) < 1e-8);
    assert.equal(report.shadowMethodology, 'COMPLETED_M5_COUNTERFACTUAL_NOT_REAL_EXECUTION');
    assert.equal(report.calibrationMode, 'REALISED_PAYOFF_DIAGNOSTIC_ONLY');
  });

  it('isolates normal, research, and changed cost-model cohorts', async () => {
    const report = await audit(database({ trades: [trade,
      { ...trade, costModelVersion: 'c2' },
      { ...trade, research: true, executionRoute: 'PAPER_RESEARCH_THROUGHPUT' },
    ] }));
    assert.equal(report.realised.length, 3);
    assert.deepEqual(report.realised.map((r: any) => r.totals.closedTrades), [1, 1, 1]);
  });

  it('leaves unlinked shadow decisions unlinked and records the PAPER spread floor', async () => {
    let received: any[] = [];
    const shadow = { instrument: 'EURUSD', direction: 'BUY', evaluatedAt: snapshotAt,
      marketBarTime: snapshotAt, entryPrice: 1.1, stopLoss: 1.099,
      brokerSpreadPrice: 0.00001, policyVersion: 'p1', modelVersion: 'p1',
      costModelVersion: 'c1', strategyRoute: 'TREND_CONTINUATION', outcome: null };
    const report = await audit(database({ shadows: [shadow] }), { helpers: {
      ...helpers, summarizePaperExitShadows: (rows: any[]) => {
        received = rows;
        return helpers.summarizePaperExitShadows(rows);
      },
    } });
    assert.equal(received[0].paperSpreadPrice, 0.0001);
    assert.equal(received[0].executionRoute, 'SHADOW_UNLINKED');
    assert.equal(report.exitShadows[0].unresolvedRows, 1);
  });

  it('rejects an unowned or non-PAPER connection without reading trade outcomes', async () => {
    const client = database({ scope: [] });
    await assert.rejects(() => audit(client), /PAPER_SCOPE_UNAVAILABLE/);
    assert.equal(client.calls.filter(c => /^\s*(SELECT|WITH)\b/i.test(c.sql)).length, 1);
    assert.equal(client.calls[client.calls.length - 1]?.sql, 'ROLLBACK');
  });

  it('reads all outcomes in one read-only snapshot and binds owner and connection', async () => {
    const client = database();
    await audit(client);
    assert.equal(client.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(client.calls[client.calls.length - 1]?.sql, 'COMMIT');
    for (const call of client.calls.filter(c => /^\s*(SELECT|WITH)\b/i.test(c.sql))) {
      assert.deepEqual(call.params?.slice(0, 2), [userId, connectionId]);
    }
  });

  it('rolls back a failed audit without returning a partial success report', async () => {
    const client = database({ failure: true });
    await assert.rejects(() => audit(client), /database unavailable/);
    assert.equal(client.calls[client.calls.length - 1]?.sql, 'ROLLBACK');
  });

  it('rejects invalid identifiers and dates before connecting to the trading store', async () => {
    const client = database();
    await assert.rejects(() => audit(client, { userId: 'invalid' }), /INVALID_AUDIT_SCOPE/);
    await assert.rejects(() => audit(client, { since: 'invalid' }), /INVALID_AUDIT_WINDOW/);
    assert.equal(client.calls.length, 0);
  });

  it('keeps credentials and account identifiers out of the report', async () => {
    const report = await audit(database({ scope: [{ accountCurrency: 'USD', snapshotAt,
      userId, connectionId, encryptedCredentials: 'secret-fixture' }] }));
    const text = JSON.stringify(report);
    assert.ok(!text.includes(userId) && !text.includes(connectionId));
    assert.ok(!text.includes('secret-fixture'));
  });
});
