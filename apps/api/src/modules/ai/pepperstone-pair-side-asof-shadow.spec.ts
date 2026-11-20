import {
  evaluatePepperstonePairSideAsOfShadow as score,
  type PepperstonePairSideAsOfRow,
} from './pepperstone-pair-side-asof-shadow';

const AS_OF = new Date('2026-11-16T06:17:00.000Z');
const make = (
  closedAt: string,
  net: string | null,
  risk: string | null = '100',
): PepperstonePairSideAsOfRow => ({
  closedAt,
  netPnl: net,
  riskAtStop: risk,
});

describe('prospective Pepperstone pair-side quality research', () => {
  it('is always non-executable, even with a strong history', () => {
    const rows = Array.from({length: 12}, (_, i) => make(
      new Date(Date.UTC(2026, 10, 10 + Math.floor(i / 4), i % 4)).toISOString(),
      i % 4 === 0 ? '-25' : '90',
    ));
    const d = score(rows, AS_OF);
    expect(d).toMatchObject({
      mode: 'RESEARCH_ONLY',
      modifiesExecution: false,
      grantsExecution: false,
      entryVeto: false,
      state: 'SUPPORTIVE_HISTORICAL_EDGE',
      historyClosedTrades: 12,
      pricedTrades: 12,
      distinctClosingDays: 3,
    });
  });

  it('detects three settled prior losses with insufficient edge history', () => {
    const rows = [
      make('2026-11-13T14:35:00Z', '-5.58'),
      make('2026-11-16T06:02:09Z', '-102.83'),
      make('2026-11-16T06:12:00Z', '-85'),
    ];
    const d = score(rows, AS_OF);
    expect(d).toMatchObject({
      state: 'UNKNOWN',
      reason: 'INSUFFICIENT_INDEPENDENT_HISTORY',
      consecutiveNetLosses: 3,
      threeLossStreakCaution: true,
    });
    expect(d.entryVeto).toBe(false);
  });

  it('excludes later closes, including at the exact as-of timestamp', () => {
    const d = score([
      make('2026-11-16T06:16:59Z', '-7'),
      make('2026-11-16T06:17:00Z', '-7'),
      make('2026-11-16T06:17:01Z', '-7'),
      make('2026-10-01T01:00:00Z', '-7'),
    ], AS_OF);
    expect(d.historyClosedTrades).toBe(1);
    expect(d.consecutiveNetLosses).toBe(1);
  });

  it('fails to unknown when an earlier broker fee or risk was unpriced', () => {
    const d = score([
      make('2026-11-15T10:00:00Z', '-10'),
      make('2026-11-15T11:00:00Z', null),
      make('2026-11-15T12:00:00Z', '-10', null),
    ], AS_OF);
    expect(d).toMatchObject({
      historyClosedTrades: 3,
      pricedTrades: 1,
      state: 'UNKNOWN',
      reason: 'INCOMPLETE_PRIOR_BROKER_FEES_OR_RISK',
      consecutiveNetLosses: null,
      threeLossStreakCaution: null,
    });
  });

  it('does not fake a favorable edge from one trading day', () => {
    const rows = Array.from({length: 12}, (_, i) => make(
      new Date(Date.UTC(2026, 10, 15, i)).toISOString(), '100',
    ));
    expect(score(rows, AS_OF).state).toBe('UNKNOWN');
    expect(score(rows, AS_OF).distinctClosingDays).toBe(1);
  });

  it('identifies a neutral historical sample without claiming a winning model', () => {
    const rows = Array.from({length: 12}, (_, i) => make(
      new Date(Date.UTC(2026, 10, 10 + Math.floor(i / 4), i % 4)).toISOString(),
      i % 2 === 0 ? '20' : '-40',
    ));
    const d = score(rows, AS_OF);
    expect(d.state).toBe('EDGE_NOT_ESTABLISHED');
    expect(d.entryVeto).toBe(false);
    expect(d.modifiesExecution).toBe(false);
  });

  it('preserves an invalid evaluation timestamp as unknown', () => {
    const d = score([], new Date('invalid'));
    expect(d.reason).toBe('INVALID_EVALUATION_TIME');
    expect(d.state).toBe('UNKNOWN');
  });
});
