import { DataSource } from 'typeorm';
import {
  LiveDemoProfitProtectionService,
  evaluateLiveDemoAdverseProtection,
  evaluateContinuationRecoveryGrace,
  CONTINUATION_RECOVERY_GRACE_MINUTES,
  evaluateLiveDemoProfitLockTrendRecheck,
  evaluateLiveDemoThesisProtection,
} from './live-demo-profit-protection.service';
import { BrokerService } from '../../broker/broker.service';
import { ExecutionService } from '../execution.service';
import { TradeCloseReason } from '../entities/trade.entity';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';

describe('LiveDemoProfitProtectionService', () => {
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    trade_id: 'trade-1',
    user_id: 'user-1',
    broker_connection_id: 'conn-1',
    external_order_id: 'order-777',
    external_position_id: 'position-7001',
    instrument: 'EURUSD',
    direction: 'BUY',
    lot_size: '0.20',
    account_currency: 'EUR',
    max_favorable_pnl: '10.00',
    max_adverse_pnl: '-2.00',
    profit_giveback: '0.00',
    path_observation_count: 5,
    path_peak_observed_at: new Date('2026-10-28T09:00:00.000Z'),
    initial_risk_pnl: '9.00',
    stop_loss: '1.11250',
    opened_at: new Date('2026-10-28T09:01:00.000Z'),
    is_m1_strategy: true,
    strategy_route: 'TREND_CONTINUATION',
    ...overrides,
  });

  function harness(
    rows = [candidate()],
    currentPnl = '7.00',
    accountType = 'DEMO',
    m1Rows: Array<Record<string, unknown>> = [],
    currentPrice = '1.11340',
    thesisRows: Array<Record<string, unknown>> = [],
    auditService?: AuditService,
    feeRows: Array<Record<string, unknown>> = [],
    patienceRows: Array<Record<string, unknown>> = [],
    recoveryRows: Array<Record<string, unknown>> = [],
  ) {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('past_fees')) return feeRows;
      if (sql.includes('AS same_side_continuation_at')) return patienceRows;
      if (sql.includes('AS aligned_m5')) return recoveryRows;
      if (sql.includes('FROM trading.trades t')) return rows;
      if (sql.includes('FROM trading.m1_tactical_decisions')) return thesisRows;
      if (sql.includes('FROM market_data.provider_quote_candles')) return m1Rows;
      if (sql.includes('UPDATE trading.trades')) return [];
      return [];
    });
    const dataSource = { query } as unknown as DataSource;
    const brokerService = {
      getOpenPositionsForConnection: jest.fn().mockResolvedValue({
        connection: { id: 'conn-1', brokerId: 'ctrader', accountType },
        positions: [
          {
            externalOrderId: 'position-7001',
            instrument: 'EURUSD',
            direction: 'BUY',
            lotSize: '0.20',
            openPrice: '1.11300',
            currentPrice,
            stopLoss: String(rows[0]?.stop_loss ?? '1.11250'),
            takeProfit: '1.11380',
            unrealisedPnl: currentPnl,
            openedAt: new Date('2026-10-28T08:55:00.000Z'),
            commission: '0',
            swap: '0',
          },
        ],
      }),
    } as unknown as BrokerService;
    const executionService = {
      closeTrade: jest.fn().mockResolvedValue({ status: 'CLOSED' }),
    } as unknown as ExecutionService;
    return {
      service: new LiveDemoProfitProtectionService(
        dataSource,
        brokerService,
        executionService,
        auditService,
      ),
      query,
      brokerService: brokerService as any,
      executionService: executionService as any,
    };
  }

  it('persists peak/giveback telemetry and profit-protects a cTrader DEMO winner that retraces through its R floor', async () => {
    const h = harness([candidate()], '7.00');

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE trading.trades'),
      expect.arrayContaining(['trade-1', '10.00000000', '-2.00000000', '3.00000000', 6]),
    );
    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
  });

  it('records a causal DEMO profit-lock trend check without delaying or overriding the close', async () => {
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const m1Rows = [
      {
        bucket_time: new Date('2026-10-28T09:04:00.000Z'),
        open: '1.11320',
        high: '1.11330',
        low: '1.11319',
        close: '1.11329',
        sample_count: 30,
        positive_quote_sample_count: 30,
        last_quote_sample_at: new Date('2026-10-28T09:04:20.000Z'),
        spread_close: '0.00002',
        source: 'ctrader-broker-native',
      },
      {
        bucket_time: new Date('2026-10-28T09:03:00.000Z'),
        open: '1.11315',
        high: '1.11321',
        low: '1.11314',
        close: '1.11320',
        sample_count: 32,
        positive_quote_sample_count: 32,
        last_quote_sample_at: new Date('2026-10-28T09:03:20.000Z'),
        spread_close: '0.00002',
        source: 'ctrader-broker-native',
      },
      {
        bucket_time: new Date('2026-10-28T09:02:00.000Z'),
        open: '1.11310',
        high: '1.11316',
        low: '1.11309',
        close: '1.11315',
        sample_count: 26,
        positive_quote_sample_count: 26,
        last_quote_sample_at: new Date('2026-10-28T09:02:20.000Z'),
        spread_close: '0.00002',
        source: 'ctrader-broker-native',
      },
    ];
    const thesisRows = [
      {
        direction: 'BUY',
        evaluated_at: new Date('2026-10-28T09:04:40.000Z'),
        execution_authority: 'BROKER_NATIVE',
        blockers: [],
        governance: {},
        plan_b_strategy_route: 'TREND_CONTINUATION',
        authority_executable: true,
        expert_direction: 'BUY',
        expert_all_broker_native: true,
        expert_long_votes: 3,
        expert_short_votes: 0,
        expert_ensemble_confidence: 0.81,
        expert_freshness_seconds: 9,
      },
    ];
    const h = harness(
      [candidate()],
      '7.00',
      'DEMO',
      m1Rows,
      '1.11340',
      thesisRows,
      auditService as unknown as AuditService,
      [{ sample_count: '12', p90_cost_per_lot: '8.00' }],
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.DEMO_PROFIT_LOCK_TREND_RECHECK,
        resourceId: 'trade-1',
        metadata: expect.objectContaining({
          mode: 'SHADOW_ONLY',
          recommendation: 'HOLD_CANDIDATE',
          reason: 'CONTINUATION_CANDIDATE',
          runnerShadow: expect.objectContaining({
            mode: 'SHADOW_ONLY',
            eligibleForFurtherResearch: true,
            reason: 'BROKER_VALIDATION_REQUIRED',
            estimatedBrokerCosts: 1.6,
            feeSampleCount: 12,
            noTradeAuthority: true,
          }),
          runnerCostEvidence: 'RECENT_CLOSED_TRADES_BEFORE_DECISION',
          originalCloseReason: TradeCloseReason.PROFIT_PROTECTION,
          noTradeAuthority: true,
        }),
      }),
    );
    expect(h.executionService.closeTrade.mock.invocationCallOrder[0]).toBeLessThan(
      auditService.log.mock.invocationCallOrder[0]!,
    );
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('positive_quote_sample_count'),
      expect.any(Array),
    );
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('last_quote_sample_at'),
      expect.any(Array),
    );
    const feeSql = h.query.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('past_fees'),
    );
    expect(String(feeSql?.[0])).toContain('t.closed_at < $4::timestamptz');
    expect(feeSql?.[1]).toEqual(['conn-1', 'EURUSD', 'EUR', '2026-10-28T09:05:00.000Z']);
  });

  it('audits protected patience despite a blocked new-entry thesis without postponing the real close', async () => {
    const observedAt = new Date('2026-10-28T09:05:00.000Z');
    const m1Rows = [
      {
        bucket_time: new Date('2026-10-28T09:04:00.000Z'),
        open: '1.11320',
        high: '1.11331',
        low: '1.11318',
        close: '1.11330',
        sample_count: 30,
        positive_quote_sample_count: 12,
        last_quote_sample_at: new Date('2026-10-28T09:04:55.000Z'),
        spread_close: '0.00002',
        source: 'ctrader-broker-native',
      },
      {
        bucket_time: new Date('2026-10-28T09:03:00.000Z'),
        open: '1.11310',
        high: '1.11321',
        low: '1.11309',
        close: '1.11320',
        sample_count: 31,
        positive_quote_sample_count: 15,
        last_quote_sample_at: new Date('2026-10-28T09:03:54.000Z'),
        spread_close: '0.00002',
        source: 'ctrader-broker-native',
      },
    ];
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const h = harness(
      [candidate()],
      '7.00',
      'DEMO',
      m1Rows,
      '1.11340',
      [
        {
          direction: 'BUY',
          evaluated_at: new Date('2026-10-28T09:04:45.000Z'),
          execution_authority: 'NONE',
          blockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'MULTIMODEL_PLAN_B_NOT_ADMITTED'],
          governance: {},
          plan_b_strategy_route: 'TREND_CONTINUATION',
          authority_executable: false,
        },
      ],
      auditService as unknown as AuditService,
      [{ sample_count: '12', p90_cost_per_lot: '8.00' }],
      [
        {
          same_side_continuation_at: new Date('2026-10-28T09:03:00.000Z'),
          opposite_executable_reversal: false,
        },
      ],
    );

    await h.service.runOnce(observedAt);

    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          recommendation: 'CLOSE_CANDIDATE',
          reason: 'THESIS_NOT_EXECUTABLE',
          protectedGraceShadow: expect.objectContaining({
            mode: 'SHADOW_ONLY',
            wouldConsiderBrokerProtectedGrace: true,
            requiresVerifiedBrokerProfitStop: true,
            maxGraceSeconds: 180,
            noTradeAuthority: true,
            modifiesExecution: false,
          }),
          protectedGraceRunnerShadow: expect.objectContaining({
            mode: 'SHADOW_ONLY',
            reason: 'BROKER_VALIDATION_REQUIRED',
            eligibleForFurtherResearch: true,
            noTradeAuthority: true,
          }),
        }),
      }),
    );
    expect(h.executionService.closeTrade.mock.invocationCallOrder[0]).toBeLessThan(
      auditService.log.mock.invocationCallOrder[0]!,
    );
    const sqlCall = h.query.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('AS same_side_continuation_at'),
    );
    expect(String(sqlCall?.[0])).toContain('evaluated_at <= $5::timestamptz');
    expect(sqlCall?.[1]).toEqual(['user-1', 'conn-1', 'EURUSD', 'BUY', observedAt.toISOString()]);
  });

  it('rejects shadow HOLD when quote samples were recorded after the decision', async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const h = harness(
      [candidate()],
      '7.00',
      'DEMO',
      [
        {
          bucket_time: new Date('2026-10-28T09:04:00.000Z'),
          open: '1.11320',
          high: '1.11330',
          low: '1.11319',
          close: '1.11329',
          sample_count: 20,
          positive_quote_sample_count: 20,
          last_quote_sample_at: new Date('2026-10-28T09:05:20.000Z'),
          source: 'ctrader-broker-native',
        },
      ],
      '1.11340',
      [],
      audit as unknown as AuditService,
    );
    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));
    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          recommendation: 'CLOSE_CANDIDATE',
          noTradeAuthority: true,
          m1LiveQuoteBars: 0,
        }),
      }),
    );
  });

  it('does not propose continuation on stale or backfilled-only trend evidence', () => {
    const observedAt = new Date('2026-10-28T09:05:00.000Z');
    const thesis = {
      direction: 'BUY' as const,
      evaluatedAt: new Date('2026-10-28T09:04:40.000Z'),
      executionAuthority: 'BROKER_NATIVE',
      blockers: [],
      planBStrategyRoute: 'TREND_CONTINUATION' as const,
      authorityExecutable: true,
      trainedExpert: {
        direction: 'BUY' as const,
        allBrokerNative: true,
        longVotes: 3,
        shortVotes: 0,
        ensembleConfidence: 0.81,
        freshnessSeconds: 9,
      },
    };
    const m1Evidence = {
      completedBars: 3,
      adverseBars: 0,
      alignedLatestBodyPressure: 0.8,
      alignedMomentum3: 0.35,
      latestAgeSeconds: 0,
      liveQuoteBars: 0,
    };
    expect(
      evaluateLiveDemoProfitLockTrendRecheck({
        tradeDirection: 'BUY',
        observedAt,
        latestThesis: thesis,
        m1Evidence,
      }),
    ).toMatchObject({
      wouldHoldIfEnabled: false,
      reason: 'M1_LIVE_EVIDENCE_MISSING',
    });
    expect(
      evaluateLiveDemoProfitLockTrendRecheck({
        tradeDirection: 'BUY',
        observedAt,
        latestThesis: { ...thesis, evaluatedAt: new Date('2026-10-28T09:02:00.000Z') },
        m1Evidence: { ...m1Evidence, liveQuoteBars: 3 },
      }),
    ).toMatchObject({ wouldHoldIfEnabled: false, reason: 'THESIS_STALE' });
    expect(
      evaluateLiveDemoProfitLockTrendRecheck({
        tradeDirection: 'BUY',
        observedAt,
        latestThesis: { ...thesis, direction: 'SELL' },
        m1Evidence: { ...m1Evidence, liveQuoteBars: 3 },
      }),
    ).toMatchObject({ wouldHoldIfEnabled: false, reason: 'THESIS_OPPOSES_TRADE' });
  });

  it('observes but does not close an M1 trade before the 0.395R rescue floor is armed', async () => {
    const h = harness([candidate({ max_favorable_pnl: '3.00', max_adverse_pnl: '-1.00' })], '2.50');

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE trading.trades'),
      expect.arrayContaining(['trade-1', '3.00000000', '-1.00000000', '0.50000000', 6]),
    );
    expect(h.executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('profit-protects a DEMO M1 trade inside the 0.395R sampling-tolerance band', async () => {
    const h = harness([candidate({ max_favorable_pnl: '3.56', max_adverse_pnl: '-1.00' })], '1.42');

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
  });

  it('defers confirmed-reversal profit protection below 1.00R but arms it at 1.00R', async () => {
    const belowFloor = harness(
      [
        candidate({
          strategy_route: 'CONFIRMED_REVERSAL',
          max_favorable_pnl: '8.99',
          max_adverse_pnl: '-1.00',
        }),
      ],
      '6.73',
    );

    await belowFloor.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(belowFloor.executionService.closeTrade).not.toHaveBeenCalled();

    const atFloor = harness(
      [
        candidate({
          strategy_route: 'CONFIRMED_REVERSAL',
          max_favorable_pnl: '9.00',
          max_adverse_pnl: '-1.00',
        }),
      ],
      '7.19',
    );

    await atFloor.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(atFloor.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
  });

  it('still arms early-transition profit protection at 0.75R', async () => {
    const h = harness(
      [
        candidate({
          strategy_route: 'EARLY_TRANSITION',
          max_favorable_pnl: '6.75',
          max_adverse_pnl: '-1.00',
        }),
      ],
      '5.05',
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
  });

  it('keeps sub-0.75R profit protection for trend continuation', async () => {
    const h = harness(
      [candidate({ strategy_route: 'TREND_CONTINUATION', max_favorable_pnl: '5.00' })],
      '3.49',
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
  });

  it('loads the originating Plan-B route for route-aware profit protection', async () => {
    const h = harness([candidate()], '7.00');
    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));
    const tradeLoadSql = String(
      h.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('FROM trading.trades t'),
      )?.[0] ?? '',
    );
    expect(tradeLoadSql).toContain('strategy_route');
    expect(tradeLoadSql).toContain('multimodel_plan_b_route');
  });

  it('closes a materially losing DEMO trade when completed broker-native M1 evidence confirms thesis failure', async () => {
    const h = harness(
      [candidate({ max_favorable_pnl: '0.50', max_adverse_pnl: '-5.00' })],
      '-5.00',
      'DEMO',
      [
        {
          bucket_time: new Date('2026-10-28T09:03:00.000Z'),
          open: '1.1000',
          high: '1.1001',
          low: '1.0994',
          close: '1.0995',
          sample_count: 10,
          source: 'ctrader-broker-native',
        },
        {
          bucket_time: new Date('2026-10-28T09:02:00.000Z'),
          open: '1.1005',
          high: '1.1006',
          low: '1.0999',
          close: '1.1000',
          sample_count: 9,
          source: 'ctrader-broker-native',
        },
        {
          bucket_time: new Date('2026-10-28T09:01:00.000Z'),
          open: '1.1008',
          high: '1.1009',
          low: '1.1004',
          close: '1.1005',
          sample_count: 8,
          source: 'ctrader-broker-native',
        },
      ],
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:10.000Z'));

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM market_data.provider_quote_candles'),
      ['conn-1', 'EURUSD', expect.any(String)],
    );
    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.AI_CLOSE_SIGNAL,
      { source: 'BROKER_ADVERSE_PROTECTION', reasonCode: 'ADVERSE_THESIS_FAILED' },
    );
  });

  it('closes a recovered DEMO position immediately when its authoritative stop was already crossed', async () => {
    const h = harness(
      [candidate({ max_favorable_pnl: '0.50', max_adverse_pnl: '-12.00' })],
      '-12.00',
      'DEMO',
      [],
      '1.11240',
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:10.000Z'));

    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.STOP_LOSS_HIT,
    );
    expect(h.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM market_data.provider_quote_candles'),
      expect.anything(),
    );
  });

  it('harvests a positive DEMO trade when the latest fresh broker-native expert vote is unanimously opposite', async () => {
    const h = harness(
      [candidate({ max_favorable_pnl: '1.50', max_adverse_pnl: '-1.00' })],
      '1.50',
      'DEMO',
      [],
      '1.11340',
      [
        {
          direction: 'SELL',
          evaluated_at: new Date('2026-10-28T09:04:30.000Z'),
          execution_authority: 'NONE',
          blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
          governance: {
            multimodelEnsemble: { strategyRoute: 'EARLY_TRANSITION' },
            multimodelAuthority: { executable: false },
            multimodelTrainedExpert: {
              direction: 'SELL',
              allBrokerNative: true,
              longVotes: 0,
              shortVotes: 3,
              ensembleConfidence: 0.74,
              freshnessSeconds: 30,
            },
          },
        },
      ],
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM trading.m1_tactical_decisions'),
      ['user-1', 'conn-1', 'EURUSD', expect.any(String)],
    );
    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.AI_CLOSE_SIGNAL,
      { source: 'BROKER_THESIS_PROTECTION', reasonCode: 'OPPOSITE_EXPERT_PROFIT_HARVEST' },
    );
  });

  it('cuts a mid-loss DEMO trade after the confirmed-reversal recovery window expires', async () => {
    const h = harness(
      [candidate({ max_favorable_pnl: '0.50', max_adverse_pnl: '-2.50' })],
      '-2.50',
      'DEMO',
      [],
      '1.11340',
      [
        {
          direction: 'SELL',
          evaluated_at: new Date('2026-10-28T09:04:10.000Z'),
          execution_authority: 'BROKER_NATIVE',
          blockers: [],
          governance: {
            multimodelEnsemble: { strategyRoute: 'CONFIRMED_REVERSAL' },
            multimodelAuthority: { executable: true },
            multimodelTrainedExpert: {
              direction: 'SELL',
              allBrokerNative: true,
              longVotes: 0,
              shortVotes: 3,
              ensembleConfidence: 0.72,
              freshnessSeconds: 50,
            },
          },
        },
      ],
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.AI_CLOSE_SIGNAL,
      { source: 'BROKER_THESIS_PROTECTION', reasonCode: 'CONFIRMED_REVERSAL_GRACE_EXPIRED' },
    );
    expect(h.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM market_data.provider_quote_candles'),
      expect.anything(),
    );
  });

  it('defers the 08:51 EURUSD BUY only if the latest two broker-native M1 minutes are truly quoted', async () => {
    const observedAt = new Date('2026-11-09T08:51:05.000Z');
    const candles = [
      {
        bucket_time: new Date('2026-11-09T08:50:00Z'),
        open: '1.11863',
        high: '1.11863',
        low: '1.11848',
        close: '1.11851',
        sample_count: 21,
        positive_quote_sample_count: 21,
        last_quote_sample_at: new Date('2026-11-09T08:50:58Z'),
        source: 'ctrader-broker-native',
      },
      {
        bucket_time: new Date('2026-11-09T08:49:00Z'),
        open: '1.11868',
        high: '1.11872',
        low: '1.11866',
        close: '1.11866',
        sample_count: 16,
        positive_quote_sample_count: 16,
        last_quote_sample_at: new Date('2026-11-09T08:49:59Z'),
        source: 'ctrader-broker-native',
      },
      {
        bucket_time: new Date('2026-11-09T08:48:00Z'),
        open: '1.11881',
        high: '1.11892',
        low: '1.11869',
        close: '1.11870',
        sample_count: 25,
        positive_quote_sample_count: 25,
        last_quote_sample_at: new Date('2026-11-09T08:48:59Z'),
        source: 'ctrader-broker-native',
      },
    ];
    const buy = candidate({
      opened_at: new Date('2026-11-09T08:48:29.000Z'),
      stop_loss: '1.11827',
      max_favorable_pnl: '0',
      max_adverse_pnl: '-5.00',
      initial_risk_pnl: '8',
      is_m1_strategy: true,
      strategy_route: 'TREND_CONTINUATION',
    });
    const aligned = [
      { created_at: new Date('2026-11-09T08:50:29Z'), aligned_m5: '1', aligned_m15: '1' },
    ];
    const h = harness([buy], '-4.96', 'DEMO', candles, '1.11851', [], undefined, [], [], aligned);
    await h.service.runOnce(observedAt);
    expect(h.executionService.closeTrade).not.toHaveBeenCalled();
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('AS aligned_m5'), [
      'user-1',
      'conn-1',
      'EURUSD',
      'BUY',
      observedAt.toISOString(),
    ]);
    // Grace is tied to opened_at, not renewed by subsequent scheduler scans.
    // Recheck using a NEW harness with later fully completed broker-native
    // M1 bars; never inject future data into the first evaluation.
    const laterCandles = [
      {
        ...candles[0],
        bucket_time: new Date('2026-11-09T08:52:00Z'),
        open: '1.11863',
        high: '1.11864',
        low: '1.11848',
        close: '1.11851',
        last_quote_sample_at: new Date('2026-11-09T08:52:58Z'),
      },
      {
        ...candles[1],
        bucket_time: new Date('2026-11-09T08:51:00Z'),
        open: '1.11865',
        high: '1.11865',
        low: '1.11853',
        close: '1.11855',
        last_quote_sample_at: new Date('2026-11-09T08:51:58Z'),
      },
      candles[0],
    ];
    const hLater = harness(
      [buy],
      '-4.96',
      'DEMO',
      laterCandles,
      '1.11851',
      [],
      undefined,
      [],
      [],
      aligned,
    );
    await hLater.service.runOnce(new Date('2026-11-09T08:53:01Z'));
    expect(hLater.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.AI_CLOSE_SIGNAL,
      { source: 'BROKER_ADVERSE_PROTECTION', reasonCode: 'ADVERSE_THESIS_FAILED' },
    );
  });

  it('never applies automatic profit protection to a real-money LIVE connection', async () => {
    const h = harness([candidate()], '7.00', 'LIVE');

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.executionService.closeTrade).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE trading.trades'),
      expect.anything(),
    );
  });
});

