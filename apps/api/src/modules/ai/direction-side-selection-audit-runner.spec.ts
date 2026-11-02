import { strict as assert } from 'node:assert';

// Operational entry point intentionally exports CommonJS for deployment and tests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auditRunner = require('../../../scripts/audit-direction-side-selection.cjs') as {
  runDirectionSideSelectionAudit: (input: Record<string, unknown>) => Promise<any>;
  TRADE_COUNTERFACTUAL_SQL: string;
};

const { runDirectionSideSelectionAudit, TRADE_COUNTERFACTUAL_SQL } = auditRunner;

const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const engineCode = 'irexpro-multimodel-ensemble-v1';
const snapshotAt = '2026-11-02T19:00:00.000Z';

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push({ sql, params });
    if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) {
      return { rows: [{ snapshotAt, brokerId: 'ctrader' }] };
    }
    if (sql.includes('FROM trading.trades t')) return { rows: this.rows };
    return { rows: [] };
  }
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    multimodel_plan_b_route: 'EARLY_TRANSITION',
    m1_tactical_route: 'M1_EARLY_TRANSITION',
    m1_route_reliability_reason: 'INSUFFICIENT_EVIDENCE',
    m1_shadow_pair_side_reliability_reason: 'POSITIVE_PROVISIONAL_EXPECTANCY',
    marketRegime: 'TRANSITION',
    position_sizing_tier: 'BASE',
    multimodel_trained_expert_state: 'ABSTAIN',
    multimodel_trained_expert_direction: 'SELL',
    confidenceScore: 0.68,
    feature_candidate_score: 0.77,
    m1_net_expected_r: 0.21,
    m1_execution_cost_r: 0.05,
    ...overrides,
  };
}

function candles() {
  return [
    { timestamp: '2026-11-02T16:05:00.000Z', high: 1.41, low: 1.39, close: 1.405 },
    { timestamp: '2026-11-02T16:10:00.000Z', high: 1.415, low: 1.4, close: 1.41 },
  ];
}

function audit(client: FakeClient, decisions: any[]) {
  const resolveOutcome = (decision: any, path: any[], horizonBars: number) => {
    decisions.push({ decision, path, horizonBars });
    if (decision.entryPrice === 1.4) {
      return { status: 'WIN', netR: 1.55, version: 'test', resolvedAt: snapshotAt };
    }
    if (decision.entryPrice === 1.1) {
      return { status: 'LOSS', netR: -1.05, version: 'test', resolvedAt: snapshotAt };
    }
    return null;
  };
  return runDirectionSideSelectionAudit({
    client,
    userId,
    connectionId,
    engineCode,
    lookbackDays: 14,
    resolveOutcome,
    horizonBars: 72,
  });
}

