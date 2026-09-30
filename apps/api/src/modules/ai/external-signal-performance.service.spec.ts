import { DataSource } from 'typeorm';
import {
  EXTERNAL_PROVIDER_REVIEW_GATES,
  ExternalSignalPerformanceService,
} from './external-signal-performance.service';

function strongEvidenceRows() {
  const rows: any[] = [];
  const instruments = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];
  const start = Date.UTC(2026, 8, 1, 0, 0, 0);
  for (let i = 0; i < 120; i += 1) {
    const predictedBuy = i % 2 === 0;
    const losing = i % 10 === 0;
    const fill = 1.0;
    // 90% direction correctness with both UP and DOWN true classes.
    const actualUp = losing ? !predictedBuy : predictedBuy;
    const exit = actualUp ? 1.001 : 0.999;
    rows.push({
      signal_generated_at: new Date(start + i * 5 * 60_000),
      instrument: instruments[i % instruments.length],
      direction: predictedBuy ? 'BUY' : 'SELL',
      confidence_score: '0.72',
      trade_id: `trade-${i}`,
      trade_status: 'CLOSED',
      fill_price: String(fill),
      exit_price: String(exit),
      realised_pnl: losing ? '-5' : '10',
      closed_at: new Date(start + i * 5 * 60_000 + 60_000),
      allocated_capital: '1000',
    });
  }
  return rows;
}

describe('ExternalSignalPerformanceService', () => {
  it('keeps an empty provider fail-closed and PAPER-only', async () => {
    const dataSource = { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource;
    const service = new ExternalSignalPerformanceService(dataSource);
    const report = await service.getProviderPerformance(
      '00000000-0000-4000-8000-000000000001',
      'provider-a',
    );
    expect(report.executionAuthority).toBe('PAPER_ONLY');
    expect(report.demoReviewEligible).toBe(false);
    expect(report.automaticDemoPromotion).toBe(false);
    expect(report.automaticLivePromotion).toBe(false);
    expect(report.observed.closedTrades).toBe(0);
  });

  it('marks strong PAPER evidence eligible for DEMO review without auto-promoting it', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue(strongEvidenceRows()),
    } as unknown as DataSource;
    const service = new ExternalSignalPerformanceService(dataSource);
    const report = await service.getProviderPerformance(
      '00000000-0000-4000-8000-000000000001',
      'provider-a',
    );

    expect(report.observed.closedTrades).toBe(120);
    expect(report.observed.balancedAccuracy).toBeGreaterThanOrEqual(
      EXTERNAL_PROVIDER_REVIEW_GATES.minBalancedAccuracy,
    );
    expect(report.observed.profitFactor).toBeGreaterThanOrEqual(
      EXTERNAL_PROVIDER_REVIEW_GATES.minProfitFactor,
    );
    expect(report.demoReviewEligible).toBe(true);
    expect(report.certificationStatus).toBe('ELIGIBLE_FOR_DEMO_REVIEW');
    expect(report.automaticDemoPromotion).toBe(false);
    expect(report.automaticLivePromotion).toBe(false);
  });

  it('scopes the SQL query to the exact user and provider code', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ExternalSignalPerformanceService({ query } as unknown as DataSource);
    await service.getProviderPerformance('user-1', 'provider-b');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('external_provider_code'), [
      'user-1',
      'provider-b',
    ]);
  });
});
