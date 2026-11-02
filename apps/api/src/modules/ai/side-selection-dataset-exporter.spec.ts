import { strict as assert } from 'node:assert';

// Operational exporter intentionally uses CommonJS for deployment/read-only research runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const exporter = require('../../../scripts/export-side-selection-three-class-dataset.cjs') as {
  runSideSelectionDatasetExport: (input: Record<string, unknown>) => Promise<any>;
  DECISIONS_SQL: string;
};

const { runSideSelectionDatasetExport, DECISIONS_SQL } = exporter;
const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const engineCode = 'irexpro-multimodel-ensemble-v1';
const outcomeVersion = 'm5-first-hit-72bar-side-aware-v4';
const snapshotAt = '2026-11-02T20:00:00.000Z';

function outcome(status: 'WIN' | 'LOSS' | 'EXPIRED' | 'AMBIGUOUS', resolvedAt: string, netR: number | null) {
  return {
    version: outcomeVersion,
    status,
    resolvedAt,
    netR,
    reason:
      status === 'WIN'
        ? 'TAKE_PROFIT_HIT'
        : status === 'LOSS'
          ? 'STOP_LOSS_HIT'
          : status === 'EXPIRED'
            ? 'HORIZON_EXPIRED'
            : 'SAME_BAR_SL_TP',
  };
}

function row(input: {
  id: string;
  instrument?: string;
  direction: 'BUY' | 'SELL';
  bar: string;
  evaluatedAt: string;
  policy?: string;
  result: ReturnType<typeof outcome>;
  components?: Record<string, unknown>;
}) {
  const policy = input.policy ?? 'policy-cal2';
  return {
    id: input.id,
    instrument: input.instrument ?? 'EURUSD',
    direction: input.direction,
    marketBarTime: input.bar,
    evaluatedAt: input.evaluatedAt,
    modelVersion: policy,
    entryPrice: 1.1,
    components: {
      decisionPolicyVersion: policy,
      strategyRoute: 'EARLY_TRANSITION',
      directionQuality: 0.62,
      candidateScore: 0.71,
      mtfStrength: 0.24,
      governance: {
        netExpectedR: 0.16,
        grossExpectedR: 0.21,
        estimatedExecutionCostR: 0.05,
        driftState: 'IN_DISTRIBUTION',
      },
      highConvictionOverlay: {
        state: 'ABSTAIN',
        direction: input.direction,
        ensembleConfidence: 0.68,
        longVotes: input.direction === 'BUY' ? 2 : 1,
        shortVotes: input.direction === 'SELL' ? 2 : 1,
      },
      calibrationBidirectionalConflict: {
        state: 'NO_CALIBRATION_BLOCK',
        candidateDirectionalProbability: 0.61,
        oppositeDirectionalProbability: 0.39,
        directionalEdge: 0.22,
      },
      outcome: input.result,
      ...(input.components ?? {}),
    },
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) {
      return { rows: [{ snapshotAt, brokerId: 'paper-broker' }] };
    }
    if (sql.includes('FROM trading.ensemble_shadow_decisions')) return { rows: this.rows };
    return { rows: [] };
  }
}

function run(client: FakeClient) {
  return runSideSelectionDatasetExport({
    client,
    userId,
    connectionId,
    engineCode,
    outcomeVersion,
    lookbackDays: 14,
  });
}

