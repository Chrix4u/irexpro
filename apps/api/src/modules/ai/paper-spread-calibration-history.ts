import type { DataSource } from 'typeorm';
import {
  classifyPaperSpreadSession,
  type PaperSpreadCalibrationHistory,
} from './paper-spread-calibration-shadow';

export async function loadPaperSpreadCalibrationHistory(
  dataSource: DataSource,
  sourceConnectionId: string,
  instrument: string,
  evaluatedAt: Date,
): Promise<PaperSpreadCalibrationHistory> {
  const session = classifyPaperSpreadSession(evaluatedAt);
  const rows = (await dataSource.query(
    `
      SELECT
        COUNT(*)::int AS sample_count,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY spread_close::double precision
        ) AS p95_spread_price,
        MAX(last_sample_at) AS latest_sample_at
      FROM market_data.provider_quote_candles
      WHERE connection_id = $1
        AND instrument = $2
        AND timeframe = 'M1'
        AND spread_close > 0
        AND last_sample_at > ($3::timestamptz - interval '21 days')
        AND last_sample_at <= $3::timestamptz
        AND CASE
          WHEN EXTRACT(HOUR FROM last_sample_at AT TIME ZONE 'UTC') >= 21 THEN 'ROLLOVER'
          WHEN EXTRACT(HOUR FROM last_sample_at AT TIME ZONE 'UTC') >= 13 THEN 'NEW_YORK'
          WHEN EXTRACT(HOUR FROM last_sample_at AT TIME ZONE 'UTC') >= 7 THEN 'LONDON'
          ELSE 'ASIA'
        END = $4
    `,
    [
      sourceConnectionId.trim(),
      instrument.trim().toUpperCase(),
      evaluatedAt.toISOString(),
      session,
    ],
  )) as Array<{
    sample_count: number | string | null;
    p95_spread_price: number | string | null;
    latest_sample_at?: string | Date | null;
  }>;

  const row = rows[0];
  const sampleCount = Math.max(0, Number(row?.sample_count ?? 0));
  const p95SpreadPrice = Number(row?.p95_spread_price ?? 0);
  return {
    sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0,
    p95SpreadPrice: Number.isFinite(p95SpreadPrice) && p95SpreadPrice > 0 ? p95SpreadPrice : 0,
  };
}
