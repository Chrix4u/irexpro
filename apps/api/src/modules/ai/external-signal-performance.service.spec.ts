import { DataSource } from 'typeorm';
import {
  EXTERNAL_PROVIDER_REVIEW_GATES,
  ExternalSignalPerformanceService,
} from './external-signal-performance.service';
import { PLAN_B_ACTIVE_MODEL_POLICY_VERSION } from './plan-b-multimodel-shadow';

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
    expect(report.strategyIdentity.modelVersion).toBe('external-provider/provider-a/paper-only-v1');
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
    expect(report.driftDiagnostics.mode).toBe('DIAGNOSTIC_ONLY');
    expect(report.driftDiagnostics.modifiesExecution).toBe(false);
    expect(report.driftDiagnostics.status).toBe('STABLE');
    expect(report.profitProtectionShadow.mode).toBe('DIAGNOSTIC_ONLY');
    expect(report.profitProtectionShadow.modifiesExecution).toBe(false);
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

  it('counts automated profit-protection closes in qualification metrics and evidence count', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const rows = [
      {
        signal_generated_at: start,
        instrument: 'EURUSD',
        direction: 'BUY',
        confidence_score: '0.70',
        trade_id: 'trade-profit-protection',
        trade_status: 'CLOSED',
        fill_price: '1.0',
        exit_price: '1.005',
        realised_pnl: '5',
        close_reason: 'PROFIT_PROTECTION',
        closed_at: new Date(start.getTime() + 60_000),
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
        equity: '10005',
        accepted_at: new Date(start.getTime() + 70_000),
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
    expect(report.observed.interruptedClosedTrades).toBe(0);
    expect(report.observed.totalNormalizedReturn).toBeCloseTo(0.0005, 10);
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
            sql.includes('broker.broker_account_snapshots') ? strongEquitySnapshots() : legacyRows,
          ),
        ),
    } as unknown as DataSource;

    const legacyReport = await new ExternalSignalPerformanceService(
      dataSourceLegacy,
    ).getProviderPerformance('user-1', 'vps-twelvedata-six-pair-v7');

    expect(legacyReport.observed.closedTrades).toBe(120);
    expect(legacyReport.strategyIdentity.marketDataAuthority).toBe(
      'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
    );
    expect(legacyReport.strategyIdentity.authorityTaggedSignals).toBe(0);
    expect(legacyReport.checks.evidenceCohortIntegrity).toBe(true);

    const conflictingRows = strongEvidenceRows().map((row, index) => ({
      ...row,
      market_data_authority:
        index === 119 ? 'BROKER_NATIVE_METAAPI' : 'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
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
    ).getProviderPerformance('user-1', 'vps-twelvedata-six-pair-v7');

    expect(conflictReport.checks.evidenceCohortIntegrity).toBe(false);
    expect(conflictReport.demoReviewEligible).toBe(false);
    expect(conflictReport.strategyIdentity.observedMarketDataAuthorities).toEqual(
      expect.arrayContaining(['PAPER_RESEARCH_EXTERNAL_TWELVE_DATA', 'BROKER_NATIVE_METAAPI']),
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
            sql.includes('broker.broker_account_snapshots') ? strongEquitySnapshots() : rows,
          ),
        ),
    } as unknown as DataSource;

    const report = await new ExternalSignalPerformanceService(dataSource).getProviderPerformance(
      'user-1',
      'provider-a',
    );

    expect(report.v8ProspectiveShadow.modifiesExecution).toBe(false);
    expect(report.v8ProspectiveShadow.qualificationEvidence).toBe(false);
    expect(report.v8ProspectiveShadow.taggedSignals).toBe(10);
    expect(report.v8ProspectiveShadow.admittedSignals).toBe(5);
    expect(report.v8ProspectiveShadow.rejectedSignals).toBe(5);
    expect(report.v8ProspectiveShadow.closedTrades).toBe(5);
    expect(report.v8ProspectiveShadow.rejectedClosedTrades).toBe(5);
    expect(report.v8ProspectiveShadow.rejectedRealisedPnl).toBeDefined();
    expect(report.v8ProspectiveShadow.admissionThreshold).toBe(0.46);
    expect(report.v8ProspectiveShadow.nextStage).toBe('COLLECTING_PROSPECTIVE_SHADOW');
  });

  it('exposes additive adaptive intelligence diagnostics without changing qualification gates', async () => {
    const start = new Date('2026-10-16T00:00:00.000Z');
    const evidenceRows = [
      {
        signal_generated_at: start,
        market_data_bar_time: start,
        market_data_authority: 'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
        intent_status: 'EXECUTED',
        instrument: 'EURUSD',
        direction: 'BUY',
        confidence_score: '0.72',
        trade_id: 'adaptive-trade-1',
        trade_status: 'CLOSED',
        fill_price: '1.0',
        exit_price: '1.01',
        realised_pnl: '12',
        close_reason: 'TAKE_PROFIT_HIT',
        closed_at: new Date(start.getTime() + 60_000),
        allocated_capital: '100',
        broker_connection_id: null,
        session_opening_balance: '10000',
        session_started_at: start,
        adaptive_market_state: 'TREND_HEALTHY',
        adaptive_risk_multiplier: '1.25',
        adaptive_opportunity_score: '0.88',
        adaptive_scan_rank: '1',
        adaptive_pre_scan_rank: '2',
      },
      {
        signal_generated_at: new Date(start.getTime() + 300_000),
        market_data_bar_time: new Date(start.getTime() + 300_000),
        market_data_authority: 'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
        intent_status: 'EXECUTED',
        instrument: 'GBPUSD',
        direction: 'BUY',
        confidence_score: '0.70',
        trade_id: 'adaptive-trade-2',
        trade_status: 'CLOSED',
        fill_price: '1.0',
        exit_price: '0.995',
        realised_pnl: '-5',
        close_reason: 'STOP_LOSS_HIT',
        closed_at: new Date(start.getTime() + 360_000),
        allocated_capital: '100',
        broker_connection_id: null,
        session_opening_balance: '10000',
        session_started_at: start,
        adaptive_market_state: 'REVERSAL',
        adaptive_risk_multiplier: '1',
        adaptive_opportunity_score: '0.74',
        adaptive_scan_rank: '2',
        adaptive_pre_scan_rank: '1',
      },
    ];
    const adaptiveDecisionRows = [
      {
        adaptive_state: 'TREND_HEALTHY',
        adaptive_score: '0.88',
        adaptive_multiplier: '1.25',
        adaptive_scan_rank: '1',
        pre_adaptive_scan_rank: '2',
        edge_available: 'true',
      },
      {
        adaptive_state: 'REVERSAL',
        adaptive_score: '0.74',
        adaptive_multiplier: '1',
        adaptive_scan_rank: '2',
        pre_adaptive_scan_rank: '1',
        edge_available: 'true',
      },
      {
        adaptive_state: 'TREND_WEAK',
        adaptive_score: '0.48',
        adaptive_multiplier: '0.75',
        adaptive_scan_rank: null,
        pre_adaptive_scan_rank: '3',
        edge_available: 'false',
      },
      {
        adaptive_state: 'DISLOCATED',
        adaptive_score: '0.21',
        adaptive_multiplier: '0.5',
        adaptive_scan_rank: null,
        pre_adaptive_scan_rank: '4',
        edge_available: 'true',
      },
    ];
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM trading.ensemble_shadow_decisions')) return adaptiveDecisionRows;
      if (sql.includes('broker.broker_account_snapshots')) return [];
      return evidenceRows;
    });
    const service = new ExternalSignalPerformanceService({ query } as unknown as DataSource);

    const report = await service.getProviderPerformance('user-1', 'irexpro-multimodel-ensemble-v1');

    expect(report.adaptiveMarketIntelligenceDiagnostics).toMatchObject({
      mode: 'DIAGNOSTIC_ONLY',
      modifiesExecution: false,
      evidenceAvailable: true,
      adaptiveTaggedDecisions: 4,
      edgeEvidenceAvailableDecisions: 3,
      edgeEvidenceAvailabilityRate: 0.75,
      stateCounts: {
        TREND_HEALTHY: 1,
        REVERSAL: 1,
        TREND_WEAK: 1,
        DISLOCATED: 1,
      },
      multiplierCounts: {
        '0.5': 1,
        '0.75': 1,
        '1': 1,
        '1.25': 1,
      },
      rankComparison: {
        comparableWinners: 2,
        improved: 1,
        unchanged: 0,
        worsened: 1,
      },
      executedAdaptiveSignals: 2,
      closedAdaptiveTrades: 2,
    });
    expect(report.adaptiveMarketIntelligenceDiagnostics.scoreDistribution.average).toBeCloseTo(
      0.5775,
      8,
    );
    expect(report.adaptiveMarketIntelligenceDiagnostics.realisedByState).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'TREND_HEALTHY', closedTrades: 1, realisedPnl: 12 }),
        expect.objectContaining({ state: 'REVERSAL', closedTrades: 1, realisedPnl: -5 }),
      ]),
    );
    expect(report.adaptiveMarketIntelligenceDiagnostics.realisedByMultiplier).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ multiplier: 1.25, closedTrades: 1, realisedPnl: 12 }),
        expect.objectContaining({ multiplier: 1, closedTrades: 1, realisedPnl: -5 }),
      ]),
    );
    expect(report.checks.evidence).toBe(false);
    expect(report.automaticDemoPromotion).toBe(false);
    expect(report.automaticLivePromotion).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM trading.ensemble_shadow_decisions'),
      ['user-1', 'irexpro-multimodel-ensemble-v1', PLAN_B_ACTIVE_MODEL_POLICY_VERSION],
    );
  });

  it('isolates multimodel qualification to the active policy and primary PAPER market-data authority', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ExternalSignalPerformanceService({ query } as unknown as DataSource);

    const report = await service.getProviderPerformance('user-1', 'irexpro-multimodel-ensemble-v1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ti.metadata->>'decision_policy_version' = $4"),
      [
        'user-1',
        'irexpro-multimodel-ensemble-v1',
        'external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1',
        PLAN_B_ACTIVE_MODEL_POLICY_VERSION,
        'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
      ],
    );
    expect((query.mock.calls[0]?.[0] as string) ?? '').toContain(
      "ti.metadata->>'market_data_authority' = $5",
    );
    expect(report.strategyIdentity.decisionPolicyVersion).toBe(PLAN_B_ACTIVE_MODEL_POLICY_VERSION);
    expect(report.strategyIdentity.marketDataAuthority).toBe('PAPER_RESEARCH_EXTERNAL_TWELVE_DATA');
    expect(report.strategyIdentity.evidenceCohortKey).toContain(PLAN_B_ACTIVE_MODEL_POLICY_VERSION);
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

it('builds user-scoped PAPER participation diagnostics from persisted M5 and M1 evidence', async () => {
  const now = new Date('2026-10-26T09:00:00.000Z');
  jest.useFakeTimers().setSystemTime(now);
  const query = jest.fn().mockImplementation(async (sql: string, params: unknown[]) => {
    expect(params[0]).toBe('user-1');
    if (sql.includes("components -> 'adaptiveScanSummary' AS adaptive_scan_summary")) {
      expect(params[1]).toBe('irexpro-multimodel-ensemble-v1');
      return [
        {
          broker_connection_id: 'conn-paper-1',
          evaluated_at: new Date('2026-10-26T08:59:00.000Z'),
          adaptive_scan_summary: {
            scanStartedAt: '2026-10-26T08:59:00.000Z',
            evaluatedCandidates: 12,
            executableWinners: 0,
            bestInstrument: 'GBPUSD',
            bestDirection: 'SELL',
            bestNetExpectedR: 0.11,
            bestBlockers: ['DRIFT_OUT_OF_DISTRIBUTION'],
          },
        },
      ];
    }
    if (sql.includes('MAX(t.opened_at) AS last_trade_at')) {
      expect(params[1]).toBe('conn-paper-1');
      return [{ last_trade_at: new Date('2026-10-26T07:00:00.000Z') }];
    }
    if (sql.includes('recent_m5_blocker')) {
      expect(params[2]).toBe('conn-paper-1');
      expect(params[1]).toBe('irexpro-multimodel-ensemble-v1');
      return [
        { recent_m5_blocker: 'DRIFT_OUT_OF_DISTRIBUTION' },
        { recent_m5_blocker: 'DRIFT_OUT_OF_DISTRIBUTION' },
      ];
    }
    if (sql.includes('FROM trading.m1_tactical_decisions')) {
      expect(params[1]).toBe('conn-paper-1');
      return [
        {
          evaluated_at: new Date('2026-10-26T08:58:00.000Z'),
          route: 'M1_EARLY_TRANSITION',
          execution_authority: 'NONE',
          blockers: ['M1_TIERED_SCOUT_RELIABILITY_INSUFFICIENT_PROVISIONAL_EVIDENCE'],
        },
      ];
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  try {
    const service = new ExternalSignalPerformanceService({ query } as unknown as DataSource);
    const report = await service.getPaperParticipationDiagnostics(
      'user-1',
      'irexpro-multimodel-ensemble-v1',
    );

    expect(report.mode).toBe('DIAGNOSTIC_ONLY');
    expect(report.modifiesExecution).toBe(false);
    expect(report.state).toBe('QUALIFIED_BUT_BLOCKED');
    expect(report.minutesSinceLastTrade).toBe(120);
    expect(report.m5.evaluatedCandidates).toBe(12);
    expect(report.m1.routeQualifiedDecisions).toBe(1);
    expect(report.topBlockers[0]).toEqual({
      blocker: 'DRIFT_OUT_OF_DISTRIBUTION',
      category: 'EVIDENCE_QUALITY',
      count: 2,
    });
    expect(query).toHaveBeenCalledTimes(4);
  } finally {
    jest.useRealTimers();
  }
});
