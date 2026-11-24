import { DataSource } from 'typeorm';
import {
  composeAsOfNativeM5FromFiveM1,
  type CompletedProfitExitCandle,
} from './candle-aware-profit-patience-shadow';
import { LiveDemoProfitProtectionService } from './live-demo-profit-protection.service';

const decision = new Date('2026-11-23T12:15:10.000Z');
const candle = (
  minute: number,
  overrides: Partial<CompletedProfitExitCandle> = {},
): CompletedProfitExitCandle => ({
  startedAt: new Date(`2026-11-23T12:${String(minute).padStart(2, '0')}:00.000Z`),
  timeframeMinutes: 1,
  open: 159.09 - (minute - 10) * 0.009,
  high: 159.095 - (minute - 10) * 0.009,
  low: 159.079 - (minute - 10) * 0.009,
  close: 159.082 - (minute - 10) * 0.009,
  brokerNativeSampleCount: 220,
  ...overrides,
});
const rows = [10, 11, 12, 13, 14].map((x) => candle(x));
const asDb = (b: CompletedProfitExitCandle) => ({
  bucket_time: b.startedAt,
  open: String(b.open),
  high: String(b.high),
  low: String(b.low),
  close: String(b.close),
  sample_count: b.brokerNativeSampleCount,
});

function loader(m1: CompletedProfitExitCandle[], m5: CompletedProfitExitCandle | null) {
  const query = jest.fn(async (_sql: string, params: unknown[]) =>
    params[2] === 'M1' ? m1.map(asDb).reverse() : m5 ? [asDb(m5)] : [],
  );
  const service = new LiveDemoProfitProtectionService(
    { query } as unknown as DataSource,
    {} as any,
    {} as any,
  ) as unknown as {
    loadAsOfBrokerNativeProfitExitCandles: (
      trade: unknown,
      at: Date,
    ) => Promise<{
      m1: CompletedProfitExitCandle[];
      m5: CompletedProfitExitCandle | null;
    }>;
  };
  const trade = { broker_connection_id: 'owner-demo', instrument: 'USDJPY' };
  return { query, run: () => service.loadAsOfBrokerNativeProfitExitCandles(trade, decision) };
}

describe('M5 from five immutable-at-decision broker-native M1 bars', () => {
  it('combines exactly the last completed five UTC-aligned native M1 into M5', () => {
    const out = composeAsOfNativeM5FromFiveM1(decision, rows);
    expect(out).toMatchObject({
      startedAt: new Date('2026-11-23T12:10:00.000Z'),
      timeframeMinutes: 5,
      open: rows[0]!.open,
      close: rows[4]!.close,
      high: Math.max(...rows.map((x) => x.high)),
      low: Math.min(...rows.map((x) => x.low)),
      brokerNativeSampleCount: 1100,
      provenance: 'COMPOSED_FROM_BROKER_NATIVE_M1',
    });
  });
  it('never accepts an incomplete M1, missing minute, duplicate, empty source, invalid OHLC', () => {
    expect(composeAsOfNativeM5FromFiveM1(decision, rows.slice(1))).toBeNull();
    expect(composeAsOfNativeM5FromFiveM1(decision, [...rows.slice(0, 3), rows[4]!])).toBeNull();
    expect(composeAsOfNativeM5FromFiveM1(decision, [...rows, rows[4]!])).toBeNull();
    expect(
      composeAsOfNativeM5FromFiveM1(
        decision,
        rows.map((b, i) => (i === 3 ? { ...b, brokerNativeSampleCount: 0 } : b)),
      ),
    ).toBeNull();
    expect(
      composeAsOfNativeM5FromFiveM1(
        decision,
        rows.map((b, i) => (i === 2 ? { ...b, high: b.open - 0.01 } : b)),
      ),
    ).toBeNull();
    expect(
      composeAsOfNativeM5FromFiveM1(
        decision,
        rows.map((b, i) => (i === 2 ? { ...b, timeframeMinutes: 5 } : b)),
      ),
    ).toBeNull();
  });
  it('rejects a still-forming final minute at 12:14:30 and an invalid timestamp', () => {
    expect(composeAsOfNativeM5FromFiveM1(new Date('2026-11-23T12:14:30Z'), rows)).toBeNull();
    expect(composeAsOfNativeM5FromFiveM1(new Date(NaN), rows)).toBeNull();
  });
  it('does not blend M1 from a previous UTC M5 bucket', () => {
    expect(composeAsOfNativeM5FromFiveM1(decision, [candle(9), ...rows.slice(1)])).toBeNull();
  });
  it('selects composed native M5 only if canonical M5 is not yet materialized', async () => {
    const h = loader(rows, null);
    const out = await h.run();
    expect(out.m1).toHaveLength(2);
    expect(out.m1.map((x) => x.startedAt.toISOString().slice(11, 16))).toEqual(['12:13', '12:14']);
    expect(out.m5?.provenance).toBe('COMPOSED_FROM_BROKER_NATIVE_M1');
    const m1Args = h.query.mock.calls.find((x) => x[1]?.[2] === 'M1')?.[1];
    expect(m1Args?.[4]).toBe(10);
    expect(
      h.query.mock.calls.every(
        (c) =>
          String(c[0]).includes('AND created_at <= $4::timestamptz') &&
          String(c[0]).includes('AND updated_at <= $4::timestamptz') &&
          String(c[0]).includes('AND last_sample_at <= $4::timestamptz'),
      ),
    ).toBe(true);
  });
  it('prefers exact, complete native M5 when present; does not mix sources', async () => {
    const native = {
      ...composeAsOfNativeM5FromFiveM1(decision, rows)!,
      close: 159.051,
      provenance: undefined,
    };
    const out = await loader(rows, native).run();
    expect(out.m5?.close).toBe(159.051);
    expect(out.m5?.provenance).toBe('STORED_BROKER_NATIVE_M5');
  });
  it('never treats a stale previous-window M5 as the just-completed M5', async () => {
    const older = {
      ...composeAsOfNativeM5FromFiveM1(decision, rows)!,
      startedAt: new Date('2026-11-23T12:05:00.000Z'),
    };
    expect((await loader([], older).run()).m5).toBeNull();
    expect((await loader(rows, older).run()).m5?.provenance).toBe('COMPOSED_FROM_BROKER_NATIVE_M1');
  });
});
