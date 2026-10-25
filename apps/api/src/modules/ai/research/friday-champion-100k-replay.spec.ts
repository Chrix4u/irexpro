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

import { PAPER_MARKET_SPECS } from '../../broker/services/paper-market-spec';
import {
  buildExecutableReplayQuote,
  replayPaperEpisode,
  type ReplayQuote,
} from './friday-champion-100k-replay';

function replayCandidate(direction: 'BUY' | 'SELL') {
  const entry = 1.1;
  return {
    instrument: 'EURUSD',
    direction,
    confidence: 0.7,
    volatilityScore: 0.2,
    entry,
    stopLoss: direction === 'BUY' ? 1.099 : 1.101,
    takeProfit: direction === 'BUY' ? 1.102 : 1.098,
    barTime: new Date('2026-07-01T10:00:00Z'),
    score: 1,
    atr: 0.0005,
    extensionAtr: 0.2,
    emaSeparation: 0.2,
    mtfStrength: 0.2,
    h4Alignment: 0,
    h4ContextAvailable: false,
    h4ClosedBarCount: 0,
    rsi14: 55,
    shortHorizonMomentumAtr: 0.1,
  };
}

function quote(at: string, mid: number, spread = 0.0001): ReplayQuote {
  return { observedAt: new Date(at), mid, spread };
}

describe('Friday champion 100k replay PAPER lifecycle economics', () => {
  it('uses the executable side and never a cheaper spread than the PAPER fallback', () => {
    const paperSpread = PAPER_MARKET_SPECS.EURUSD!.spread;
    const buy = buildExecutableReplayQuote('EURUSD', 'BUY', 1.1, paperSpread / 2);
    const sell = buildExecutableReplayQuote('EURUSD', 'SELL', 1.1, paperSpread / 2);
    expect(buy.spread).toBe(paperSpread);
    expect(buy.executable).toBeCloseTo(1.1 + paperSpread / 2, 10);
    expect(sell.executable).toBeCloseTo(1.1 - paperSpread / 2, 10);
  });

  it('closes BUY and SELL episodes on the production executable protective side', () => {
    const buy = replayPaperEpisode(replayCandidate('BUY'), quote('2026-07-01T10:05:00Z', 1.1), [
      quote('2026-07-01T10:06:00Z', 1.1022),
    ]);
    expect(buy.exitReason).toBe('TAKE_PROFIT');
    expect(buy.r).toBeGreaterThan(0);

    const sell = replayPaperEpisode(replayCandidate('SELL'), quote('2026-07-01T10:05:00Z', 1.1), [
      quote('2026-07-01T10:06:00Z', 1.1012),
    ]);
    expect(sell.exitReason).toBe('STOP_LOSS');
    expect(sell.r).toBeLessThan(0);
  });

  it('uses the production profit lock and M5 time-to-work lifecycle', () => {
    const candidate = replayCandidate('BUY');
    const locked = replayPaperEpisode(candidate, quote('2026-07-01T10:05:00Z', 1.1), [
      quote('2026-07-01T10:06:00Z', 1.1008),
      quote('2026-07-01T10:07:00Z', 1.10055),
    ]);
    expect(locked.exitReason).toBe('PROFIT_LOCK');
    expect(locked.maxFavorableR).toBeGreaterThanOrEqual(0.5);

    const timedPath = Array.from({ length: 30 }, (_, index) => {
      const minute = index + 1;
      const at = new Date(Date.parse('2026-07-01T10:05:00Z') + minute * 60_000).toISOString();
      return quote(at, minute === 30 ? 1.0997 : 1.1);
    });
    const timed = replayPaperEpisode(candidate, quote('2026-07-01T10:05:00Z', 1.1), timedPath);
    expect(timed.exitReason).toBe('FAILED_TO_WORK_30M');
  });

  it('fails closed at an M1 data gap instead of carrying a position across missing history', () => {
    const episode = replayPaperEpisode(replayCandidate('BUY'), quote('2026-07-01T10:05:00Z', 1.1), [
      quote('2026-07-01T10:06:00Z', 1.1001),
      quote('2026-07-01T10:12:00Z', 1.1002),
    ]);
    expect(episode.exitReason).toBe('DATA_GAP');
    expect(episode.exitAt).toEqual(new Date('2026-07-01T10:06:00Z'));
  });
});

