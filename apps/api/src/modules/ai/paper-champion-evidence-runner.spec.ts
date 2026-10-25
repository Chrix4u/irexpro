import { buildPaperChampionEvidence } from './paper-champion-evidence';

interface AuditReport {
  artifact: string;
  mode: string;
  generatedAt: string;
  modifiesExecution: boolean;
  approvedForDemo: boolean;
  approvedForLive: boolean;
  forward: { champion: { metrics: { trades: number } } };
  research: {
    genericSixPair: { verdict: string };
    brokerNativeProspective: { verdict: string; nextAction: string };
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auditRunner = require('../../../scripts/audit-paper-champion-evidence.cjs') as {
  runPaperChampionEvidenceAudit: (input: Record<string, unknown>) => Promise<AuditReport>;
};
const { runPaperChampionEvidenceAudit } = auditRunner;

const CHAMPION = 'external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1';
const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];

function frozenSixPairSummary() {
  const gate = (profitFactor: number, sharpe: number, balancedAccuracy: number) => ({
    research_gate_passed: false,
    observed: {
      profit_factor: profitFactor,
      sharpe_ratio: sharpe,
      balanced_accuracy: balancedAccuracy,
      max_drawdown: 0.01,
      positive_fold_fraction: 0,
      positive_instrument_fraction: 1 / 6,
    },
  });
  return {
    report_version: 1,
    horizon_reports: {
      '1m': { research_gate: gate(0.22, -14.7, 0.506) },
      '5m': { research_gate: gate(0.08, -15.3, 0.509) },
      '10m': { research_gate: gate(0.57, -4.8, 0.513) },
    },
  };
}

function frozenV84() {
  return {
    artifact: 'broker-native-v84-base-h5-prospective-v1',
    mode: 'FALSIFICATION_ONLY_UNTOUCHED_POST_CUTOFF',
    economic_screen_passed: false,
    promotion_eligible: false,
    approved_for_paper: false,
    approved_for_demo: false,
    approved_for_live: false,
    next_action: 'REJECT_BASE_5M_BROKER_NATIVE_ARCHITECTURE',
    metrics: {
      n: 3,
      profit_factor: 0,
      sharpe: -1.856,
      balanced_accuracy: 0.5,
      positive_instrument_fraction: 0,
      net_return: -0.00099,
    },
  };
}

class FakeClient {
  readonly statements: string[] = [];
  private readonly trades: Array<Record<string, unknown>>;

  constructor(trades: Array<Record<string, unknown>>) {
    this.trades = trades;
  }

  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.statements.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('CURRENT_TIMESTAMP AS "snapshotAt"')) {
      return { rows: [{ snapshotAt: '2026-10-25T03:00:00.000Z' }] };
    }
    if (sql.includes('FROM trading.trades t')) return { rows: this.trades };
    return { rows: [] };
  }
}

describe('Friday champion evidence read-only runner', () => {
  it('runs in a repeatable-read read-only transaction and returns only sanitized aggregate evidence', async () => {
    const trades = Array.from({ length: 60 }, (_, index) => ({
      instrument: PAIRS[index % PAIRS.length],
      direction: index % 2 === 0 ? 'BUY' : 'SELL',
      timeframe: 'M5',
      modelVersion: CHAMPION,
      strategyRoute: 'TREND_CONTINUATION',
      decisionPolicyVersion: 'policy-a',
      realisedPnl: index % 5 === 0 ? '-1.00' : '2.00',
      openedAt: `2026-10-${String(5 + (index % 15)).padStart(2, '0')}T10:00:00.000Z`,
    }));
    const client = new FakeClient(trades);

    const report = await runPaperChampionEvidenceAudit({
      client,
      buildPaperChampionEvidence,
      compatiblePolicyVersions: ['policy-a'],
      championModelVersion: CHAMPION,
      expectedInstruments: PAIRS,
      userId: '00000000-0000-4000-8000-000000000001',
      connectionId: '00000000-0000-4000-8000-000000000002',
      sixPairSummary: frozenSixPairSummary(),
      brokerProspective: frozenV84(),
    });

    expect(client.statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(client.statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(client.statements.at(-1)).toBe('COMMIT');
    expect(report).toMatchObject({
      artifact: 'friday-champion-evidence-v1',
      mode: 'READ_ONLY_EVIDENCE_AUDIT',
      generatedAt: '2026-10-25T03:00:00.000Z',
      modifiesExecution: false,
      approvedForDemo: false,
      approvedForLive: false,
      research: {
        genericSixPair: { verdict: 'REJECTED_ALL_HORIZONS' },
        brokerNativeProspective: {
          verdict: 'REJECTED',
          nextAction: 'REJECT_BASE_5M_BROKER_NATIVE_ARCHITECTURE',
        },
      },
    });
    expect(report.forward.champion.metrics.trades).toBe(60);

    const serialized = JSON.stringify(report);
    for (const forbidden of [
      'userId',
      'connectionId',
      'accountId',
      'tradeId',
      'signalId',
      'credential',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('fails explicitly and rolls back when frozen six-pair research evidence is malformed', async () => {
    const client = new FakeClient([]);

    await expect(
      runPaperChampionEvidenceAudit({
        client,
        buildPaperChampionEvidence,
        compatiblePolicyVersions: ['policy-a'],
        championModelVersion: CHAMPION,
        expectedInstruments: PAIRS,
        userId: '00000000-0000-4000-8000-000000000001',
        connectionId: '00000000-0000-4000-8000-000000000002',
        sixPairSummary: { horizon_reports: { '1m': {} } },
        brokerProspective: frozenV84(),
      }),
    ).rejects.toThrow('INVALID_SIX_PAIR_RESEARCH_EVIDENCE');

    expect(client.statements.at(-1)).toBe('ROLLBACK');
  });

  it('fails explicitly and rolls back when the broker-native prospective artifact is missing its verdict', async () => {
    const client = new FakeClient([]);

    await expect(
      runPaperChampionEvidenceAudit({
        client,
        buildPaperChampionEvidence,
        compatiblePolicyVersions: ['policy-a'],
        championModelVersion: CHAMPION,
        expectedInstruments: PAIRS,
        userId: '00000000-0000-4000-8000-000000000001',
        connectionId: '00000000-0000-4000-8000-000000000002',
        sixPairSummary: frozenSixPairSummary(),
        brokerProspective: { artifact: 'broken' },
      }),
    ).rejects.toThrow('INVALID_BROKER_PROSPECTIVE_EVIDENCE');

    expect(client.statements.at(-1)).toBe('ROLLBACK');
  });
});