describe('direction side-selection mirrored-path counterfactual audit', () => {
  it('labels KEEP, FLIP, ABSTAIN and UNRESOLVED from same-entry mirrored geometry', async () => {
    const rows = [
      {
        instrument: 'AUDUSD',
        direction: 'SELL',
        openedAt: '2026-11-02T17:00:00.000Z',
        realisedPnl: '8.20',
        entryPrice: '0.7000',
        stopLoss: '0.7020',
        takeProfit: '0.6968',
        metadata: metadata({ multimodel_trained_expert_direction: 'SELL' }),
        candles: candles(),
      },
      {
        instrument: 'USDCAD',
        direction: 'SELL',
        openedAt: '2026-11-02T16:00:00.000Z',
        realisedPnl: '-4.30',
        entryPrice: '1.4000',
        stopLoss: '1.4050',
        takeProfit: '1.3920',
        metadata: metadata({ multimodel_trained_expert_state: 'ABSTAIN' }),
        candles: candles(),
      },
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        openedAt: '2026-11-02T15:00:00.000Z',
        realisedPnl: '-3.10',
        entryPrice: '1.1000',
        stopLoss: '1.0950',
        takeProfit: '1.1080',
        metadata: metadata({
          multimodel_plan_b_route: 'CONFIRMED_REVERSAL',
          multimodel_trained_expert_state: 'ACTIVE',
          multimodel_trained_expert_direction: 'BUY',
        }),
        candles: candles(),
      },
      {
        instrument: 'USDJPY',
        direction: 'SELL',
        openedAt: '2026-11-02T14:00:00.000Z',
        realisedPnl: '-2.00',
        entryPrice: '153.20',
        stopLoss: '153.35',
        takeProfit: '152.96',
        metadata: {},
        candles: [],
      },
    ];
    const decisions: any[] = [];
    const client = new FakeClient(rows);

    const report = await audit(client, decisions);

    assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    assert.deepEqual(report.labels, {
      closedTrades: 4,
      resolvedTrades: 3,
      unresolvedTrades: 1,
      keep: 1,
      flip: 1,
      abstain: 1,
      keepRate: 1 / 3,
      flipRate: 1 / 3,
      abstainRate: 1 / 3,
    });
    assert.equal(decisions.length, 3, 'executed winners do not need a mirrored replay');

    const mirroredSell = decisions.find((x) => x.decision.entryPrice === 1.4)?.decision;
    assert.equal(mirroredSell.direction, 'BUY');
    assert.ok(Math.abs(mirroredSell.stopLoss - 1.395) < 1e-12);
    assert.ok(Math.abs(mirroredSell.takeProfit - 1.408) < 1e-12);
    assert.equal(mirroredSell.estimatedExecutionCostR, 0.05);
    assert.equal(mirroredSell.candlePriceBasis, 'MID');

    const mirroredBuy = decisions.find((x) => x.decision.entryPrice === 1.1)?.decision;
    assert.equal(mirroredBuy.direction, 'SELL');
    assert.ok(Math.abs(mirroredBuy.stopLoss - 1.105) < 1e-12);
    assert.ok(Math.abs(mirroredBuy.takeProfit - 1.092) < 1e-12);

    assert.match(TRADE_COUNTERFACTUAL_SQL, /market_data\.provider_quote_candles/);
    assert.match(TRADE_COUNTERFACTUAL_SQL, /timeframe = 'M5'/);
    assert.match(TRADE_COUNTERFACTUAL_SQL, /bucket_time > t\.opened_at/);
    assert.match(TRADE_COUNTERFACTUAL_SQL, /LIMIT 72/);
    assert.doesNotMatch(TRADE_COUNTERFACTUAL_SQL, /ensemble_shadow_decisions/);

    const select = client.calls.find((call) => call.sql.includes('FROM trading.trades t'));
    assert.deepEqual(select?.params, [userId, connectionId, engineCode, 14, snapshotAt]);

    assert.equal(report.executionAuthority, 'NONE');
    assert.equal(report.modifiesExecution, false);
    assert.equal(report.qualificationEvidence, false);
    assert.equal(report.productionEligible, false);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(userId));
    assert.ok(!serialized.includes(connectionId));
  });

  it('keeps latent trained-expert disagreement separate from active disagreement and buckets missing metadata safely', async () => {
    const rows = [
      {
        instrument: 'USDCAD',
        direction: 'SELL',
        openedAt: snapshotAt,
        realisedPnl: '-4.30',
        entryPrice: '1.4000',
        stopLoss: '1.4050',
        takeProfit: '1.3920',
        candles: candles(),
        metadata: metadata({
          multimodel_trained_expert_state: 'ABSTAIN',
          multimodel_trained_expert_direction: 'BUY',
        }),
      },
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        openedAt: snapshotAt,
        realisedPnl: '-3.10',
        entryPrice: '1.1000',
        stopLoss: '1.0950',
        takeProfit: '1.1080',
        candles: candles(),
        metadata: metadata({
          multimodel_trained_expert_state: 'ACTIVE',
          multimodel_trained_expert_direction: 'SELL',
        }),
      },
      {
        instrument: 'USDJPY',
        direction: 'SELL',
        openedAt: snapshotAt,
        realisedPnl: '-2.00',
        entryPrice: '153.20',
        stopLoss: '153.35',
        takeProfit: '152.96',
        candles: [],
        metadata: {},
      },
    ];
    const report = await audit(new FakeClient(rows), []);

    assert.equal(
      report.byTrainedExpertRelation.find((x: any) => x.key === 'ABSTAIN_OPPOSES').flip,
      1,
    );
    assert.equal(report.byTrainedExpertRelation.find((x: any) => x.key === 'OPPOSES').abstain, 1);
    assert.equal(
      report.byTrainedExpertRelation.find((x: any) => x.key === 'UNAVAILABLE').unresolved,
      1,
    );
    assert.equal(report.byPlanBRoute.find((x: any) => x.key === 'UNKNOWN').unresolved, 1);
  });

  it('marks invalid or incomplete trade geometry unresolved without fabricating a mirrored decision', async () => {
    const rows = [
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        openedAt: snapshotAt,
        realisedPnl: '-1.00',
        entryPrice: '1.1000',
        stopLoss: null,
        takeProfit: '1.1080',
        candles: candles(),
        metadata: metadata(),
      },
    ];
    const decisions: any[] = [];
    const report = await audit(new FakeClient(rows), decisions);
    assert.equal(report.labels.unresolvedTrades, 1);
    assert.equal(decisions.length, 0);
  });

  it('rolls back when the exact broker scope is unavailable', async () => {
    class MissingScopeClient extends FakeClient {
      async query(sql: string, params?: unknown[]) {
        this.calls.push({ sql, params });
        if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) return { rows: [] };
        return { rows: [] };
      }
    }
    const client = new MissingScopeClient([]);
    await assert.rejects(() => audit(client, []), /AUDIT_SCOPE_UNAVAILABLE/);
    assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
  });
});
