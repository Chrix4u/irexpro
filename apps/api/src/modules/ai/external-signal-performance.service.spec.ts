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
      signal_generated_at: new Date(start + i * 5 * 60_000 + 7_000),
      market_data_bar_time: new Date(start + i * 5 * 60_000),
      intent_status: 'EXECUTED',
      instrument: instruments[i % instruments.length],
      direction: predictedBuy ? 'BUY' : 'SELL',
      confidence_score: '0.72',
      trade_id: `trade-${i}`,
      trade_status: 'CLOSED',
      fill_price: String(fill),
      exit_price: String(exit),
      realised_pnl: losing ? '-5' : '10',
      close_reason: losing ? 'STOP_LOSS_HIT' : 'TAKE_PROFIT_HIT',
      closed_at: new Date(start + i * 5 * 60_000 + 60_000),
      allocated_capital: '1000',
      broker_connection_id: '11111111-1111-4111-8111-111111111111',
      session_opening_balance: '10000',
      session_started_at: new Date(start - 60_000),
    });
  }
  return rows;
}

function strongEquitySnapshots() {
  const start = Date.UTC(2026, 8, 1, 0, 0, 0);
  return Array.from({ length: 121 }, (_, i) => ({
    connection_id: '11111111-1111-4111-8111-111111111111',
    equity: String(10000 + i * 5),
    accepted_at: new Date(start + i * 5 * 60_000),
  }));
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
    expect(report.strategyIdentity.evidenceIsolationApplied).toBe(true);
    expect(report.strategyIdentity.modelVersion).toBe(
      'external-provider/provider-a/paper-only-v1',
    );
    expect(report.demoReviewEligible).toBe(false);
    expect(report.automaticDemoPromotion).toBe(false);
    expect(report.automaticLivePromotion).toBe(false);
    expect(report.observed.closedTrades).toBe(0);
    expect(report.observed.latestSubmittedConfidence).toBeNull();
    expect(report.observed.latestSignalAt).toBeNull();
  });

  it('marks strong PAPER evidence eligible for DEMO review without auto-promoting it', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(
            sql.includes('broker.broker_account_snapshots')
              ? strongEquitySnapshots()
              : strongEvidenceRows(),
          ),
        ),
    } as unknown as DataSource;
    const service = new ExternalSignalPerformanceService(dataSource);
    const report = await service.getProviderPerformance(
      '00000000-0000-4000-8000-000000000001',
      'provider-a',
    );

    expect(report.observed.closedTrades).toBe(120);
    expect(report.observed.buySignals).toBe(60);
    expect(report.observed.sellSignals).toBe(60);
    expect(report.observed.buyExecutedTrades).toBe(60);
    expect(report.observed.sellExecutedTrades).toBe(60);
    expect(report.observed.rejectedSignals).toBe(0);
    expect(report.observed.strategyRealisedPnl).toBeCloseTo(1020, 10);
    expect(report.observed.latestSubmittedConfidence).toBeCloseTo(0.72, 10);
    expect(report.observed.latestSignalInstrument).toBe('USDCHF');
    expect(report.observed.latestSignalDirection).toBe('SELL');
    expect(report.observed.latestSignalAt).toBe(
      new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + 119 * 5 * 60_000 + 7_000).toISOString(),
    );
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
    expect(report.shadowCalibration.mode).toBe('DIAGNOSTIC_ONLY');
    expect(report.shadowCalibration.modifiesExecution).toBe(false);
    expect(report.shadowCalibration.resetsProviderEvidence).toBe(false);
    expect(report.shadowCalibration.closedTradesEvaluated).toBe(120);
    expect(report.shadowCalibration.confidenceBins.some((bin) => bin.count > 0)).toBe(true);
    expect(
      report.shadowCalibration.pairDirection.filter((row) => row.closedTrades > 0),
    ).toHaveLength(6);
  });

  it('uses conventional realised-P&L profit factor rather than margin-normalized PF', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const rows = [
      {
        signal_generated_at: start,
        instrument: 'EURUSD',
        direction: 'BUY',
        confidence_score: '0.70',
        trade_id: 'trade-win',
        trade_status: 'CLOSED',
        fill_price: '1.0',
        exit_price: '1.01',
        realised_pnl: '10',
        close_reason: 'TAKE_PROFIT_HIT',
        closed_at: new Date(start.getTime() + 60_000),
        allocated_capital: '100',
        broker_connection_id: '11111111-1111-4111-8111-111111111111',
        session_opening_balance: '10000',
        session_started_at: start,
      },
      {
        signal_generated_at: new Date(start.getTime() + 600_000),
        instrument: 'GBPUSD',
        direction: 'SELL',
        confidence_score: '0.70',
        trade_id: 'trade-loss',
        trade_status: 'CLOSED',
        fill_price: '1.0',
        exit_price: '1.01',
        realised_pnl: '-5',
        close_reason: 'STOP_LOSS_HIT',
        closed_at: new Date(start.getTime() + 660_000),
        allocated_capital: '1000',
        broker_connection_id: '11111111-1111-4111-8111-111111111111',
        session_opening_balance: '10000',
        session_started_at: start,
      },
    ];
    const snapshots = [
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        equity: '10000',
        accepted_at: start,
      },
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        equity: '9995',
        accepted_at: new Date(start.getTime() + 700_000),
      },
    ];
    const dataSource = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(sql.includes('broker.broker_account_snapshots') ? snapshots : rows),
        ),
    } as unknown as DataSource;
    const report = await new ExternalSignalPerformanceService(dataSource).getProviderPerformance(
      'user-1',
      'provider-a',
    );
    expect(report.observed.profitFactor).toBeCloseTo(2, 10);
  });

  it('measures drawdown from account equity snapshots, not compounded margin returns', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const rows = [
      {
        signal_generated_at: start,
        instrument: 'EURUSD',
        direction: 'BUY',
        confidence_score: '0.70',
        trade_id: 'trade-1',
        trade_status: 'CLOSED',
        fill_price: '1.0',
        exit_price: '0.99',
        realised_pnl: '-10',
        closed_at: new Date(start.getTime() + 60_000),
        allocated_capital: '10',
        broker_connection_id: '11111111-1111-4111-8111-111111111111',
        session_opening_balance: '10000',
        session_started_at: start,
      },
    ];
    const snapshots = [
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        equity: '10000',
        accepted_at: start,
      },
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        equity: '9900',
        accepted_at: new Date(start.getTime() + 30_000),
      },
    ];
    const dataSource = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(sql.includes('broker.broker_account_snapshots') ? snapshots : rows),
        ),
    } as unknown as DataSource;
    const report = await new ExternalSignalPerformanceService(dataSource).getProviderPerformance(
      'user-1',
      'provider-a',
    );
    expect(report.observed.maxDrawdown).toBeCloseTo(0.01, 10);
    expect(report.checks.maxDrawdown).toBe(true);
  });

  it('censors manual closes from qualification metrics and the 100-trade evidence count', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const rows = [
      {
        signal_generated_at: start,
        instrument: 'EURUSD',
        direction: 'BUY',
        confidence_score: '0.70',
        trade_id: 'trade-tp',
        trade_status: 'CLOSED',
        fill_price: '1.0',
        exit_price: '1.01',
        realised_pnl: '10',
        close_reason: 'TAKE_PROFIT_HIT',
        closed_at: new Date(start.getTime() + 60_000),
        allocated_capital: '100',
        broker_connection_id: '11111111-1111-4111-8111-111111111111',
        session_opening_balance: '10000',
        session_started_at: start,
      },
      {
        signal_generated_at: new Date(start.getTime() + 600_000),
        instrument: 'GBPUSD',
        direction: 'SELL',
        confidence_score: '0.70',
        trade_id: 'trade-manual',
        trade_status: 'CLOSED',
        fill_price: '1.0',
        exit_price: '0.99',
        realised_pnl: '1000',
        close_reason: 'MANUAL_CLOSE',
        closed_at: new Date(start.getTime() + 660_000),
        allocated_capital: '100',
        broker_connection_id: '11111111-1111-4111-8111-111111111111',
        session_opening_balance: '10000',
        session_started_at: start,
      },
    ];
    const snapshots = [
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        equity: '10000',
        accepted_at: start,
      },
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        equity: '10010',
        accepted_at: new Date(start.getTime() + 700_000),
      },
    ];
    const dataSource = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(sql.includes('broker.broker_account_snapshots') ? snapshots : rows),
        ),
    } as unknown as DataSource;
    const report = await new ExternalSignalPerformanceService(dataSource).getProviderPerformance(
      'user-1',
      'provider-a',
    );
    expect(report.observed.closedTrades).toBe(1);
    expect(report.observed.interruptedClosedTrades).toBe(1);
    expect(report.observed.totalNormalizedReturn).toBeCloseTo(0.001, 10);
    expect(report.checks.evidence).toBe(false);
  });

  it('measures signal cadence from market-data bar time instead of scheduler processing jitter', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const rows = [0, 1, 2].map((i) => ({
      signal_generated_at: new Date(start.getTime() + i * 10 * 60_000 + (i + 1) * 7_000),
      market_data_bar_time: new Date(start.getTime() + i * 10 * 60_000),
      intent_status: 'REJECTED',
      instrument: 'EURUSD',
      direction: 'SELL',
      confidence_score: '0.70',
      trade_id: null,
      trade_status: null,
      fill_price: null,
      exit_price: null,
      realised_pnl: null,
      close_reason: null,
      closed_at: null,
      allocated_capital: null,
      broker_connection_id: '11111111-1111-4111-8111-111111111111',
      session_opening_balance: '10000',
      session_started_at: start,
    }));
    const dataSource = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(sql.includes('broker.broker_account_snapshots') ? [] : rows),
        ),
    } as unknown as DataSource;
    const report = await new ExternalSignalPerformanceService(dataSource).getProviderPerformance(
      'user-1',
      'provider-a',
    );
    expect(report.observed.medianMinutesBetweenSignals).toBe(10);
    expect(report.checks.frequency).toBe(true);
    expect(report.observed.rejectedSignals).toBe(3);
  });

  it('preserves legacy v7 evidence but fails closed on a conflicting market-data authority', async () => {
    const legacyRows = strongEvidenceRows();
    const dataSourceLegacy = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(
            sql.includes('broker.broker_account_snapshots')
              ? strongEquitySnapshots()
              : legacyRows,
          ),
        ),
    } as unknown as DataSource;

    const legacyReport = await new ExternalSignalPerformanceService(
      dataSourceLegacy,
    ).getProviderPerformance(
      'user-1',
      'vps-twelvedata-six-pair-v7',
    );

    expect(legacyReport.observed.closedTrades).toBe(120);
    expect(legacyReport.strategyIdentity.marketDataAuthority).toBe(
      'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
    );
    expect(legacyReport.strategyIdentity.authorityTaggedSignals).toBe(0);
    expect(legacyReport.checks.evidenceCohortIntegrity).toBe(true);

    const conflictingRows = strongEvidenceRows().map((row, index) => ({
      ...row,
      market_data_authority:
        index === 119
          ? 'BROKER_NATIVE_METAAPI'
          : 'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
    }));
    const dataSourceConflict = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(
            sql.includes('broker.broker_account_snapshots')
              ? strongEquitySnapshots()
              : conflictingRows,
          ),
        ),
    } as unknown as DataSource;

    const conflictReport = await new ExternalSignalPerformanceService(
      dataSourceConflict,
    ).getProviderPerformance(
      'user-1',
      'vps-twelvedata-six-pair-v7',
    );

    expect(conflictReport.checks.evidenceCohortIntegrity).toBe(false);
    expect(conflictReport.demoReviewEligible).toBe(false);
    expect(conflictReport.strategyIdentity.observedMarketDataAuthorities).toEqual(
      expect.arrayContaining([
        'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
        'BROKER_NATIVE_METAAPI',
      ]),
    );
  });

  it('counts only post-freeze tagged rows in the v8 prospective shadow cohort', async () => {
    const rows = strongEvidenceRows().map((row, index) =>
      index >= 110
        ? {
            ...row,
            v8_shadow_artifact: 'v8-shadow-online-meta-v1',
            v8_shadow_probability: index % 2 === 0 ? '0.51' : '0.42',
            v8_shadow_admitted: index % 2 === 0 ? 'true' : 'false',
            v8_shadow_expected_r: index % 2 === 0 ? '0.36' : '0.12',
          }
        : row,
    );
    const dataSource = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(
            sql.includes('broker.broker_account_snapshots')
              ? strongEquitySnapshots()
              : rows,
          ),
        ),
    } as unknown as DataSource;

    const report = await new ExternalSignalPerformanceService(
      dataSource,
    ).getProviderPerformance('user-1', 'provider-a');

    expect(report.v8ProspectiveShadow.modifiesExecution).toBe(false);
    expect(report.v8ProspectiveShadow.qualificationEvidence).toBe(false);
    expect(report.v8ProspectiveShadow.taggedSignals).toBe(10);
    expect(report.v8ProspectiveShadow.admittedSignals).toBe(5);
    expect(report.v8ProspectiveShadow.closedTrades).toBe(5);
    expect(report.v8ProspectiveShadow.admissionThreshold).toBe(0.46);
    expect(report.v8ProspectiveShadow.nextStage).toBe(
      'COLLECTING_PROSPECTIVE_SHADOW',
    );
  });

  it('scopes the SQL query to the exact user and provider code', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ExternalSignalPerformanceService({ query } as unknown as DataSource);
    await service.getProviderPerformance('user-1', 'provider-b');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('external_provider_code'), [
      'user-1',
      'provider-b',
      'external-provider/provider-b/paper-only-v1',
    ]);
  });
});
