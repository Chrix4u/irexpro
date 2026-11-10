import { DataSource } from 'typeorm';
import {
  evaluatePostClosePath,
  PostClosePathForensicsService,
  POST_CLOSE_PATH_FORENSICS_ARTIFACT,
  type PostCloseQuoteCandle,
} from './post-close-path-forensics.service';

const closedAt = new Date('2026-11-10T02:38:28.223Z');
const startMs = Date.parse('2026-11-10T02:39:00.000Z');

function minute(index: number, high = 158.08, low = 158.05, close = 158.065): PostCloseQuoteCandle {
  const at = new Date(startMs + index * 60_000);
  return {
    bucket_time: at,
    high: high.toFixed(5),
    low: low.toFixed(5),
    close: close.toFixed(5),
    sample_count: 5,
    positive_quote_sample_count: 5,
    last_quote_sample_at: new Date(at.getTime() + 55_000),
    source: 'ctrader-broker-native',
  };
}

const sell = (candles: PostCloseQuoteCandle[]) =>
  evaluatePostClosePath({
    closedAt,
    instrument: 'USDJPY',
    direction: 'SELL',
    entryPrice: 158.053,
    stopLoss: 158.102,
    takeProfit: 157.972,
    horizonMinutes: 15,
    candles,
  });

describe('post-close direction/stop timing, read-only quote research', () => {
  it('recognises a later SELL target without claiming the stopped trade would have survived', () => {
    const candles = Array.from({ length: 15 }, (_, i) => minute(i));
    candles[0] = minute(0, 158.11, 158.06, 158.07);
    candles[2] = minute(2, 158.08, 157.96, 157.98);
    const result = sell(candles);
    expect(result).toMatchObject({
      state: 'TARGET_REACHED',
      firstTargetMinute: '2026-11-10T02:41:00.000Z',
      observedMinutesBeforeDecision: 3,
      adverseBeyondOriginalStopPipsBeforeTarget: 0.8,
      targetMinuteSequenceUnknown: true,
    });
    expect(result.minutesFromCloseToTarget).toBeCloseTo(2.5, 1);
  });

  it('does not call a target touch verified when an earlier minute of quote history is missing', () => {
    const candles = Array.from({ length: 15 }, (_, i) => minute(i));
    candles[2] = minute(2, 158.08, 157.96, 157.98);
    expect(sell(candles.filter((_, i) => i !== 1))).toMatchObject({
      state: 'DATA_GAP',
      firstTargetMinute: null,
      firstMissingMinute: '2026-11-10T02:40:00.000Z',
      observedMinutesBeforeDecision: 1,
    });
    candles[1] = { ...minute(1), source: 'synthetic-backfill' };
    expect(sell(candles).state).toBe('DATA_GAP');
  });

  it('does not infer target success from a full uninterrupted interval without target', () => {
    const result = sell(Array.from({ length: 15 }, (_, i) => minute(i)));
    expect(result).toMatchObject({
      state: 'TARGET_NOT_REACHED',
      observedMinutesBeforeDecision: 15,
      firstTargetMinute: null,
      targetMinuteSequenceUnknown: false,
    });
  });

  it('handles BUY and JPY stop geometry without assuming a SELL recovery', () => {
    const candles = Array.from({ length: 15 }, (_, i) => minute(i, 158.1, 157.99, 158.05));
    candles[3] = minute(3, 158.16, 158.02, 158.13);
    const result = evaluatePostClosePath({
      closedAt,
      instrument: 'USDJPY',
      direction: 'BUY',
      entryPrice: 158.053,
      stopLoss: 158.011,
      takeProfit: 158.141,
      horizonMinutes: 15,
      candles,
    });
    expect(result.state).toBe('TARGET_REACHED');
    expect(result.adverseBeyondOriginalStopPipsBeforeTarget).toBe(2.1);
  });

  it('fails closed on invalid original geometry or untrusted quote samples', () => {
    const candles = Array.from({ length: 15 }, (_, i) => minute(i));
    expect(
      evaluatePostClosePath({
        closedAt,
        instrument: 'USDJPY',
        direction: 'SELL',
        entryPrice: 158.053,
        stopLoss: 157.99,
        takeProfit: 157.972,
        horizonMinutes: 15,
        candles,
      }).state,
    ).toBe('INVALID_GEOMETRY');
    candles[0] = { ...minute(0), last_quote_sample_at: new Date(startMs + 62_000) };
    expect(sell(candles).state).toBe('DATA_GAP');
    candles[0] = { ...minute(0), positive_quote_sample_count: 0 };
    expect(sell(candles).state).toBe('DATA_GAP');
    candles[0] = {
      ...minute(0),
      high: null as unknown as string,
      low: null as unknown as string,
      close: null as unknown as string,
    };
    expect(sell(candles).state).toBe('DATA_GAP');
  });

  it('persists one no-authority research artifact for each matured horizon without a broker write', async () => {
    const trade = {
      trade_id: 'trade-123',
      trade_intent_id: 'intent-123',
      user_id: 'user-123',
      broker_connection_id: 'broker-123',
      instrument: 'USDJPY',
      account_currency: 'USD',
      direction: 'SELL',
      closed_at: closedAt,
      opened_at: new Date('2026-11-10T01:58:22Z'),
      fill_price: '158.053',
      requested_entry_price: '158.052',
      stop_loss: '158.102',
      take_profit: '157.972',
      exit_price: '158.099',
      close_reason: 'BROKER_CLOSE',
      realised_pnl: '-116.38',
      commission: '-24',
      swap: '0',
      entry_timeframe: 'M1',
      strategy_route: 'CONFIRMED_REVERSAL',
    };
    const query = jest.fn().mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes('FROM trading.trades t')) return [trade];
      if (sql.includes('FROM market_data.provider_quote_candles')) {
        const start = new Date(args[2] as string).getTime();
        const end = new Date(args[3] as string).getTime();
        const count = Math.round((end - start) / 60_000);
        return Array.from({ length: count }, (_, i) => minute(i));
      }
      if (sql.includes('INSERT INTO trading.post_entry_shadow_observations')) return [];
      throw new Error('Unexpected database query');
    });
    const svc = new PostClosePathForensicsService({ query } as unknown as DataSource);
    await svc.runOnce(new Date('2026-11-10T08:00:00.000Z'));
    const inserts = query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO trading.post_entry_shadow_observations'),
    );
    expect(inserts).toHaveLength(3);
    expect(inserts.map(([, args]) => args[5])).toEqual([15, 60, 240]);
    for (const [sql, args] of inserts) {
      expect(sql).toContain("'NONE',false");
      expect(sql).toContain('ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING');
      expect(args[4]).toBe(POST_CLOSE_PATH_FORENSICS_ARTIFACT);
      const payload = JSON.parse(args[10] as string);
      expect(payload.execution_authority).toBe('NONE');
      expect(payload.modifies_execution).toBe(false);
      expect(payload.modelTrainingStatus).toBe('RESEARCH_ONLY_NOT_TRAINED');
      expect(payload.stopDistancePips).toBe(4.9);
      expect(payload.requestedEntryStopDistancePips).toBe(5);
      expect(payload.actualFillVersusRequestedPips).toBe(0.1);
      expect(payload.holdMinutes).toBeGreaterThan(0);
    }
    expect(
      query.mock.calls.some(([sql]) =>
        /\bUPDATE\s+trading\.trades|\bDELETE\s+FROM\s+trading\.trades|\bcloseTrade\s*\(/i.test(
          String(sql),
        ),
      ),
    ).toBe(false);
  });
});
