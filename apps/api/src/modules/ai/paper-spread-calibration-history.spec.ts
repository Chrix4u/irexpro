import type { DataSource } from 'typeorm';
import { loadPaperSpreadCalibrationHistory } from './paper-spread-calibration-history';

describe('loadPaperSpreadCalibrationHistory', () => {
  it('loads 21-day same-session P95 history for the broker expert source', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        sample_count: '640',
        p95_spread_price: '0.000021',
        latest_sample_at: '2026-10-15T14:29:00Z',
      },
    ]);
    const dataSource = { query } as unknown as DataSource;
    const evaluatedAt = new Date('2026-10-15T14:30:00Z');

    await expect(
      loadPaperSpreadCalibrationHistory(dataSource, 'broker-source', ' usdcad ', evaluatedAt),
    ).resolves.toEqual({ sampleCount: 640, p95SpreadPrice: 0.000021 });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual([
      'broker-source',
      'USDCAD',
      evaluatedAt.toISOString(),
      'NEW_YORK',
    ]);
    expect(String(query.mock.calls[0]![0])).toContain("interval '21 days'");
    expect(String(query.mock.calls[0]![0])).toContain('percentile_cont(0.95)');
  });

  it('normalizes missing or invalid aggregate values to fail-closed empty history', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sample_count: '-7', p95_spread_price: 'not-a-number' }]);
    const dataSource = { query } as unknown as DataSource;

    await expect(
      loadPaperSpreadCalibrationHistory(
        dataSource,
        'broker-source',
        'EURUSD',
        new Date('2026-10-15T08:00:00Z'),
      ),
    ).resolves.toEqual({ sampleCount: 0, p95SpreadPrice: 0 });
    await expect(
      loadPaperSpreadCalibrationHistory(
        dataSource,
        'broker-source',
        'EURUSD',
        new Date('2026-10-15T08:00:00Z'),
      ),
    ).resolves.toEqual({ sampleCount: 0, p95SpreadPrice: 0 });
  });
});
