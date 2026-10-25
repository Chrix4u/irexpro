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
