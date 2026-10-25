import { strict as assert } from 'node:assert';
import {
  ENSEMBLE_OUTCOME_MODEL_VERSION,
  collapseEnsembleOutcomeEpisodes,
  summarizeEnsembleSleeveOutcomes,
} from './ensemble-shadow-outcome';
import {
  PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT,
  evaluatePaperResearchRequalificationEvidence,
} from './paper-research-requalification-shadow';

// Operational entry point intentionally exports CommonJS for deployment and tests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auditRunner = require('../../../scripts/audit-paper-research-requalification-shadow.cjs') as {
  runPaperResearchRequalificationShadowAudit: (input: Record<string, unknown>) => Promise<any>;
  SHADOW_SQL: string;
};
const { runPaperResearchRequalificationShadowAudit, SHADOW_SQL } = auditRunner;

const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const engineCode = 'irexpro-multimodel-ensemble-v1';
const snapshotAt = '2026-10-25T19:00:00.000Z';

function outcome(
  resolvedAt: string,
  netR: number,
  status: 'WIN' | 'LOSS' | 'EXPIRED' = netR > 0 ? 'WIN' : 'LOSS',
) {
  return {
    version: ENSEMBLE_OUTCOME_MODEL_VERSION,
    status,
    resolvedAt,
    barsObserved: 4,
    exitPrice: 1.1,
    grossR: netR + 0.05,
    netR,
    reason: status === 'WIN' ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
    postEntryTelemetry: null,
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push({ sql, params });
    if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) {
      return { rows: [{ snapshotAt }] };
    }
    if (sql.includes('FROM trading.ensemble_shadow_decisions')) return { rows: this.rows };
    return { rows: [] };
  }
}

function audit(client: FakeClient) {
  return runPaperResearchRequalificationShadowAudit({
    client,
    collapseEnsembleOutcomeEpisodes,
    summarizeEnsembleSleeveOutcomes,
    evaluatePaperResearchRequalificationEvidence,
    artifact: PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT,
    outcomeVersion: ENSEMBLE_OUTCOME_MODEL_VERSION,
    engineCode,
    userId,
    connectionId,
  });
}

describe('PAPER research requalification shadow read-only audit', () => {
  it('uses exact PAPER scope and collapses overlapping pair-side observations before scoring', async () => {
    const client = new FakeClient([
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        evaluatedAt: '2026-10-25T10:00:00.000Z',
        outcome: outcome('2026-10-25T10:30:00.000Z', 0.8),
      },
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        evaluatedAt: '2026-10-25T10:05:00.000Z',
        outcome: outcome('2026-10-25T10:20:00.000Z', 0.5),
      },
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        evaluatedAt: '2026-10-25T10:40:00.000Z',
        outcome: outcome('2026-10-25T10:55:00.000Z', -1),
      },
      {
        instrument: 'AUDUSD',
        direction: 'SELL',
        evaluatedAt: '2026-10-25T11:00:00.000Z',
        outcome: outcome('2026-10-25T11:20:00.000Z', 1.2),
      },
    ]);

    const report = await audit(client);

    assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    assert.equal(report.executionAuthority, 'NONE');
    assert.equal(report.modifiesExecution, false);
    assert.equal(report.qualificationEvidence, false);
    assert.equal(report.productionEligible, false);
    assert.equal(report.annotatedDecisions, 4);
    assert.equal(report.overall.metrics.episodes, 3);
    assert.equal(report.overall.scorecard.state, 'COLLECTING');
    assert.equal(
      report.byPairSide.find((row: any) => row.pairSide === 'EURUSD:BUY').metrics.episodes,
      2,
    );

    const select = client.calls.find((call) =>
      call.sql.includes('FROM trading.ensemble_shadow_decisions'),
    );
    assert.deepEqual(select?.params, [
      userId,
      connectionId,
      engineCode,
      PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT,
      ENSEMBLE_OUTCOME_MODEL_VERSION,
    ]);
    assert.match(SHADOW_SQL, /user_id = \$1/);
    assert.match(SHADOW_SQL, /broker_connection_id = \$2/);
    assert.match(SHADOW_SQL, /engine_code = \$3/);
    assert.match(SHADOW_SQL, /paperResearchRequalificationShadow/);
    assert.match(SHADOW_SQL, /candidate' = 'true'/);
    assert.match(SHADOW_SQL, /outcome'->>'version' = \$5/);

    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(userId));
    assert.ok(!serialized.includes(connectionId));
  });

  it('reports a non-executing recovery signal after eight fresh high-quality episodes', async () => {
    const values = [0.5, 1.0, 0.7, 1.2, 0.6, 0.9, 0.8, 1.1];
    const rows = values.map((netR, index) => ({
      instrument: 'AUDUSD',
      direction: 'SELL',
      evaluatedAt: `2026-10-25T${String(index).padStart(2, '0')}:00:00.000Z`,
      outcome: outcome(`2026-10-25T${String(index).padStart(2, '0')}:20:00.000Z`, netR),
    }));
    const report = await audit(new FakeClient(rows));

    assert.equal(report.overall.metrics.episodes, 8);
    assert.equal(report.overall.metrics.losses, 0);
    assert.equal(report.overall.metrics.profitFactor, null);
    assert.equal(report.overall.scorecard.state, 'RECOVERY_SIGNAL');
    assert.equal(report.overall.scorecard.executionAuthority, 'NONE');
    assert.equal(report.overall.scorecard.qualificationEvidence, false);
    assert.equal(report.overall.scorecard.productionEligible, false);
  });

  it('rolls back when the exact PAPER scope is unavailable', async () => {
    class MissingScopeClient extends FakeClient {
      async query(sql: string, params?: unknown[]) {
        this.calls.push({ sql, params });
        if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) return { rows: [] };
        return { rows: [] };
      }
    }
    const client = new MissingScopeClient([]);
    await assert.rejects(() => audit(client), /PAPER_SCOPE_UNAVAILABLE/);
    assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
  });
});