describe('bounded M1 continuation recovery grace', () => {
  const observedAt = new Date('2026-11-09T08:51:05.000Z');
  const base = {
    tradeDirection: 'BUY' as const,
    strategyRoute: 'TREND_CONTINUATION',
    elapsedMinutes: 2.6,
    currentR: -0.62,
    adverseReason: 'ADVERSE_THESIS_FAILED' as const,
    m1Evidence: {
      completedBars: 3,
      adverseBars: 3,
      alignedLatestBodyPressure: -0.84,
      alignedMomentum3: -0.47,
      latestAgeSeconds: 5,
      liveQuoteBars: 3,
      consecutiveLiveQuoteBars: 3,
    },
    m5Aligned: 1,
    m15Aligned: 1,
    alignmentObservedAt: new Date('2026-11-09T08:50:29.000Z'),
    observedAt,
    authoritativeStop: 1.11827,
    brokerStop: 1.11827,
    currentPrice: 1.11851,
  };

  it('gives a fixed, non-renewing recovery check to the losing EURUSD continuation example', () => {
    expect(evaluateContinuationRecoveryGrace(base)).toBe(true);
    expect(
      evaluateContinuationRecoveryGrace({
        ...base,
        elapsedMinutes: CONTINUATION_RECOVERY_GRACE_MINUTES,
      }),
    ).toBe(false);
  });

  it.each([
    { currentR: -0.65 },
    { currentR: -0.8 },
    { adverseReason: 'EMERGENCY_ADVERSE_CUT' as const },
    { strategyRoute: 'CONFIRMED_REVERSAL' },
    { strategyRoute: 'EARLY_TRANSITION' },
    { m5Aligned: -1 },
    { m15Aligned: 0 },
    { m5Aligned: null },
    { alignmentObservedAt: new Date('2026-11-09T08:47:00Z') },
    { alignmentObservedAt: new Date('2026-11-09T08:51:06Z') },
    { authoritativeStop: 1.11852 },
    { brokerStop: null },
    { brokerStop: 1.1195 },
    { currentPrice: 1.1182 },
    { m1Evidence: null },
    { m1Evidence: { ...base.m1Evidence, consecutiveLiveQuoteBars: 1 } },
    { m1Evidence: { ...base.m1Evidence, latestAgeSeconds: 120 } },
  ])('does not defer a protective close without complete safe evidence: %p', (override) => {
    expect(evaluateContinuationRecoveryGrace({ ...base, ...override })).toBe(false);
  });

  it('works identically for SELL without weakening the stop direction', () => {
    expect(
      evaluateContinuationRecoveryGrace({
        ...base,
        tradeDirection: 'SELL',
        currentPrice: 1.11851,
        authoritativeStop: 1.1188,
        brokerStop: 1.1188,
      }),
    ).toBe(true);
    expect(
      evaluateContinuationRecoveryGrace({
        ...base,
        tradeDirection: 'SELL',
        currentPrice: 1.11885,
        authoritativeStop: 1.1188,
        brokerStop: 1.1188,
      }),
    ).toBe(false);
  });
});

