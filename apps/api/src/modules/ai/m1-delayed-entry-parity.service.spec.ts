import { DataSource } from 'typeorm';
import { M1DelayedEntryParityService } from './m1-delayed-entry-parity.service';
import { DELAY_ENTRY_PARITY_SHADOW_ARTIFACT } from './m1-delayed-entry-parity-shadow';

const opened = new Date('2026-11-10T02:38:28.223Z');
const startMs = Date.parse('2026-11-10T02:39:00.000Z');
const trade = {
  id: 'trade-12',
  user_id: 'user-12',
  trade_intent_id: 'intent-12',
  broker_connection_id: 'connection-12',
  broker_id: 'pepperstone-ctrader',
  account_currency: 'USD',
  instrument: 'USDJPY',
  direction: 'SELL',
  opened_at: opened,
  closed_at: new Date('2026-11-10T02:48:28Z'),
  fill_price: '158.053',
  stop_loss: '158.102',
  take_profit: '157.972',
  exit_price: '158.099',
  realised_pnl: '-116.38',
  commission: '-24.00',
  swap: '0',
  lot_size: '4.0000',
  close_reason: 'BROKER_CLOSE',
  timeframe: 'M1',
  route: 'EARLY_TRANSITION',
  pretrade_features: { confidence: 0.72 },
};
const quote = (i: number) => {
  const at = startMs + i * 60000;
  const close = i === 0 ? 158.08 : i === 1 ? 158.07 : 158.06;
  return {
    bucket_time: new Date(at),
    open: close,
    high: close + 0.012,
    low: close - 0.012,
    close,
    source: 'ctrader-broker-native',
    sample_count: 10,
    positive_quote_sample_count: 10,
    first_sample_at: new Date(at + 500),
    last_quote_sample_at: new Date(at + 59000),
    spread_close: 0.002,
  };
};

describe('M1DelayedEntryParityService persistence / authority', () => {
  it('writes one research-only row for each fully matured horizon, with no broker writes', async () => {
    const query = jest.fn().mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes('FROM trading.trades t')) return [trade];
      if (sql.includes('FROM market_data.provider_quote_candles')) {
        expect(args[0]).toBe('connection-12');
        expect(args[1]).toBe('USDJPY');
        const start = new Date(args[2] as string).getTime();
        const end = new Date(args[3] as string).getTime();
        return Array.from({ length: (end - start) / 60000 }, (_, i) => quote(i));
      }
      if (sql.includes('INSERT INTO trading.post_entry_shadow_observations')) return [];
      throw new Error('Unexpected database action');
    });
    const service = new M1DelayedEntryParityService({ query } as unknown as DataSource);
    await service.runOnce(new Date('2026-11-10T10:00:00Z'));
    const selects = query.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM trading.trades t'),
    );
    expect(selects).toHaveLength(2);
    expect(selects.map(([, args]) => args[1])).toEqual([60, 240]);
    for (const [sql] of selects) {
      expect(sql).toContain("bc.account_type='DEMO'");
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('t.opened_at < $1::timestamptz');
    }
    const inserts = query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO trading.post_entry_shadow_observations'),
    );
    expect(inserts).toHaveLength(2);
    for (const [sql, args] of inserts) {
      expect(sql).toContain("'NONE',false");
      expect(sql).toContain('ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING');
      expect(args[4]).toBe(DELAY_ENTRY_PARITY_SHADOW_ARTIFACT);
      const result = JSON.parse(args[10] as string);
      expect(result.noTradeAuthority).toBe(true);
      expect(result.modifies_execution).toBe(false);
      expect(result.execution_authority).toBe('NONE');
      expect(result.modelTrainingStatus).toBe('RESEARCH_ONLY');
      expect(result.originalTimeframe).toBe('M1');
      expect(result.pretradeFeatures).toEqual({ confidence: 0.72 });
      expect(result.scenarios).toHaveLength(2);
      expect(result.scenarios[1].riskParityLotMultiplier).toBeCloseTo(1 / 1.4, 4);
    }
    expect(
      query.mock.calls.some(([sql]) =>
        /UPDATE\s+trading\.trades|DELETE\s+FROM\s+trading\.trades|closeTrade\(/i.test(String(sql)),
      ),
    ).toBe(false);
    service.onModuleDestroy();
  });

  it('does not retry a running pass simultaneously', async () => {
    let release: (() => void) | undefined;
    let first = true;
    const query = jest.fn().mockImplementation(() => {
      if (!first) return Promise.resolve([]);
      first = false;
      return new Promise((resolve) => {
        release = () => resolve([]);
      });
    });
    const service = new M1DelayedEntryParityService({ query } as unknown as DataSource);
    const one = service.runOnce(new Date('2026-11-10T10:00:00Z'));
    const two = service.runOnce(new Date('2026-11-10T10:00:00Z'));
    await two;
    expect(query).toHaveBeenCalledTimes(1);
    release?.();
    await one;
    service.onModuleDestroy();
  });
});