import {
  buildChronologicalReplayFolds,
  buildReplayStressReport,
  summarizeReplayEpisodes,
  type ReplayEvidenceEpisode,
} from './friday-champion-100k-replay';

function evidenceEpisode(
  pair: string,
  at: string,
  r: number,
  route = 'EARLY_TRANSITION',
): ReplayEvidenceEpisode {
  return {
    instrument: pair,
    direction: 'BUY',
    openedAt: new Date(at),
    exitAt: new Date(Date.parse(at) + 60_000),
    entryPrice: 1,
    exitPrice: 1 + r * 0.001,
    initialRiskPrice: 0.001,
    r,
    maxFavorableR: Math.max(0, r),
    exitReason: r > 0 ? 'TAKE_PROFIT' : 'STOP_LOSS',
    strategyRoute: route,
    confidence: 0.7,
  };
}

describe('Friday champion 100k replay metrics and folds', () => {
  it('computes PF, episode Sharpe, max drawdown and six-pair breadth with the full denominator', () => {
    const episodes = [
      evidenceEpisode('EURUSD', '2026-06-01T00:00:00Z', 2),
      evidenceEpisode('EURUSD', '2026-06-01T00:05:00Z', -1),
      evidenceEpisode('GBPUSD', '2026-06-01T00:10:00Z', 1),
      evidenceEpisode('USDJPY', '2026-06-01T00:15:00Z', 0.5),
      evidenceEpisode('AUDUSD', '2026-06-01T00:20:00Z', -0.5),
    ];
    const metrics = summarizeReplayEpisodes(episodes, [
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'AUDUSD',
      'USDCAD',
      'USDCHF',
    ]);
    expect(metrics.episodes).toBe(5);
    expect(metrics.netR).toBeCloseTo(2, 10);
    expect(metrics.profitFactor).toBeCloseTo(3.5 / 1.5, 10);
    expect(metrics.positiveInstrumentFraction).toBe(3 / 6);
    expect(metrics.maxDrawdownR).toBeCloseTo(1, 10);
    expect(metrics.episodeSharpe).toBeGreaterThan(0);
  });

  it('keeps identical decision timestamps in the same chronological fold', () => {
    const episodes = [
      evidenceEpisode('EURUSD', '2026-06-01T00:00:00Z', 1),
      evidenceEpisode('GBPUSD', '2026-06-01T00:00:00Z', -1),
      evidenceEpisode('USDJPY', '2026-06-02T00:00:00Z', 1),
      evidenceEpisode('AUDUSD', '2026-06-03T00:00:00Z', 1),
      evidenceEpisode('USDCAD', '2026-06-04T00:00:00Z', -1),
    ];
    const folds = buildChronologicalReplayFolds(episodes, 3);
    const memberships = folds.flatMap((fold, index) =>
      fold.map((episode) => ({ index, at: episode.openedAt.toISOString() })),
    );
    const sameTime = memberships.filter((item) => item.at === '2026-06-01T00:00:00.000Z');
    expect(new Set(sameTime.map((item) => item.index)).size).toBe(1);
    expect(folds).toHaveLength(3);
  });

  it('builds a stress report with all promotion flags permanently false', () => {
    const episodes = [
      evidenceEpisode('EURUSD', '2026-06-01T00:00:00Z', 2),
      evidenceEpisode('GBPUSD', '2026-06-02T00:00:00Z', 1),
      evidenceEpisode('USDJPY', '2026-06-03T00:00:00Z', 1),
      evidenceEpisode('AUDUSD', '2026-06-04T00:00:00Z', 1),
      evidenceEpisode('USDCAD', '2026-06-05T00:00:00Z', -0.5),
      evidenceEpisode('USDCHF', '2026-06-06T00:00:00Z', 1),
    ];
    const report = buildReplayStressReport(episodes, {
      sourceCommit: 'abc123',
      corpusLabel: 'six-pair-100k-test',
      observedTradingDays: 10,
      expectedInstruments: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'],
    });
    expect(report.approvedForPaper).toBe(false);
    expect(report.approvedForDemo).toBe(false);
    expect(report.approvedForLive).toBe(false);
    expect(report.classification).toBe('HISTORICAL_ARCHITECTURE_STRESS_REPLAY');
    expect(report.aggregate.positiveInstrumentFraction).toBe(5 / 6);
    expect(report.folds).toHaveLength(3);
  });
});
