import { DataSource } from 'typeorm';
import {
  evaluateTradeEntryPath,
  TradeEntryPathForensicsService,
  TRADE_ENTRY_PATH_FORENSICS_ARTIFACT,
} from './trade-entry-path-forensics.service';
import type { PostCloseQuoteCandle } from './post-close-path-forensics.service';

const openedAt = new Date('2026-11-10T07:17:44.000Z');
const closedAt = new Date('2026-11-10T07:35:04.000Z');
const baseMs = Date.parse('2026-11-10T07:18:00.000Z');

function bar(index: number, high = 157.98, low = 157.95, close = 157.96): PostCloseQuoteCandle {
  const at = baseMs + index * 60_000;
  return {
    bucket_time: new Date(at),
    high: high.toFixed(5),
    low: low.toFixed(5),
    close: close.toFixed(5),
    source: 'ctrader-broker-native',
    sample_count: 4,
    positive_quote_sample_count: 4,
    last_quote_sample_at: new Date(at + 51_000),
  };
}

function evaluate(
  candles: PostCloseQuoteCandle[],
  override: Partial<Parameters<typeof evaluateTradeEntryPath>[0]> = {},
) {
  return evaluateTradeEntryPath({
    instrument: 'USDJPY',
    direction: 'SELL',
    openedAt,
    closedAt,
    fillPrice: 157.953,
    stopLoss: 158.002,
    takeProfit: 157.872,
    horizonMinutes: 5,
    candles,
    ...override,
  });
}

