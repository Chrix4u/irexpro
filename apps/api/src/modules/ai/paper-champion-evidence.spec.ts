import {
  buildPaperChampionEvidence,
  type PaperChampionTradeEvidenceRow,
} from './paper-champion-evidence';

const CHAMPION = 'external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1';
const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'] as const;
const COMPATIBLE = ['policy-compatible-a', 'policy-compatible-b'] as const;

function trade(input: Partial<PaperChampionTradeEvidenceRow> = {}): PaperChampionTradeEvidenceRow {
  return {
    instrument: 'EURUSD',
    direction: 'BUY',
    timeframe: 'M5',
    modelVersion: CHAMPION,
    strategyRoute: 'TREND_CONTINUATION',
    decisionPolicyVersion: 'policy-compatible-a',
    realisedPnl: 1,
    openedAt: '2026-10-20T00:00:00Z',
    ...input,
  };
}

function profitableChampionRows(): PaperChampionTradeEvidenceRow[] {
  const rows: PaperChampionTradeEvidenceRow[] = [];
  for (let index = 0; index < 100; index += 1) {
    const instrument = PAIRS[index % PAIRS.length];
    const positivePair = instrument !== 'USDCAD';
    rows.push(
      trade({
        instrument,
        direction: index % 2 === 0 ? 'BUY' : 'SELL',
        realisedPnl: positivePair ? (index % 5 === 0 ? -1 : 1.5) : index % 2 === 0 ? -1 : 0.8,
      }),
    );
  }
  return rows;
}

