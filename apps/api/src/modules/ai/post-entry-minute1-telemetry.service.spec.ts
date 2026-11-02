import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  PostEntryMinute1TelemetryService,
  minute1TelemetryDue,
  PLAN_B_V88_MINUTE1_TELEMETRY_ARTIFACT,
} from './post-entry-minute1-telemetry.service';

describe('PostEntryMinute1TelemetryService', () => {
  it('marks minute 1 due only after the causal checkpoint and only until captured', () => {
    const opened = new Date('2026-10-28T13:32:07.000Z');
    expect(minute1TelemetryDue(opened, new Date('2026-10-28T13:33:06.999Z'), false)).toBe(false);
    expect(minute1TelemetryDue(opened, new Date('2026-10-28T13:33:07.000Z'), false)).toBe(true);
    expect(minute1TelemetryDue(opened, new Date('2026-10-28T13:34:00.000Z'), true)).toBe(false);
    expect(
      minute1TelemetryDue(new Date('invalid'), new Date('2026-10-28T13:34:00.000Z'), false),
    ).toBe(false);
  });

  it('captures the latest fully closed broker-native M1 bucket at the minute-1 checkpoint with no execution authority', async () => {
    const now = new Date('2026-10-28T13:34:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          trade_id: '00000000-0000-0000-0000-000000000001',
          user_id: '00000000-0000-0000-0000-000000000002',
          trade_intent_id: '00000000-0000-0000-0000-000000000003',
          execution_broker_connection_id: '00000000-0000-0000-0000-000000000004',
          instrument: 'EURUSD',
          direction: 'SELL',
          entry_price: '1.11323000',
          stop_loss: '1.11378000',
          opened_at: '2026-10-28T13:32:07.000Z',
          closed_at: null,
          metadata: {
            confidenceScore: 0.63,
            feature_candidate_score: 0.59,
            feature_extension_atr: 0.18,
            feature_volatility_score: 0.07,
            feature_ema_separation: 0,
            feature_mtf_strength: 0,
            feature_rsi14: 50.7,
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          bucket_time: '2026-10-28T13:32:00.000Z',
          open: '1.1132400000',
          high: '1.1132600000',
          low: '1.1131800000',
          close: '1.1132000000',
          bid_close: '1.1131950000',
          ask_close: '1.1132050000',
          spread_close: '0.0000100000',
          sample_count: 116,
          source: 'ctrader-broker-native',
          first_sample_at: '2026-10-28T13:32:00.000Z',
          last_sample_at: '2026-10-28T13:32:59.000Z',
        },
        {
          bucket_time: '2026-10-28T13:31:00.000Z',
          open: '1.1133000000',
          high: '1.1133200000',
          low: '1.1132200000',
          close: '1.1132400000',
          bid_close: '1.1132350000',
          ask_close: '1.1132450000',
          spread_close: '0.0000100000',
          sample_count: 90,
          source: 'ctrader-broker-native',
          first_sample_at: '2026-10-28T13:31:00.000Z',
          last_sample_at: '2026-10-28T13:31:59.000Z',
        },
      ])
      .mockResolvedValueOnce([]);

    const dataSource = { query } as unknown as DataSource;
    const config = {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    } as unknown as ConfigService;
    const service = new PostEntryMinute1TelemetryService(config, dataSource);

    await service.runOnce(now);

    expect(query).toHaveBeenCalledTimes(4);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')",
    );
    expect(String(query.mock.calls[2]?.[0])).toContain("timeframe = 'M1'");
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "bucket_time + interval '1 minute' <= $3::timestamptz",
    );
    expect(String(query.mock.calls[3]?.[0])).toContain(
      'INSERT INTO trading.post_entry_shadow_observations',
    );
    expect(String(query.mock.calls[3]?.[0])).toContain("execution_authority = 'NONE'");
    const args = query.mock.calls[3]?.[1] as unknown[];
    expect(args).toContain(PLAN_B_V88_MINUTE1_TELEMETRY_ARTIFACT);
    expect(args).toContain(1);
    expect(args).toContain('READY');
    const response = JSON.parse(String(args.at(-1)));
    expect(response.execution_authority).toBe('NONE');
    expect(response.modifies_execution).toBe(false);
    expect(response.microstructure.latest.sample_count).toBe(116);
    expect(response.microstructure.latest.spread_close).toBe('0.0000100000');
    expect(response.current_r).toBeCloseTo((1.11323 - 1.1132) / (1.11378 - 1.11323), 8);
    expect(service.getStatus().lastCaptured).toBe(1);
  });

  it('keeps a missing minute-1 candle retryable rather than pretending evidence exists', async () => {
    const now = new Date('2026-10-28T13:34:00.000Z');
    const candidate = {
      trade_id: '00000000-0000-0000-0000-000000000001',
      user_id: '00000000-0000-0000-0000-000000000002',
      trade_intent_id: '00000000-0000-0000-0000-000000000003',
      execution_broker_connection_id: '00000000-0000-0000-0000-000000000004',
      instrument: 'EURUSD',
      direction: 'BUY',
      entry_price: '1.10000000',
      stop_loss: '1.09900000',
      opened_at: '2026-10-28T13:32:07.000Z',
      closed_at: null,
      metadata: {},
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new PostEntryMinute1TelemetryService(
      {
        get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      } as unknown as ConfigService,
      { query } as unknown as DataSource,
    );

    await service.runOnce(now);

    const args = query.mock.calls[3]?.[1] as unknown[];
    expect(args).toContain('WAITING_FOR_BROKER_DATA');
    expect(args).toContain('MINUTE1_BROKER_CANDLE_UNAVAILABLE');
    expect(service.getStatus().lastCaptured).toBe(0);
  });
});
