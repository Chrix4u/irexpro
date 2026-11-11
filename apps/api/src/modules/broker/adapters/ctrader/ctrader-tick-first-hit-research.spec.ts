import {
  decodeCtraderHistoricalTickSide,
  evaluateCtraderTickFirstHitResearch,
  validateCtraderResearchTickWindow,
} from './ctrader-tick-first-hit-research';

const FROM = Date.parse('2026-11-11T11:00:00.000Z');
const TO = FROM + 11 * 60_000;

describe('Spotware native tick first-touch research — NEVER broker authority', () => {
  it('decodes newest-first absolute timestamp then relative time deltas without reordering', () => {
    const ticks = decodeCtraderHistoricalTickSide(
      {
        hasMore: false,
        tickData: [
          { timestamp: FROM + 30_000, tick: 158_923_00 },
          { timestamp: -10_000, tick: -300 },
          { timestamp: -20_000, tick: -200 },
        ],
      },
      FROM,
      TO,
    );
    expect(ticks).toEqual([
      { atMs: FROM, price: 158.918 },
      { atMs: FROM + 20_000, price: 158.92 },
      { atMs: FROM + 30_000, price: 158.923 },
    ]);
  });

  it('reconstructs observed signed time AND price deltas from Pepperstone native ticks', () => {
    const ticks = decodeCtraderHistoricalTickSide(
      {
        hasMore: false,
        tickData: [
          { timestamp: FROM + 30_000, tick: 15_931_100 },
          { timestamp: -570, tick: 200 },
          { timestamp: -1_080, tick: 200 },
          { timestamp: -225, tick: -200 },
        ],
      },
      FROM,
      TO,
    );
    expect(ticks).toEqual([
      { atMs: FROM + 28_125, price: 159.313 },
      { atMs: FROM + 28_350, price: 159.315 },
      { atMs: FROM + 29_430, price: 159.313 },
      { atMs: FROM + 30_000, price: 159.311 },
    ]);
  });

  it('rejects forward relative timestamps and negative reconstructed prices', () => {
    expect(() =>
      decodeCtraderHistoricalTickSide(
        {
          hasMore: false,
          tickData: [
            { timestamp: FROM + 30_000, tick: 100_000 },
            { timestamp: +100, tick: 100 },
          ],
        },
        FROM,
        TO,
      ),
    ).toThrow('INVALID_CTRADER_RELATIVE_TIME');
    expect(() =>
      decodeCtraderHistoricalTickSide(
        {
          hasMore: false,
          tickData: [
            { timestamp: FROM + 30_000, tick: 100_000 },
            { timestamp: -100, tick: -200_000 },
          ],
        },
        FROM,
        TO,
      ),
    ).toThrow('INVALID_CTRADER_TICK_PRICE');
  });

  it('refuses paginated/incomplete tick data, not silently confirming a target', () => {
    expect(() =>
      decodeCtraderHistoricalTickSide(
        {
          hasMore: true,
          tickData: [{ timestamp: FROM + 10, tick: 120000 }],
        },
        FROM,
        TO,
      ),
    ).toThrow('INCOMPLETE_CTRADER_TICK_HISTORY_PAGE');
    expect(() =>
      decodeCtraderHistoricalTickSide(
        {
          hasMore: undefined,
          tickData: [{ timestamp: FROM + 10, tick: 120000 }],
        },
        FROM,
        TO,
      ),
    ).toThrow('INCOMPLETE_CTRADER_TICK_HISTORY_PAGE');
  });

  it('rejects malformed, future, out-of-window and long broker requests', () => {
    expect(() => validateCtraderResearchTickWindow(FROM, FROM + 13 * 60_000)).toThrow(
      'INVALID_BOUNDED_HISTORICAL_TICK_WINDOW',
    );
    expect(() =>
      decodeCtraderHistoricalTickSide(
        {
          hasMore: false,
          tickData: [
            { timestamp: FROM + 1_000, tick: 120000 },
            { timestamp: -2_000, tick: -10 },
          ],
        },
        FROM,
        TO,
      ),
    ).toThrow('CTRADER_TICK_OUTSIDE_REQUEST_WINDOW');
    expect(() =>
      decodeCtraderHistoricalTickSide(
        {
          hasMore: false,
          tickData: [{ timestamp: FROM + 1_000, tick: '99999999999999999' }],
        },
        FROM,
        TO,
      ),
    ).toThrow('INVALID_CTRADER_TICK_INTEGER');
  });

  const ticks = {
    bidTicks: [
      { atMs: FROM + 100, price: 1.1 },
      { atMs: FROM + 10_000, price: 1.1002 },
      { atMs: FROM + 20_000, price: 1.1005 },
      { atMs: FROM + 30_000, price: 1.0992 },
    ],
    askTicks: [
      { atMs: FROM + 200, price: 1.10008 },
      { atMs: FROM + 10_100, price: 1.10028 },
      { atMs: FROM + 20_100, price: 1.10058 },
      { atMs: FROM + 30_100, price: 1.09928 },
    ],
  } as const;

  it('never uses quotes observed before the persisted decision millisecond', () => {
    const r = evaluateCtraderTickFirstHitResearch({
      direction: 'BUY',
      decisionAtMs: FROM + 450,
      horizonMinutes: 1,
      stopLoss: 1.0995,
      takeProfit: 1.10045,
      bidTicks: [
        { atMs: FROM + 100, price: 1.1 },
        { atMs: FROM + 500, price: 1.1001 },
        { atMs: FROM + 1_000, price: 1.1006 },
      ],
      askTicks: [
        { atMs: FROM + 200, price: 1.10008 },
        { atMs: FROM + 600, price: 1.10018 },
        { atMs: FROM + 1_050, price: 1.10068 },
      ],
    });
    expect(r.entryAtMs).toBe(FROM + 600);
    expect(r.entryBid).toBe(1.1001);
    expect(r.entryAsk).toBe(1.10018);
    expect(r.outcome).toBe('TARGET_FIRST');
  });

  it('reports target first on BUY even if the original stop is subsequently touched', () => {
    const r = evaluateCtraderTickFirstHitResearch({
      ...ticks,
      direction: 'BUY',
      decisionAtMs: FROM,
      horizonMinutes: 1,
      stopLoss: 1.0995,
      takeProfit: 1.10045,
    });
    expect(r.outcome).toBe('TARGET_FIRST');
    expect(r.atMs).toBe(FROM + 20_000);
    expect(r.entryAsk).toBe(1.10008);
  });

  it('reports STOP before subsequent TARGET on BUY using BID only', () => {
    const r = evaluateCtraderTickFirstHitResearch({
      bidTicks: [
        ticks.bidTicks[0],
        { atMs: FROM + 9_000, price: 1.0993 },
        { atMs: FROM + 14_000, price: 1.1006 },
      ],
      askTicks: ticks.askTicks,
      direction: 'BUY',
      decisionAtMs: FROM,
      horizonMinutes: 1,
      stopLoss: 1.0995,
      takeProfit: 1.10045,
    });
    expect(r.outcome).toBe('STOP_FIRST');
  });

  it('SELL target/stop use ASK prices (not mid or BID)', () => {
    const r = evaluateCtraderTickFirstHitResearch({
      ...ticks,
      direction: 'SELL',
      decisionAtMs: FROM,
      horizonMinutes: 1,
      stopLoss: 1.1005,
      takeProfit: 1.0995,
    });
    expect(r.outcome).toBe('STOP_FIRST'); // ask 1.10058 precedes ask 1.09928
  });

  it('returns ambiguous rather than inventing order when both barriers hit at one millisecond', () => {
    const r = evaluateCtraderTickFirstHitResearch({
      bidTicks: [
        ticks.bidTicks[0],
        { atMs: FROM + 9_000, price: 1.0994 },
        { atMs: FROM + 9_000, price: 1.1006 },
      ],
      askTicks: ticks.askTicks,
      direction: 'BUY',
      decisionAtMs: FROM,
      horizonMinutes: 1,
      stopLoss: 1.0995,
      takeProfit: 1.10045,
    });
    expect(r.outcome).toBe('AMBIGUOUS_SAME_MILLISECOND');
  });

  it('refuses to label a strategy if no real quote pair at entry or if bid/ask are crossed', () => {
    expect(
      evaluateCtraderTickFirstHitResearch({
        ...ticks,
        askTicks: [{ atMs: FROM + 6_000, price: 1.10008 }],
        direction: 'BUY',
        decisionAtMs: FROM,
        horizonMinutes: 1,
        stopLoss: 1.0995,
        takeProfit: 1.10045,
      }).outcome,
    ).toBe('INSUFFICIENT_TICK_EVIDENCE');
    expect(
      evaluateCtraderTickFirstHitResearch({
        ...ticks,
        askTicks: [{ atMs: FROM + 150, price: 1.0999 }],
        direction: 'BUY',
        decisionAtMs: FROM,
        horizonMinutes: 1,
        stopLoss: 1.0995,
        takeProfit: 1.10045,
      }).outcome,
    ).toBe('INSUFFICIENT_TICK_EVIDENCE');
  });

  it('requires both quote sides at expiry before declaring NEITHER_WITHIN_HORIZON', () => {
    const common = {
      direction: 'BUY' as const,
      decisionAtMs: FROM,
      horizonMinutes: 1 as const,
      stopLoss: 1.099,
      takeProfit: 1.101,
    };
    const initial = {
      bidTicks: [
        { atMs: FROM + 100, price: 1.1 },
        { atMs: FROM + 5_000, price: 1.1001 },
      ],
      askTicks: [
        { atMs: FROM + 200, price: 1.10008 },
        { atMs: FROM + 5_100, price: 1.10018 },
      ],
    };
    expect(evaluateCtraderTickFirstHitResearch({ ...common, ...initial }).outcome).toBe(
      'INSUFFICIENT_TICK_EVIDENCE',
    );
    const complete = {
      bidTicks: [...initial.bidTicks, { atMs: FROM + 60_700, price: 1.1002 }],
      askTicks: [...initial.askTicks, { atMs: FROM + 60_800, price: 1.10028 }],
    };
    expect(evaluateCtraderTickFirstHitResearch({ ...common, ...complete }).outcome).toBe(
      'NEITHER_WITHIN_HORIZON',
    );
    expect(
      evaluateCtraderTickFirstHitResearch({
        ...common,
        bidTicks: complete.bidTicks,
        askTicks: initial.askTicks,
      }).outcome,
    ).toBe('INSUFFICIENT_TICK_EVIDENCE');
    const stale = {
      bidTicks: [...initial.bidTicks, { atMs: FROM + 66_000, price: 1.1002 }],
      askTicks: [...initial.askTicks, { atMs: FROM + 66_100, price: 1.10028 }],
    };
    expect(evaluateCtraderTickFirstHitResearch({ ...common, ...stale }).outcome).toBe(
      'INSUFFICIENT_TICK_EVIDENCE',
    );
  });

  it('detects an immediate spread-triggered stop at hypothetical entry', () => {
    const buy = evaluateCtraderTickFirstHitResearch({
      direction: 'BUY',
      decisionAtMs: FROM,
      horizonMinutes: 1,
      stopLoss: 1.10003,
      takeProfit: 1.1009,
      bidTicks: [{ atMs: FROM + 100, price: 1.1 }],
      askTicks: [{ atMs: FROM + 200, price: 1.1001 }],
    });
    expect(buy.outcome).toBe('STOP_FIRST');
    expect(buy.atMs).toBe(FROM + 200);
    const sell = evaluateCtraderTickFirstHitResearch({
      direction: 'SELL',
      decisionAtMs: FROM,
      horizonMinutes: 1,
      stopLoss: 1.10005,
      takeProfit: 1.099,
      bidTicks: [{ atMs: FROM + 100, price: 1.1 }],
      askTicks: [{ atMs: FROM + 200, price: 1.1001 }],
    });
    expect(sell.outcome).toBe('STOP_FIRST');
    expect(sell.atMs).toBe(FROM + 200);
  });

  it('does not infer a win from insufficient ticks or intrabar candle high/low', () => {
    const r = evaluateCtraderTickFirstHitResearch({
      bidTicks: ticks.bidTicks.slice(0, 1),
      askTicks: ticks.askTicks.slice(0, 1),
      direction: 'BUY',
      decisionAtMs: FROM,
      horizonMinutes: 10,
      stopLoss: 1.0995,
      takeProfit: 1.10045,
    });
    expect(r.outcome).toBe('INSUFFICIENT_TICK_EVIDENCE');
  });
});
