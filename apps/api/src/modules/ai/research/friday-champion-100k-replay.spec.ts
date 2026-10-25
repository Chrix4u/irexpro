import { reconstructClosedM5Bars, type MtfM5Row } from './friday-champion-100k-replay';

function row(overrides: Partial<MtfM5Row> = {}): MtfM5Row {
  return {
    decision_time: '2026-06-17T12:00:00Z',
    m5_source_bar_open: '2026-06-17T11:55:00Z',
    m5_available_at: '2026-06-17T12:00:00Z',
    m5_open: '1.1000',
    m5_high: '1.1010',
    m5_low: '1.0990',
    m5_close: '1.1005',
    m5_spread_price: '0.0001',
    ...overrides,
  };
}

describe('Friday champion 100k replay corpus reconstruction', () => {
  it('deduplicates one fully available M5 bar repeated across M1 decision rows', () => {
    const rows = [
      row(),
      row({ decision_time: '2026-06-17T12:01:00Z' }),
      row({ decision_time: '2026-06-17T12:02:00Z' }),
      row({ decision_time: '2026-06-17T12:03:00Z' }),
      row({ decision_time: '2026-06-17T12:04:00Z' }),
      row({
        decision_time: '2026-06-17T12:05:00Z',
        m5_source_bar_open: '2026-06-17T12:00:00Z',
        m5_available_at: '2026-06-17T12:05:00Z',
        m5_open: '1.1005',
        m5_high: '1.1020',
        m5_low: '1.1000',
        m5_close: '1.1015',
      }),
    ];

    expect(reconstructClosedM5Bars(rows)).toEqual([
      expect.objectContaining({
        timestamp: new Date('2026-06-17T11:55:00Z'),
        availableAt: new Date('2026-06-17T12:00:00Z'),
        close: '1.1005',
      }),
      expect.objectContaining({
        timestamp: new Date('2026-06-17T12:00:00Z'),
        availableAt: new Date('2026-06-17T12:05:00Z'),
        close: '1.1015',
      }),
    ]);
  });

  it('fails closed when a row exposes an M5 bar before its availability time', () => {
    expect(() =>
      reconstructClosedM5Bars([
        row({
          decision_time: '2026-06-17T11:59:00Z',
          m5_available_at: '2026-06-17T12:00:00Z',
        }),
      ]),
    ).toThrow('M5_BAR_NOT_YET_AVAILABLE');
  });

  it('sorts bars by source open and fails on inconsistent duplicates', () => {
    const earlier = row({
      decision_time: '2026-06-17T11:55:00Z',
      m5_source_bar_open: '2026-06-17T11:50:00Z',
      m5_available_at: '2026-06-17T11:55:00Z',
      m5_close: '1.0995',
    });
    expect(reconstructClosedM5Bars([row(), earlier]).map((bar) => bar.close)).toEqual([
      '1.0995',
      '1.1005',
    ]);

    expect(() => reconstructClosedM5Bars([row(), row({ m5_close: '1.1006' })])).toThrow(
      'INCONSISTENT_M5_DUPLICATE',
    );
  });

  it('fails closed on invalid timestamps or OHLC values', () => {
    expect(() => reconstructClosedM5Bars([row({ m5_high: 'not-a-number' })])).toThrow(
      'INVALID_M5_ROW',
    );
    expect(() => reconstructClosedM5Bars([row({ m5_source_bar_open: 'bad-time' })])).toThrow(
      'INVALID_M5_ROW',
    );
  });
});

import { buildDirectionalCandidates } from '../vps-forex-signal-collector.service';
import { scorePlanBMultimodelShadow } from '../plan-b-multimodel-shadow';
import {
  candidateToPlanBInput,
  scoreIntrinsicM5Snapshot,
  selectIntrinsicPaperSide,
  type IntrinsicReplayCandidate,
} from './friday-champion-100k-replay';

function trendingCandles(count = 360) {
  const start = Date.parse('2026-07-01T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const close = 1.1 + index * 0.00001 + Math.sin(index / 2) * 0.0001;
    return {
      timestamp: new Date(start + index * 5 * 60_000),
      open: close.toFixed(5),
      high: (close + 0.00008).toFixed(5),
      low: (close - 0.00008).toFixed(5),
      close: close.toFixed(5),
    };
  });
}

describe('Friday champion 100k replay production scorer wiring', () => {
  it('uses the exact production candidate builder and Plan-B input boundary', () => {
    const candles = trendingCandles();
    const directCandidates = buildDirectionalCandidates('EURUSD', candles);
    expect(directCandidates).toHaveLength(2);

    const replay = scoreIntrinsicM5Snapshot('EURUSD', candles);
    expect(replay).toHaveLength(2);

    for (const direct of directCandidates) {
      const replayed = replay.find(
        (candidate) => candidate.candidate.direction === direct.direction,
      );
      expect(replayed?.candidate).toEqual(direct);
      const expectedInput = {
        instrument: direct.instrument,
        direction: direct.direction,
        confidence: direct.confidence,
        extensionAtr: direct.extensionAtr,
        volatilityScore: direct.volatilityScore,
        emaSeparation: direct.emaSeparation,
        mtfStrength: direct.mtfStrength,
        rsi14: direct.rsi14,
        shortHorizonMomentumAtr:
          (direct.direction === 'BUY' ? 1 : -1) * direct.shortHorizonMomentumAtr,
        scanTime: new Date(direct.barTime.getTime() + 5 * 60_000),
      };
      expect(candidateToPlanBInput(direct)).toEqual(expectedInput);
      expect(replayed?.ensemble).toEqual(scorePlanBMultimodelShadow(expectedInput, []));
    }
  });

  it('selects only intrinsically paper-admitted sides and fails closed on an exact score tie', () => {
    const base = {
      candidate: { direction: 'BUY', score: 90 } as IntrinsicReplayCandidate['candidate'],
      ensemble: { paperAdmitted: true } as IntrinsicReplayCandidate['ensemble'],
    };
    const sell = {
      candidate: { direction: 'SELL', score: 80 } as IntrinsicReplayCandidate['candidate'],
      ensemble: { paperAdmitted: true } as IntrinsicReplayCandidate['ensemble'],
    };
    expect(selectIntrinsicPaperSide([base, sell])?.candidate.direction).toBe('BUY');
    expect(
      selectIntrinsicPaperSide([base, { ...sell, candidate: { ...sell.candidate, score: 90 } }]),
    ).toBeNull();
    expect(
      selectIntrinsicPaperSide([
        { ...base, ensemble: { paperAdmitted: false } as IntrinsicReplayCandidate['ensemble'] },
        sell,
      ])?.candidate.direction,
    ).toBe('SELL');
  });
});