describe('evaluateLiveDemoAdverseProtection', () => {
  const base = {
    elapsedMinutes: 4,
    currentPnl: -4.5,
    initialRiskPnl: 10,
    maxFavorablePnl: 0.5,
    profitLockArmed: false,
    m1Evidence: {
      completedBars: 3,
      adverseBars: 3,
      alignedLatestBodyPressure: -0.72,
      alignedMomentum3: -0.58,
      latestAgeSeconds: 8,
    },
  } as const;

  it('does not cut before one completed M1 minute exists', () => {
    expect(evaluateLiveDemoAdverseProtection({ ...base, elapsedMinutes: 0.8 })).toMatchObject({
      shouldClose: false,
      reason: 'TOO_EARLY',
    });
  });

  it('leaves a trade to profit protection once the favorable excursion has armed it', () => {
    expect(evaluateLiveDemoAdverseProtection({ ...base, profitLockArmed: true })).toMatchObject({
      shouldClose: false,
      reason: 'PROFIT_PROTECTION_OWNS_TRADE',
    });
  });

  it('cuts a losing thesis before full stop when adverse R and completed M1 evidence agree', () => {
    expect(evaluateLiveDemoAdverseProtection(base)).toMatchObject({
      shouldClose: true,
      reason: 'ADVERSE_THESIS_FAILED',
      currentR: -0.45,
    });
  });

  it('cuts an emergency fast loss when the first completed M1 bar confirms the adverse move', () => {
    expect(
      evaluateLiveDemoAdverseProtection({
        ...base,
        elapsedMinutes: 1.2,
        currentPnl: -7,
        m1Evidence: {
          completedBars: 1,
          adverseBars: 1,
          alignedLatestBodyPressure: -0.8,
          alignedMomentum3: -0.8,
          latestAgeSeconds: 5,
        },
      }),
    ).toMatchObject({ shouldClose: true, reason: 'EMERGENCY_ADVERSE_CUT' });
  });

  it('holds an adverse position when the completed M1 evidence is recovering with the trade direction', () => {
    expect(
      evaluateLiveDemoAdverseProtection({
        ...base,
        currentPnl: -5.2,
        m1Evidence: {
          completedBars: 3,
          adverseBars: 1,
          alignedLatestBodyPressure: 0.48,
          alignedMomentum3: 0.2,
          latestAgeSeconds: 6,
        },
      }),
    ).toMatchObject({ shouldClose: false, reason: 'RECOVERY_FORMING' });
  });

  it('holds when causal completed-M1 evidence is missing or stale', () => {
    expect(evaluateLiveDemoAdverseProtection({ ...base, m1Evidence: null })).toMatchObject({
      shouldClose: false,
      reason: 'M1_EVIDENCE_UNAVAILABLE',
    });
    expect(
      evaluateLiveDemoAdverseProtection({
        ...base,
        m1Evidence: { ...base.m1Evidence, latestAgeSeconds: 150 },
      }),
    ).toMatchObject({ shouldClose: false, reason: 'M1_EVIDENCE_UNAVAILABLE' });
  });
});