describe('side-selection three-class dataset exporter', () => {
  it('pairs simultaneous BUY/SELL shadows and labels KEEP, FLIP and ABSTAIN', async () => {
    const rows = [
      row({
        id: 'a-buy', direction: 'BUY', bar: '2026-11-02T10:00:00Z', evaluatedAt: '2026-11-02T10:00:03Z',
        result: outcome('WIN', '2026-11-02T10:15:00Z', 1.55),
      }),
      row({
        id: 'a-sell', direction: 'SELL', bar: '2026-11-02T10:00:00Z', evaluatedAt: '2026-11-02T10:00:06Z',
        result: outcome('LOSS', '2026-11-02T10:10:00Z', -1.05),
      }),
      row({
        id: 'b-buy', direction: 'BUY', bar: '2026-11-02T10:20:00Z', evaluatedAt: '2026-11-02T10:20:02Z',
        result: outcome('LOSS', '2026-11-02T10:30:00Z', -1.03),
      }),
      row({
        id: 'b-sell', direction: 'SELL', bar: '2026-11-02T10:20:00Z', evaluatedAt: '2026-11-02T10:20:04Z',
        result: outcome('LOSS', '2026-11-02T10:31:00Z', -1.04),
      }),
    ];

    const report = await run(new FakeClient(rows));
    assert.equal(report.pairedEpisodes, 2);
    assert.equal(report.rows.length, 4);
    assert.equal(report.rows[0].episode_id, report.rows[1].episode_id);
    assert.equal(report.rows[0].target_resolved_at, '2026-11-02T10:15:00.000Z');
    assert.deepEqual(
      report.rows.map((x: any) => [x.direction, x.label]),
      [
        ['BUY', 'KEEP'],
        ['SELL', 'FLIP'],
        ['BUY', 'ABSTAIN'],
        ['SELL', 'ABSTAIN'],
      ],
    );
    assert.equal(report.executionAuthority, 'NONE');
    assert.equal(report.modifiesExecution, false);
    assert.equal(report.approvedForDemo, false);
    assert.equal(report.approvedForLive, false);
  });

  it('keeps only the earliest side observation and de-overlaps paired episodes per instrument', async () => {
    const rows = [
      row({ id: 'a-buy-late', direction: 'BUY', bar: '2026-11-02T10:00:00Z', evaluatedAt: '2026-11-02T10:00:09Z', result: outcome('LOSS', '2026-11-02T10:20:00Z', -1) }),
      row({ id: 'a-buy-first', direction: 'BUY', bar: '2026-11-02T10:00:00Z', evaluatedAt: '2026-11-02T10:00:02Z', result: outcome('WIN', '2026-11-02T10:18:00Z', 1.5) }),
      row({ id: 'a-sell', direction: 'SELL', bar: '2026-11-02T10:00:00Z', evaluatedAt: '2026-11-02T10:00:05Z', result: outcome('LOSS', '2026-11-02T10:20:00Z', -1) }),
      row({ id: 'overlap-buy', direction: 'BUY', bar: '2026-11-02T10:05:00Z', evaluatedAt: '2026-11-02T10:05:02Z', result: outcome('LOSS', '2026-11-02T10:15:00Z', -1) }),
      row({ id: 'overlap-sell', direction: 'SELL', bar: '2026-11-02T10:05:00Z', evaluatedAt: '2026-11-02T10:05:04Z', result: outcome('WIN', '2026-11-02T10:15:00Z', 1.5) }),
      row({ id: 'next-buy', direction: 'BUY', bar: '2026-11-02T10:25:00Z', evaluatedAt: '2026-11-02T10:25:02Z', result: outcome('LOSS', '2026-11-02T10:35:00Z', -1) }),
      row({ id: 'next-sell', direction: 'SELL', bar: '2026-11-02T10:25:00Z', evaluatedAt: '2026-11-02T10:25:05Z', result: outcome('WIN', '2026-11-02T10:35:00Z', 1.5) }),
    ];

    const report = await run(new FakeClient(rows));
    assert.equal(report.pairedEpisodes, 2);
    assert.equal(report.rows.length, 4);
    assert.equal(report.rows[0].label, 'KEEP');
    assert.equal(report.rows[0].decision_time, '2026-11-02T10:00:05.000Z');
    assert.equal(report.rows[2].decision_time, '2026-11-02T10:25:05.000Z');
  });

  it('rejects loose pairing, unresolved outcomes and prevents post-entry fields from entering features', async () => {
    const rows = [
      row({ id: 'gap-buy', direction: 'BUY', bar: '2026-11-02T11:00:00Z', evaluatedAt: '2026-11-02T11:00:01Z', result: outcome('WIN', '2026-11-02T11:10:00Z', 1.5), components: { postEntryTelemetry: { mfe: 9 }, realisedPnl: 100 } }),
      row({ id: 'gap-sell', direction: 'SELL', bar: '2026-11-02T11:00:00Z', evaluatedAt: '2026-11-02T11:00:45Z', result: outcome('LOSS', '2026-11-02T11:10:00Z', -1) }),
      row({ id: 'expired-buy', direction: 'BUY', bar: '2026-11-02T12:00:00Z', evaluatedAt: '2026-11-02T12:00:01Z', result: outcome('EXPIRED', '2026-11-02T13:00:00Z', 0.2) }),
      row({ id: 'expired-sell', direction: 'SELL', bar: '2026-11-02T12:00:00Z', evaluatedAt: '2026-11-02T12:00:03Z', result: outcome('LOSS', '2026-11-02T12:20:00Z', -1) }),
      row({ id: 'clean-buy', direction: 'BUY', bar: '2026-11-02T14:00:00Z', evaluatedAt: '2026-11-02T14:00:01Z', result: outcome('WIN', '2026-11-02T14:10:00Z', 1.5), components: { postEntryTelemetry: { mfe: 9 }, realisedPnl: 100 } }),
      row({ id: 'clean-sell', direction: 'SELL', bar: '2026-11-02T14:00:00Z', evaluatedAt: '2026-11-02T14:00:03Z', result: outcome('LOSS', '2026-11-02T14:10:00Z', -1) }),
    ];

    const report = await run(new FakeClient(rows));
    assert.equal(report.pairedEpisodes, 1);
    assert.equal(report.rows.length, 2);
    const serialized = JSON.stringify(report.rows[0]).toLowerCase();
    for (const forbidden of ['realisedpnl', 'mfe', 'mae', 'close_reason', 'postentrytelemetry']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
    assert.equal(report.rows[0].strategy_route, 'EARLY_TRANSITION');
    assert.equal(report.rows[0].governance_net_expected_r, 0.16);
    assert.equal(report.rows[0].calibration_directional_edge, 0.22);
  });

  it('uses exact read-only scope and rolls back when unavailable', async () => {
    const client = new FakeClient([]);
    await run(client);
    assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.match(DECISIONS_SQL, /user_id = \$1/);
    assert.match(DECISIONS_SQL, /broker_connection_id = \$2/);
    assert.match(DECISIONS_SQL, /engine_code = \$3/);
    assert.match(DECISIONS_SQL, /outcome'->>'version' = \$6/);

    class MissingScopeClient extends FakeClient {
      async query(sql: string, params?: unknown[]) {
        this.calls.push({ sql, params });
        if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) return { rows: [] };
        return { rows: [] };
      }
    }
    const missing = new MissingScopeClient([]);
    await assert.rejects(() => run(missing), /DATASET_SCOPE_UNAVAILABLE/);
    assert.equal(missing.calls.at(-1)?.sql, 'ROLLBACK');
  });
});