describe('Trade entry-to-exit verified M1 forensic research', () => {
  it('identifies early adverse movement before favourable recovery without calling it execution-safe', () => {
    const candles = [
      bar(0, 157.99, 157.965, 157.98),
      bar(1, 157.97, 157.94, 157.945),
      bar(2, 157.96, 157.92, 157.925),
      bar(3, 157.99, 157.94, 157.98),
      bar(4, 157.96, 157.89, 157.9),
    ];
    const result = evaluate(candles);
    expect(result.state).toBe('OBSERVED_TO_HORIZON');
    expect(result.observedMinutes).toBe(5);
    expect(result.firstMovement).toBe('ADVERSE_FIRST');
    expect(result.firstAdverseMinute).toBe('2026-11-10T07:18:00.000Z');
    expect(result.firstFavorableMinute).toBe('2026-11-10T07:19:00.000Z');
    expect(result.maxAdversePips).toBe(3.7);
    expect(result.maxFavorablePips).toBe(6.3);
    expect(result.maxObservedCloseGivebackPips).toBe(5.5);
    expect(result.trace.map((row) => row.alignedClosePips)).toEqual([-2.7, 0.8, 2.8, -2.7, 5.3]);
  });

  it('does not mislabel an immediate losing trade as profit giveback', () => {
    const candles = Array.from({ length: 5 }, (_, i) =>
      bar(i, 158.0 + i * 0.005, 157.97 + i * 0.004, 157.99 + i * 0.004),
    );
    const result = evaluate(candles);
    expect(result.state).toBe('OBSERVED_TO_HORIZON');
    expect(result.firstMovement).toBe('ONE_SIDED');
    expect(result.firstFavorableMinute).toBeNull();
    expect(result.maxFavorablePips).toBe(0);
    expect(result.maxAdversePips).toBeGreaterThan(5);
    expect(result.maxObservedCloseGivebackPips).toBe(0);
  });

  it('marks same-minute first movement and stop+target crossing as ambiguous', () => {
    const candles = [
      bar(0, 158.01, 157.86, 157.95),
      ...Array.from({ length: 4 }, (_, i) => bar(i + 1)),
    ];
    const result = evaluate(candles);
    expect(result.state).toBe('OBSERVED_TO_HORIZON');
    expect(result.firstMovement).toBe('SAME_MINUTE_AMBIGUOUS');
    expect(result.firstStopQuoteTouchMinute).toBe('2026-11-10T07:18:00.000Z');
    expect(result.firstTargetQuoteTouchMinute).toBe('2026-11-10T07:18:00.000Z');
    expect(result.trace[0].bothBarriersTouched).toBe(true);
  });

  it('uses completed bars before close, never the partial exit minute or later market', () => {
    const close = new Date('2026-11-10T07:20:12.000Z');
    const result = evaluate([bar(0), bar(1), bar(2, 158.6, 157.2, 157.3)], {
      closedAt: close,
      horizonMinutes: 15,
    });
    expect(result).toMatchObject({
      state: 'OBSERVED_TO_CLOSE',
      observedMinutes: 2,
      firstMissingMinute: null,
      fullMinuteWindowEndsAt: '2026-11-10T07:20:00.000Z',
    });
    expect(result.trace.at(-1)?.at).toBe('2026-11-10T07:19:00.000Z');
  });

  it('fails to insufficient evidence on missing or untrusted broker M1 data', () => {
    const candles = Array.from({ length: 5 }, (_, i) => bar(i));
    expect(evaluate(candles.filter((_, i) => i !== 1))).toMatchObject({
      state: 'DATA_GAP',
      firstMissingMinute: '2026-11-10T07:19:00.000Z',
      observedMinutes: 1,
    });
    expect(
      evaluate([{ ...bar(0), source: 'historical-backfill' }, ...candles.slice(1)]).state,
    ).toBe('DATA_GAP');
    expect(
      evaluate([{ ...bar(0), low: null as unknown as string }, ...candles.slice(1)]).state,
    ).toBe('DATA_GAP');
    expect(
      evaluate([{ ...bar(0), positive_quote_sample_count: 0 }, ...candles.slice(1)]).state,
    ).toBe('DATA_GAP');
  });

  it('declares no full minute when a position closes within the entry minute', () => {
    const result = evaluate([], { closedAt: new Date('2026-11-10T07:17:58Z') });
    expect(result.state).toBe('NO_COMPLETE_M1');
    expect(result.observedMinutes).toBe(0);
  });

  it('rejects reversed stops or invalid risk and separates four-decimal pip units', () => {
    expect(evaluate([], { stopLoss: 157.9 }).state).toBe('INVALID_GEOMETRY');
    expect(evaluate([], { fillPrice: 0 }).state).toBe('INVALID_GEOMETRY');
    const firstBar = bar(0, 1.3425, 1.3421, 1.3424);
    const us = evaluate([firstBar], {
      instrument: 'GBPUSD',
      fillPrice: 1.3423,
      stopLoss: 1.3429,
      takeProfit: 1.3415,
      closedAt: new Date('2026-11-10T07:19:30Z'),
    });
    expect(us.state).toBe('OBSERVED_TO_CLOSE');
    expect(us.maxAdversePips).toBe(2);
    expect(us.maxFavorablePips).toBe(2);
  });

  it('writes per-horizon feature and minute-trace research with no trading authority', async () => {
    const trade = {
      trade_id: 'trade-123',
      trade_intent_id: 'intent-123',
      user_id: 'user-123',
      broker_connection_id: 'broker-123',
      instrument: 'USDJPY',
      account_currency: 'USD',
      direction: 'SELL',
      opened_at: openedAt,
      closed_at: closedAt,
      fill_price: '157.95300000',
      requested_entry_price: '157.95000000',
      stop_loss: '158.00200000',
      take_profit: '157.87200000',
      exit_price: '158.00200000',
      realised_pnl: '-124.05',
      commission: '-24.00',
      swap: '0',
      close_reason: 'BROKER_CLOSE',
      lot_size: '4.0000',
      timeframe: 'M1',
      route: 'EARLY_TRANSITION',
      pretrade_features: { confidenceScore: 0.72, featureRsi14: 43.9 },
    };
    const query = jest.fn().mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes('FROM trading.trades t')) return [trade];
      if (sql.includes('FROM market_data.provider_quote_candles')) {
        const start = new Date(args[2] as string).getTime();
        const end = new Date(args[3] as string).getTime();
        const count = Math.floor((end - start) / 60_000);
        return Array.from({ length: count }, (_, i) => {
          const at = start + i * 60_000;
          return {
            ...bar(i),
            bucket_time: new Date(at),
            last_quote_sample_at: new Date(at + 51_000),
          };
        });
      }
      if (sql.includes('INSERT INTO trading.post_entry_shadow_observations')) return [];
      throw new Error('Unexpected query');
    });
    const service = new TradeEntryPathForensicsService({ query } as unknown as DataSource);
    await service.runOnce(new Date('2026-11-10T15:00:00Z'));

    const inserts = query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO trading.post_entry_shadow_observations'),
    );
    expect(inserts).toHaveLength(3);
    expect(inserts.map(([, args]) => args[5])).toEqual([5, 15, 60]);
    for (const [sql, args] of inserts) {
      expect(sql).toContain("'NONE',false");
      expect(sql).toContain('ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING');
      expect(args[4]).toBe(TRADE_ENTRY_PATH_FORENSICS_ARTIFACT);
      const response = JSON.parse(args[10] as string);
      expect(response.modelTrainingStatus).toBe('RESEARCH_ONLY_NOT_TRAINED');
      expect(response.execution_authority).toBe('NONE');
      expect(response.modifies_execution).toBe(false);
      expect(response.originalStrategyTimeframe).toBe('M1');
      expect(response.pretradeFeatures).toMatchObject({ confidenceScore: 0.72 });
      expect(response.trace.length).toBe(response.observedMinutes);
      expect(response.firstMissingMinute).toBeNull();
    }
    const res = inserts.map(([, args]) => JSON.parse(args[10] as string));
    expect(res.map((r) => r.state)).toEqual([
      'OBSERVED_TO_HORIZON',
      'OBSERVED_TO_HORIZON',
      'OBSERVED_TO_CLOSE',
    ]);
    expect(res.map((r) => r.observedMinutes)).toEqual([5, 15, 17]);
    // The 60-minute research window is cut short by the broker close,
    // so its checkpoint timestamp must not claim the trade stayed open.
    expect(new Date(inserts[2][1][6] as string).getTime()).toBe(closedAt.getTime());
    expect(
      query.mock.calls.every(
        ([sql]) =>
          !/\bUPDATE\s+trading\.trades|\bDELETE\s+FROM\s+trading\.trades|\bcloseTrade\s*\(/i.test(
            String(sql),
          ),
      ),
    ).toBe(true);
  });
});