describe('evaluateLiveDemoThesisProtection', () => {
  const confirmedOpposite = {
    direction: 'SELL' as const,
    evaluatedAt: new Date('2026-11-02T01:45:00.000Z'),
    executionAuthority: 'BROKER_NATIVE',
    blockers: [] as string[],
    planBStrategyRoute: 'CONFIRMED_REVERSAL' as const,
    authorityExecutable: true,
    trainedExpert: {
      direction: 'SELL' as const,
      allBrokerNative: true,
      longVotes: 0,
      shortVotes: 3,
      ensembleConfidence: 0.74,
      freshnessSeconds: 30,
    },
  };

  it('harvests a positive old thesis when all three fresh broker-native experts unanimously oppose it', () => {
    expect(
      evaluateLiveDemoThesisProtection({
        tradeDirection: 'BUY',
        currentPnl: 2,
        initialRiskPnl: 10,
        observedAt: new Date('2026-11-02T01:45:30.000Z'),
        latestThesis: {
          ...confirmedOpposite,
          executionAuthority: 'NONE',
          planBStrategyRoute: 'EARLY_TRANSITION',
          authorityExecutable: false,
        },
      }),
    ).toMatchObject({
      shouldClose: true,
      reason: 'OPPOSITE_EXPERT_PROFIT_HARVEST',
      currentR: 0.2,
    });
  });

  it('does not let advisory expert opposition close a losing trade', () => {
    expect(
      evaluateLiveDemoThesisProtection({
        tradeDirection: 'BUY',
        currentPnl: -2.5,
        initialRiskPnl: 10,
        observedAt: new Date('2026-11-02T01:45:30.000Z'),
        latestThesis: {
          ...confirmedOpposite,
          executionAuthority: 'NONE',
          planBStrategyRoute: 'EARLY_TRANSITION',
          authorityExecutable: false,
        },
      }),
    ).toMatchObject({ shouldClose: false, reason: 'OPPOSITE_NOT_CONFIRMED_REVERSAL' });
  });

  it('closes a near-break-even losing old thesis when a broker-authorized confirmed reversal arrives', () => {
    expect(
      evaluateLiveDemoThesisProtection({
        tradeDirection: 'BUY',
        currentPnl: -1,
        initialRiskPnl: 10,
        observedAt: new Date('2026-11-02T01:45:20.000Z'),
        latestThesis: confirmedOpposite,
      }),
    ).toMatchObject({
      shouldClose: true,
      reason: 'CONFIRMED_REVERSAL_NEAR_BREAKEVEN',
      currentR: -0.1,
    });
  });

  it('gives a mid-loss old thesis only a short recovery window after a confirmed reversal', () => {
    expect(
      evaluateLiveDemoThesisProtection({
        tradeDirection: 'BUY',
        currentPnl: -2.5,
        initialRiskPnl: 10,
        observedAt: new Date('2026-11-02T01:45:30.000Z'),
        latestThesis: confirmedOpposite,
      }),
    ).toMatchObject({ shouldClose: false, reason: 'CONFIRMED_REVERSAL_RECOVERY_WINDOW' });

    expect(
      evaluateLiveDemoThesisProtection({
        tradeDirection: 'BUY',
        currentPnl: -2.5,
        initialRiskPnl: 10,
        observedAt: new Date('2026-11-02T01:45:50.000Z'),
        latestThesis: confirmedOpposite,
      }),
    ).toMatchObject({ shouldClose: true, reason: 'CONFIRMED_REVERSAL_GRACE_EXPIRED' });
  });

  it('cuts a deeply losing old thesis immediately when the confirmed reversal agrees', () => {
    expect(
      evaluateLiveDemoThesisProtection({
        tradeDirection: 'BUY',
        currentPnl: -4,
        initialRiskPnl: 10,
        observedAt: new Date('2026-11-02T01:45:15.000Z'),
        latestThesis: confirmedOpposite,
      }),
    ).toMatchObject({ shouldClose: true, reason: 'CONFIRMED_REVERSAL_HARD_CUT' });
  });

  it('ignores stale or same-direction thesis evidence', () => {
    expect(
      evaluateLiveDemoThesisProtection({
        tradeDirection: 'BUY',
        currentPnl: 3,
        initialRiskPnl: 10,
        observedAt: new Date('2026-11-02T01:48:30.000Z'),
        latestThesis: confirmedOpposite,
      }),
    ).toMatchObject({ shouldClose: false, reason: 'THESIS_STALE' });

    expect(
      evaluateLiveDemoThesisProtection({
        tradeDirection: 'BUY',
        currentPnl: 3,
        initialRiskPnl: 10,
        observedAt: new Date('2026-11-02T01:45:30.000Z'),
        latestThesis: { ...confirmedOpposite, direction: 'BUY' },
      }),
    ).toMatchObject({ shouldClose: false, reason: 'SAME_DIRECTION' });
  });
});