describe('Friday champion evidence', () => {
  it('labels a sufficiently sampled profitable six-pair normal M5 cohort as the provisional champion', () => {
    const evidence = buildPaperChampionEvidence(profitableChampionRows(), {
      championModelVersion: CHAMPION,
      expectedInstruments: [...PAIRS],
      compatiblePolicyVersions: [...COMPATIBLE],
    });

    expect(evidence.champion.metrics.trades).toBe(100);
    expect(evidence.champion.metrics.netPnl).toBeGreaterThan(0);
    expect(evidence.champion.metrics.profitFactor).toBeGreaterThanOrEqual(1.15);
    expect(evidence.champion.positiveInstrumentFraction).toBe(5 / 6);
    expect(evidence.champion.checks).toEqual({
      tradesGte50: true,
      positiveNetPnl: true,
      profitFactorGte1_15: true,
      positiveInstrumentFractionGte0_67: true,
    });
    expect(evidence.champion.status).toBe('PROVISIONAL_FORWARD_CHAMPION');
    expect(evidence.modifiesExecution).toBe(false);
    expect(evidence.approvedForDemo).toBe(false);
    expect(evidence.approvedForLive).toBe(false);
  });

  it('reports a zero-loss cohort with null profit factor without treating null as failure when the sample and PnL are strong', () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      trade({ instrument: PAIRS[index % PAIRS.length], realisedPnl: 1 }),
    );

    const evidence = buildPaperChampionEvidence(rows, {
      championModelVersion: CHAMPION,
      expectedInstruments: [...PAIRS],
      compatiblePolicyVersions: [...COMPATIBLE],
    });

    expect(evidence.champion.metrics.profitFactor).toBeNull();
    expect(evidence.champion.metrics.grossLoss).toBe(0);
    expect(evidence.champion.checks.profitFactorGte1_15).toBe(true);
    expect(evidence.champion.status).toBe('PROVISIONAL_FORWARD_CHAMPION');
  });

  it('does not let stale policy losses create a mature compatible sleeve veto', () => {
    const rows = [
      ...Array.from({ length: 12 }, () =>
        trade({
          instrument: 'USDCAD',
          direction: 'BUY',
          strategyRoute: 'TREND_CONTINUATION',
          decisionPolicyVersion: 'old-incompatible-policy',
          realisedPnl: -4,
        }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        trade({
          instrument: 'USDCAD',
          direction: 'BUY',
          strategyRoute: 'TREND_CONTINUATION',
          decisionPolicyVersion: 'policy-compatible-a',
          realisedPnl: index < 3 ? 2 : -2,
        }),
      ),
    ];

    const evidence = buildPaperChampionEvidence(rows, {
      championModelVersion: CHAMPION,
      expectedInstruments: [...PAIRS],
      compatiblePolicyVersions: [...COMPATIBLE],
    });
    const sleeve = evidence.compatibleSleeves.find(
      (candidate) =>
        candidate.instrument === 'USDCAD' &&
        candidate.direction === 'BUY' &&
        candidate.strategyRoute === 'TREND_CONTINUATION',
    );

    expect(sleeve).toMatchObject({
      trades: 5,
      state: 'COLLECTING_COMPATIBLE_SLEEVE',
      executionVetoRecommended: false,
    });
    expect(evidence.compatibleMatureWeakSleeves).toHaveLength(0);
  });

  it('flags only a mature weak compatible route pair side and keeps descriptive stale rows separate', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        trade({
          instrument: 'USDCAD',
          direction: 'BUY',
          strategyRoute: 'TREND_CONTINUATION',
          decisionPolicyVersion: index < 4 ? 'policy-compatible-a' : 'policy-compatible-b',
          realisedPnl: index < 2 ? 1 : -2,
        }),
      ),
      ...Array.from({ length: 20 }, () =>
        trade({
          instrument: 'USDCAD',
          direction: 'BUY',
          strategyRoute: 'TREND_CONTINUATION',
          decisionPolicyVersion: 'old-incompatible-policy',
          realisedPnl: 10,
        }),
      ),
      ...Array.from({ length: 8 }, () =>
        trade({
          instrument: 'GBPUSD',
          direction: 'SELL',
          strategyRoute: 'TREND_CONTINUATION',
          decisionPolicyVersion: 'policy-compatible-a',
          realisedPnl: 2,
        }),
      ),
    ];

    const evidence = buildPaperChampionEvidence(rows, {
      championModelVersion: CHAMPION,
      expectedInstruments: [...PAIRS],
      compatiblePolicyVersions: [...COMPATIBLE],
    });

    expect(evidence.compatibleMatureWeakSleeves).toEqual([
      expect.objectContaining({
        instrument: 'USDCAD',
        direction: 'BUY',
        strategyRoute: 'TREND_CONTINUATION',
        trades: 8,
        state: 'MATURE_WEAK_COMPATIBLE_SLEEVE',
        executionVetoRecommended: true,
      }),
    ]);
    expect(
      evidence.compatibleSleeves.find(
        (candidate) => candidate.instrument === 'GBPUSD' && candidate.direction === 'SELL',
      ),
    ).toEqual(
      expect.objectContaining({
        trades: 8,
        profitFactor: null,
        state: 'MATURE_HEALTHY_COMPATIBLE_SLEEVE',
        executionVetoRecommended: false,
      }),
    );
    expect(
      evidence.descriptive.byRoutePairSide.find(
        (candidate) => candidate.instrument === 'USDCAD' && candidate.direction === 'BUY',
      )?.trades,
    ).toBe(28);
  });

  it('counts break-even trades separately from wins and losses', () => {
    const evidence = buildPaperChampionEvidence(
      [trade({ realisedPnl: 2 }), trade({ realisedPnl: -1 }), trade({ realisedPnl: 0 })],
      {
        championModelVersion: CHAMPION,
        expectedInstruments: [...PAIRS],
        compatiblePolicyVersions: [...COMPATIBLE],
      },
    );

    expect(evidence.champion.metrics).toMatchObject({
      trades: 3,
      wins: 1,
      losses: 1,
      breakeven: 1,
      grossProfit: 2,
      grossLoss: 1,
      netPnl: 1,
      profitFactor: 2,
    });
  });
});
