import { ConfigService } from '@nestjs/config';
import { AiSignalService } from './ai-signal.service';
import {
  VpsForexSignalCollectorService,
  canExecuteMultiModelPaper,
  buildCandidate,
  buildDirectionalCandidates,
  selectCounterfactualExecutionCandidate,
  prioritizeCounterfactualExecutionRoutes,
  dynamicPaperLotUpperBound,
  isFreshOpportunity,
} from './vps-forex-signal-collector.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { BrokerService } from '../broker/broker.service';
import { LivePaperMarketDataService } from '../broker/services/live-paper-market-data.service';
import * as PlanBEnsembleModule from './plan-b-multimodel-shadow';
import * as EnsembleGovernanceModule from './ensemble-governance';
import * as V8ShadowMetaModule from './v8-shadow-meta-scorer';
import * as PairedDirectionReversalModule from './paired-direction-reversal';
import { PAPER_POST_LOSS_STATE_QUERY } from './paper-post-loss-state-query';

// Collection fixtures explicitly provide a healthy, empty PAPER history.
// Missing/empty production store responses are tested separately below.
function createCollector(...args: ConstructorParameters<typeof VpsForexSignalCollectorService>) {
  const original = args[6];
  args[6] = {
    ...original,
    query: async (sql: string, params: unknown[]) => {
      const rows = original ? await original.query(sql, params) : [];
      if (sql === PAPER_POST_LOSS_STATE_QUERY && Array.isArray(rows) && rows.length === 0) {
        return [
          {
            paper_post_loss_state_available: true,
            trade_id: null,
            close_reason: null,
            closed_at: null,
            reconfirmed: false,
          },
        ];
      }
      return rows;
    },
  } as any;
  return new VpsForexSignalCollectorService(...args);
}

describe('dynamic PAPER lot ceiling', () => {
  const base = {
    confidence: 0.68,
    metaProbability: 0.53,
    netExpectedR: 0.2,
    consensusPassed: 6,
    consensusRequired: 6,
    volatilityScore: 0.35,
  };

  it('keeps ordinary admitted signals at the 0.10 lot ceiling', () => {
    expect(dynamicPaperLotUpperBound(base)).toEqual({ upperBound: 0.1, tier: 'BASE' });
  });

  it('permits larger PAPER ceilings only when confidence, meta probability, EV, consensus and volatility all qualify', () => {
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.71,
        metaProbability: 0.57,
        netExpectedR: 0.2,
      }),
    ).toEqual({ upperBound: 0.2, tier: 'STRONG' });
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.78,
        metaProbability: 0.64,
        netExpectedR: 0.31,
      }),
    ).toEqual({ upperBound: 0.3, tier: 'VERY_STRONG' });
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.84,
        metaProbability: 0.7,
        netExpectedR: 0.45,
        volatilityScore: 0.5,
      }),
    ).toEqual({ upperBound: 0.5, tier: 'EXCEPTIONAL' });
  });

  it('does not upscale on confidence alone', () => {
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.91,
        metaProbability: 0.52,
        netExpectedR: 0.1,
        consensusPassed: 5,
      }),
    ).toEqual({ upperBound: 0.1, tier: 'BASE' });
  });
});

const PAIRS = [
  ['EURUSD', 'EUR/USD'],
  ['GBPUSD', 'GBP/USD'],
  ['USDJPY', 'USD/JPY'],
  ['AUDUSD', 'AUD/USD'],
  ['USDCAD', 'USD/CAD'],
  ['USDCHF', 'USD/CHF'],
] as const;

function trendCandles(base = 1.1, digits = 5, drift = 0.00001, amp = 0.0001) {
  const latestOpen = Math.floor(Date.now() / 300000) * 300000 - 300000;
  return Array.from({ length: 360 }, (_, i) => {
    const close = base + i * drift + Math.sin(i / 2) * amp;
    const range = base > 10 ? 0.01 : 0.00008;
    return {
      timestamp: new Date(latestOpen - (359 - i) * 300000),
      open: close.toFixed(digits),
      high: (close + range).toFixed(digits),
      low: (close - range).toFixed(digits),
      close: close.toFixed(digits),
    };
  });
}

function flatCandles(base: number, digits: number) {
  const latestOpen = Math.floor(Date.now() / 300000) * 300000 - 300000;
  return Array.from({ length: 360 }, (_, i) => {
    const close = base + Math.sin(i / 2) * (base > 10 ? 0.005 : 0.00003);
    const range = base > 10 ? 0.01 : 0.00008;
    return {
      timestamp: new Date(latestOpen - (359 - i) * 300000),
      open: close.toFixed(digits),
      high: (close + range).toFixed(digits),
      low: (close - range).toFixed(digits),
      close: close.toFixed(digits),
    };
  });
}

function payload() {
  const data: Record<string, any> = {};
  for (const [instrument, provider] of PAIRS) {
    const isEur = instrument === 'EURUSD';
    const base =
      instrument === 'USDJPY'
        ? 157
        : instrument === 'GBPUSD'
          ? 1.34
          : instrument === 'USDCAD'
            ? 1.37
            : instrument === 'USDCHF'
              ? 0.8
              : instrument === 'AUDUSD'
                ? 0.66
                : 1.1;
    const digits = instrument === 'USDJPY' ? 3 : 5;
    const rows = isEur ? trendCandles(base, digits) : flatCandles(base, digits);
    data[provider] = {
      status: 'ok',
      meta: { symbol: provider },
      values: rows.map((row) => ({
        datetime: row.timestamp.toISOString().slice(0, 19).replace('T', ' '),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })),
    };
  }
  return data;
}

function allTrendPayload() {
  const data: Record<string, any> = {};
  for (const [instrument, provider] of PAIRS) {
    const base =
      instrument === 'USDJPY'
        ? 157
        : instrument === 'GBPUSD'
          ? 1.34
          : instrument === 'USDCAD'
            ? 1.37
            : instrument === 'USDCHF'
              ? 0.8
              : instrument === 'AUDUSD'
                ? 0.66
                : 1.1;
    const digits = instrument === 'USDJPY' ? 3 : 5;
    const rows =
      instrument === 'USDJPY'
        ? trendCandles(base, digits, 0.001, 0.01)
        : trendCandles(base, digits);
    data[provider] = {
      status: 'ok',
      meta: { symbol: provider },
      values: rows.map((row) => ({
        datetime: row.timestamp.toISOString().slice(0, 19).replace('T', ' '),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })),
    };
  }
  return data;
}

function aiEngineClientMock() {
  return {
    isSchedulerIntegrationEnabled: jest.fn().mockReturnValue(true),
    notifySessionStopped: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function config(values: Record<string, unknown>) {
  return {
    get: jest.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  } as unknown as ConfigService;
}

describe('multi-model PAPER execution gate', () => {
  it('allows an admitted setup when PAPER governance passes even while promotion remains separate', () => {
    expect(
      canExecuteMultiModelPaper({ paperAdmitted: true }, { paperExecutionEligible: true }),
    ).toBe(true);
  });

  it('fails closed when model admission or PAPER governance fails', () => {
    expect(
      canExecuteMultiModelPaper({ paperAdmitted: false }, { paperExecutionEligible: true }),
    ).toBe(false);
    expect(
      canExecuteMultiModelPaper({ paperAdmitted: true }, { paperExecutionEligible: false }),
    ).toBe(false);
  });
});

describe('paired reversal route precedence', () => {
  it('keeps existing execution routes authoritative over paired reversal research on the same pair', () => {
    const existingRoute = {
      candidate: { direction: 'BUY' },
      paperExecutionRoute: 'NORMAL_PAPER',
      netExpectedR: 0.12,
    } as const;
    const pairedResearch = {
      candidate: { direction: 'SELL' },
      paperExecutionRoute: 'PAIRED_REVERSAL_RESEARCH',
      netExpectedR: 0.45,
    } as const;

    expect(prioritizeCounterfactualExecutionRoutes([existingRoute, pairedResearch])).toEqual([
      existingRoute,
    ]);
  });
});

describe('VpsForexSignalCollectorService', () => {
  it('collects every closed M5 slot across the FX 24x5 market week', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const isCollectionSlot = (value: string) =>
      (collector as any).isCollectionSlot(new Date(value)) as boolean;
    const nextEligible = (value: string) =>
      ((collector as any).nextEligibleScanAt(new Date(value)) as Date).toISOString();

    expect(isCollectionSlot('2026-10-05T10:00:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-05T10:05:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-05T10:10:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-05T10:03:00.000Z')).toBe(true);

    expect(isCollectionSlot('2026-10-10T12:00:00.000Z')).toBe(false);
    expect(isCollectionSlot('2026-10-11T20:55:00.000Z')).toBe(false);
    expect(isCollectionSlot('2026-10-11T21:00:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-09T20:55:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-09T21:00:00.000Z')).toBe(false);

    expect(nextEligible('2026-10-05T10:03:00.000Z')).toBe('2026-10-05T10:05:00.000Z');
    expect(nextEligible('2026-10-05T10:05:00.000Z')).toBe('2026-10-05T10:10:00.000Z');
    expect(nextEligible('2026-10-11T20:58:00.000Z')).toBe('2026-10-11T21:00:00.000Z');
    expect(nextEligible('2026-10-09T20:58:00.000Z')).toBe('2026-10-11T21:00:00.000Z');

    const status = await collector.getStatus('user-1');
    expect(status.cadenceMinutes).toBe(5);
    expect(status.timeframe).toBe('M5');
    expect(status.skippedUtcHours).toEqual([]);
  });

  it('builds one read-only pair-side reliability snapshot for all 12 sleeves', async () => {
    const outcome = (status: 'WIN' | 'LOSS', evaluatedAt: string, netR: number) => ({
      evaluated_at: new Date(evaluatedAt),
      instrument: 'USDJPY',
      direction: 'BUY',
      outcome: {
        version: 'm5-first-hit-72bar-net-r-path-v3',
        status,
        resolvedAt: new Date(new Date(evaluatedAt).getTime() + 60_000).toISOString(),
        barsObserved: 1,
        exitPrice: 1,
        grossR: netR,
        netR,
        reason: status === 'WIN' ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
        postEntryTelemetry: null,
      },
    });
    const rows = Array.from({ length: 8 }, (_unused, index) =>
      outcome('WIN', `2026-10-09T${String(10 + index).padStart(2, '0')}:00:00.000Z`, 1.2),
    );
    const dataSource = { query: jest.fn().mockResolvedValue(rows) };
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      dataSource as any,
    );

    const snapshot = await (collector as any).loadPaperTrendPairSideReliabilitySnapshot(
      'user-1',
      'conn-1',
    );

    const cachedSnapshot = await (collector as any).loadPaperTrendPairSideReliabilitySnapshot(
      'user-1',
      'conn-1',
    );

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(cachedSnapshot).toBe(snapshot);
    expect(snapshot).toHaveLength(12);
    expect(
      snapshot.find((row: any) => row.instrument === 'USDJPY' && row.direction === 'BUY'),
    ).toMatchObject({
      state: 'HEALTHY',
      episodes: 8,
      fullSizeEligible: true,
      researchFallbackRequested: false,
      reason: 'PAIR_SIDE_HEALTHY',
    });
    expect(
      snapshot.find((row: any) => row.instrument === 'EURUSD' && row.direction === 'SELL'),
    ).toMatchObject({
      state: 'COLLECTING',
      episodes: 0,
      fullSizeEligible: true,
      researchFallbackRequested: false,
      reason: 'INSUFFICIENT_PAIR_SIDE_EVIDENCE',
    });
  });

  it('builds BUY and SELL counterfactuals from the same market snapshot', () => {
    const candidates = buildDirectionalCandidates('EURUSD', trendCandles());
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.direction))).toEqual(
      new Set(['BUY', 'SELL']),
    );
    const buy = candidates.find((candidate) => candidate.direction === 'BUY')!;
    const sell = candidates.find((candidate) => candidate.direction === 'SELL')!;
    expect(buy.entry).toBeCloseTo(sell.entry, 10);
    expect(buy.barTime.toISOString()).toBe(sell.barTime.toISOString());
    expect(buy.emaSeparation).toBeGreaterThan(sell.emaSeparation);
    expect(buy.mtfStrength).toBeGreaterThan(sell.mtfStrength);
  });

  it('rescues to the opposite direction when only that counterfactual is executable', () => {
    const [buy, sell] = buildDirectionalCandidates('EURUSD', trendCandles());
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    const byDirection = new Map([buy, sell].map((candidate) => [candidate.direction, candidate]));
    const selection = selectCounterfactualExecutionCandidate([
      {
        candidate: byDirection.get('BUY')!,
        paperExecutionEligible: false,
        netExpectedR: -0.05,
        estimatedExecutionCostR: 0.04,
      },
      {
        candidate: byDirection.get('SELL')!,
        paperExecutionEligible: true,
        netExpectedR: 0.16,
        estimatedExecutionCostR: 0.04,
      },
    ]);
    expect(selection.reason).toBe('SINGLE_ELIGIBLE_DIRECTION');
    expect(selection.selected?.candidate.direction).toBe('SELL');
  });

  it('abstains when both directions pass but their net edges are inside execution-cost uncertainty', () => {
    const [buy, sell] = buildDirectionalCandidates('EURUSD', trendCandles());
    const selection = selectCounterfactualExecutionCandidate([
      {
        candidate: buy!,
        paperExecutionEligible: true,
        netExpectedR: 0.14,
        estimatedExecutionCostR: 0.08,
      },
      {
        candidate: sell!,
        paperExecutionEligible: true,
        netExpectedR: 0.13,
        estimatedExecutionCostR: 0.08,
      },
    ]);
    expect(selection.reason).toBe('AMBIGUOUS_DUAL_EDGE');
    expect(selection.selected).toBeNull();
    expect(selection.requiredEdgeMarginR).toBeGreaterThanOrEqual(0.02);
  });

  it('builds a deterministic qualifying trend candidate without claiming model qualification', () => {
    const candidate = buildCandidate('EURUSD', trendCandles());
    expect(candidate).not.toBeNull();
    expect(candidate!.direction).toBe('BUY');
    expect(candidate!.confidence).toBeGreaterThanOrEqual(0.64);
    expect(candidate!.confidence).toBeLessThanOrEqual(0.8);
    expect(candidate!.takeProfit).toBeGreaterThan(candidate!.entry);
    expect(candidate!.stopLoss).toBeLessThan(candidate!.entry);
    const stopPips = Math.abs(candidate!.entry - candidate!.stopLoss) / 0.0001;
    const rewardRisk =
      Math.abs(candidate!.takeProfit - candidate!.entry) /
      Math.abs(candidate!.entry - candidate!.stopLoss);
    expect(stopPips).toBeGreaterThanOrEqual(5);
    expect(rewardRisk).toBeCloseTo(2.5 / 1.5, 6);
  });

  it('classifies repeated unchanged setup as stale telemetry while detecting fresh same-side evidence', () => {
    const candidate = buildCandidate('EURUSD', trendCandles());
    expect(candidate).not.toBeNull();
    const current = candidate!;
    const previous = {
      direction: current.direction,
      confidence: current.confidence,
      entry: current.entry,
      atr: current.atr,
      barTimeMs: current.barTime.getTime() - 10 * 60_000,
    };

    expect(isFreshOpportunity(current, previous)).toBe(false);
    expect(
      isFreshOpportunity(
        {
          ...current,
          entry:
            current.direction === 'BUY'
              ? current.entry + current.atr * 0.6
              : current.entry - current.atr * 0.6,
        },
        previous,
      ),
    ).toBe(true);
    expect(
      isFreshOpportunity({ ...current, confidence: current.confidence + 0.03 }, previous),
    ).toBe(true);
  });

  it('restores freshness and last ensemble state from the durable shadow ledger', async () => {
    const current = buildCandidate('EURUSD', trendCandles());
    expect(current).not.toBeNull();

    const query = jest.fn().mockResolvedValue([
      {
        instrument: 'EURUSD',
        direction: current!.direction,
        entry_price: String(current!.entry),
        atr: String(current!.atr),
        confidence: String(current!.confidence),
        market_bar_time: current!.barTime,
        evaluated_at: new Date(current!.barTime.getTime() + 5 * 60_000),
        admitted: false,
        ensemble_score: '0.41250000',
        meta_probability: '0.40125000',
        expected_r: '0.07000000',
        consensus_passed: 4,
        consensus_required: 6,
        regime: 'TREND_WEAK',
        reasons: ['REGIME_TREND_WEAK'],
      },
    ]);

    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await (collector as any).restorePublishedOpportunities('user-1', 'conn-1');
    const restored = (collector as any).lastPublishedOpportunity.get('EURUSD');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('model_version = $4'), [
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
    ]);
    expect(restored).toBeDefined();
    expect(restored.direction).toBe(current!.direction);
    expect(restored.confidence).toBeCloseTo(current!.confidence, 10);
    expect(restored.entry).toBeCloseTo(current!.entry, 10);
    expect(restored.atr).toBeCloseTo(current!.atr, 10);
    expect(isFreshOpportunity(current!, restored)).toBe(false);
    expect((collector as any).lastEnsembleDecision).toEqual(
      expect.objectContaining({
        instrument: 'EURUSD',
        direction: current!.direction,
        admitted: false,
        candidateConfidence: current!.confidence,
        ensembleScore: 0.4125,
        metaProbability: 0.40125,
        expectedR: 0.07,
        consensusPassed: 4,
        consensusRequired: 6,
        regime: 'TREND_WEAK',
        reasons: ['REGIME_TREND_WEAK'],
      }),
    );
  });

  it('isolates campaign statistics to the current model policy version', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await (collector as any).loadEnsembleCampaignStatus('user-1', 'conn-1');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('model_version = $4'), [
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
    ]);
  });

  it('resolves outcomes for PAPER-executable decisions even when strict promotion admission is false', async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT') && String(sql).includes('ensemble_shadow_decisions')) {
        return [
          {
            id: 'paper-only-decision',
            instrument: 'EURUSD',
            direction: 'BUY',
            market_bar_time: new Date('2026-10-05T10:00:00.000Z'),
            entry_price: '1.1000',
            components: {
              stopLoss: 1.099,
              takeProfit: 1.102,
              governance: {
                paperExecutionEligible: true,
                estimatedExecutionCostR: 0.1,
              },
            },
          },
        ];
      }
      return [];
    });
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );
    const candles = new Map([
      [
        'EURUSD',
        [
          {
            timestamp: new Date('2026-10-05T10:05:00.000Z'),
            open: '1.1000',
            high: '1.1005',
            low: '1.0988',
            close: '1.0991',
          },
        ],
      ],
    ]);

    await (collector as any).resolvePendingEnsembleShadowOutcomes('user-1', 'conn-1', candles);

    const selectSql = String(query.mock.calls[0][0]);
    expect(selectSql).toContain('admitted = true');
    expect(selectSql).toContain('paperExecutionEligible');
    expect(selectSql).toContain('OR COALESCE');
    expect(selectSql).toContain('highConvictionOverlay');
    expect(selectSql).toContain('trendPersistenceShadow');
    expect(selectSql).toContain('allBrokerNative');
    expect(selectSql).toContain("'CONFIRM'");
    expect(selectSql).toContain("'CONFLICT'");
    expect(selectSql).toContain("'ABSTAIN'");
    const updateCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE trading.ensemble_shadow_decisions'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]?.[0]).toBe('paper-only-decision');
    expect(JSON.parse(updateCall?.[1]?.[1] as string)).toMatchObject({
      status: 'LOSS',
      reason: 'STOP_LOSS_HIT',
    });
  });

  it('loads rolling broker P90 spread evidence from sampled MetaApi quotes', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        sample_count: 42,
        spread_price: '0.00001000',
        latest_sample_at: '2026-10-07T11:59:00.000Z',
      },
    ]);
    const collector = createCollector(
      config({
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-source-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const evaluatedAt = new Date('2026-10-07T12:00:00.000Z');
    const evidence = await (collector as any).loadExecutionSpreadEvidence(
      'user-1',
      'EURUSD',
      evaluatedAt,
    );

    expect(evidence).toEqual({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 42,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: '2026-10-07T11:59:00.000Z',
    });
    expect(String(query.mock.calls[0][0])).toContain('percentile_cont(0.90)');
    expect(String(query.mock.calls[0][0])).toContain('market_data.provider_quote_candles');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'metaapi-source-1',
      'EURUSD',
      evaluatedAt.toISOString(),
    ]);
  });

  it('discovers the same user fresh connected MT5 spread source when deployment binding is absent', async () => {
    const evaluatedAt = new Date('2026-10-07T12:00:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ connection_id: 'metaapi-auto-source-1' }])
      .mockResolvedValueOnce([
        {
          sample_count: 18,
          spread_price: '0.00002000',
          latest_sample_at: '2026-10-07T11:59:30.000Z',
        },
      ]);
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const evidence = await (collector as any).loadExecutionSpreadEvidence(
      'user-1',
      'EURUSD',
      evaluatedAt,
    );

    expect(evidence).toMatchObject({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00002,
      sampleCount: 18,
      latestSampleAt: '2026-10-07T11:59:30.000Z',
    });
    const discoverySql = String(query.mock.calls[0][0]);
    expect(discoverySql).toContain('broker.broker_connections');
    expect(discoverySql).toContain("broker_id = 'metatrader5'");
    expect(discoverySql).toContain("status = 'CONNECTED'");
    expect(discoverySql).toContain('c.user_id = $1');
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'EURUSD', evaluatedAt.toISOString()]);
    expect(query.mock.calls[1][1]).toEqual([
      'metaapi-auto-source-1',
      'EURUSD',
      evaluatedAt.toISOString(),
    ]);
  });

  it('builds sleeve qualification evidence from the actual PAPER execution policy cohort', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await (collector as any).loadEnsembleSleeveEvidence('user-1', 'conn-1', 'USDJPY', 'BUY');

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('paperExecutionEligible');
    expect(sql).not.toContain('AND admitted = true');
    expect(sql).toContain('model_version = $6');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      'USDJPY',
      'BUY',
      'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
    ]);
  });

  it('refreshes all six live PAPER feeds but freezes legacy v7 execution during multi-model cutover', async () => {
    const live = new LivePaperMarketDataService();
    expect(live.isLiveConnection('conn-1')).toBe(false);
    const receiveSignal = jest
      .fn()
      .mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED', signalId: 'x' });
    const heartbeat = jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      { getCurrentPriceForConnection: heartbeat } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() });

    await collector.collectOnce(fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'symbol=EUR%2FUSD%2CGBP%2FUSD%2CUSD%2FJPY',
    );
    expect(heartbeat).toHaveBeenCalledTimes(6);
    expect(live.isLiveConnection('conn-1')).toBe(true);
    expect(receiveSignal).not.toHaveBeenCalled();
    expect(shadowQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO trading.ensemble_shadow_decisions'),
      expect.arrayContaining(['user-1', 'session-1', 'conn-1', 'irexpro-multimodel-ensemble-v1']),
    );
    expect((collector as any).lastEnsembleDecision.evaluatedAt).toBeInstanceOf(Date);
    expect((collector as any).lastEnsembleDecision.instrument).toBe('EURUSD');
    expect((collector as any).lastEnsembleDecision.consensusRequired).toBeGreaterThan(0);
    expect(live.getOHLCV('EURUSD', 'M5', 70, 'conn-1')).toHaveLength(70);
  });

  it.each([-1, 1])(
    'sends raw market momentum to both model directions for a %s price impulse while preserving aligned telemetry',
    async (impulseSign) => {
      const live = new LivePaperMarketDataService();
      const shadowQuery = jest.fn().mockResolvedValue([]);
      const modelSpy = jest.spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow');
      const governanceSpy = jest.spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance');
      const collector = createCollector(
        config({
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.apiKey': 'fixture-key-123456',
          'vpsForexScanner.userId': 'user-1',
          'vpsForexScanner.brokerConnectionId': 'conn-1',
        }),
        { receiveSignal: jest.fn() } as unknown as AiSignalService,
        {
          getActiveSession: jest.fn().mockResolvedValue({
            id: 'session-1',
            brokerConnectionId: 'conn-1',
            executionMode: ExecutionMode.PAPER_ONLY,
          }),
        } as unknown as ExecutionService,
        {
          getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        } as unknown as BrokerService,
        live,
        aiEngineClientMock(),
        { query: shadowQuery } as any,
      );
      const market = allTrendPayload();
      const latest = market['EUR/USD'].values[359];
      const previous = market['EUR/USD'].values[358];
      const close = Number(previous.close) + impulseSign * 0.00012;
      latest.close = close.toFixed(5);
      latest.open = latest.close;
      latest.high = (close + 0.00008).toFixed(5);
      latest.low = (close - 0.00008).toFixed(5);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => market,
      });

      try {
        await collector.collectOnce(fetchMock as unknown as typeof fetch);
        const candles = live.getOHLCV('EURUSD', 'M5', 360, 'conn-1');
        const candidates = buildDirectionalCandidates('EURUSD', candles);
        const expectedRawMomentum =
          (Number(latest.close) - Number(previous.close)) / candidates[0]!.atr;
        expect(Math.sign(expectedRawMomentum)).toBe(impulseSign);

        for (const direction of ['BUY', 'SELL'] as const) {
          const modelInput = modelSpy.mock.calls.find(
            ([input]) => input.instrument === 'EURUSD' && input.direction === direction,
          )?.[0];
          const governanceInput = governanceSpy.mock.calls.find(
            ([input]) => input.instrument === 'EURUSD' && input.direction === direction,
          )?.[0];
          expect(modelInput).toBeDefined();
          expect(governanceInput).toBeDefined();
          expect(modelInput!.shortHorizonMomentumAtr).toBeCloseTo(expectedRawMomentum, 10);
          expect(governanceInput!.shortHorizonMomentumAtr).toBeCloseTo(expectedRawMomentum, 10);
          if (direction === 'SELL') {
            const reversalScore = PlanBEnsembleModule.scorePlanBMultimodelShadow({
              ...modelInput!,
              confidence: 0.66,
              extensionAtr: 0.8,
              volatilityScore: 0.1,
              emaSeparation: 0.15,
              mtfStrength: 0.05,
              rsi14: 42,
              scanTime: new Date('2026-10-12T14:05:00.000Z'),
            });
            expect(reversalScore.regime).toBe(
              impulseSign === -1 ? 'REVERSAL_CONFIRMED' : 'TREND_WEAK',
            );
            expect(reversalScore.paperAdmitted).toBe(impulseSign === -1);
          }
          const ledgerCall = shadowQuery.mock.calls.find(
            ([sql, params]) =>
              String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions') &&
              params[6] === 'EURUSD' &&
              params[7] === direction,
          );
          expect(ledgerCall).toBeDefined();
          const components = JSON.parse(String(ledgerCall![1][23]));
          const expectedAlignedMomentum = (direction === 'BUY' ? 1 : -1) * expectedRawMomentum;
          expect(components.shortHorizonMomentumAtr).toBeCloseTo(expectedAlignedMomentum, 10);
          expect(components.trendPersistenceShadow.shortHorizonMomentumAtr).toBeCloseTo(
            expectedAlignedMomentum,
            10,
          );
        }
      } finally {
        modelSpy.mockRestore();
        governanceSpy.mockRestore();
      }
    },
  );

  it('blocks otherwise admitted PAPER entries when the latest broker close invalidated the current bar', async () => {
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const query = jest.fn().mockImplementation(async (sql: string) =>
      sql.includes('paper_post_loss_state_available')
        ? [
            {
              paper_post_loss_state_available: true,
              trade_id: 'loss-1',
              close_reason: 'STOP_LOSS_HIT',
              closed_at: new Date(Date.now() - 60_000),
              reconfirmed: false,
            },
          ]
        : [],
    );
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const modelSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => ({
        ...actualPlanB(input, positions),
        paperAdmitted: input.instrument === 'EURUSD' && input.direction === 'BUY',
        admitted: input.instrument === 'EURUSD' && input.direction === 'BUY',
        expectedR: 0.8,
        strategyRoute: 'TREND_CONTINUATION',
      }));
    const actualGovernance = EnsembleGovernanceModule.evaluateEnsembleGovernance;
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => ({
        ...actualGovernance(input),
        paperExecutionEligible: true,
        paperExecutionBlockers: [],
        netExpectedR: 0.7,
        eventRisk: 'CLEAR',
        driftState: 'NORMAL',
        executionSpreadEvidenceValid: true,
      }));
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'fixture-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );
    try {
      await collector.collectOnce(
        jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => allTrendPayload(),
        }) as unknown as typeof fetch,
      );
      expect(receiveSignal).not.toHaveBeenCalled();
      const insert = query.mock.calls.find(
        ([sql, params]) =>
          String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions') &&
          params[6] === 'EURUSD' &&
          params[7] === 'BUY',
      );
      expect(insert).toBeDefined();
      const components = JSON.parse(String(insert![1][23]));
      expect(components.paperPostLossEntryGuard).toMatchObject({
        eligible: false,
        reason: 'WAITING_FOR_POST_LOSS_BAR',
      });
      expect(components.governance.paperExecutionBlockers).toContain(
        'PAPER_POST_LOSS_WAITING_FOR_POST_LOSS_BAR',
      );
    } finally {
      modelSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('evaluates every qualifying pair in the same scan instead of only the top-ranked pair', async () => {
    const live = new LivePaperMarketDataService();
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => allTrendPayload() });

    await collector.collectOnce(fetchMock as unknown as typeof fetch);

    const insertCalls = shadowQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions'),
    );
    expect(insertCalls.length).toBeGreaterThan(1);
    const persistedInstruments = new Set(insertCalls.map(([, params]) => params[6]));
    expect(persistedInstruments.size).toBe(6);
    expect(insertCalls).toHaveLength(12);
    for (const instrument of persistedInstruments) {
      const directions = insertCalls
        .filter(([, params]) => params[6] === instrument)
        .map(([, params]) => params[7]);
      expect(new Set(directions)).toEqual(new Set(['BUY', 'SELL']));
    }
    for (const [, params] of insertCalls) {
      const components = JSON.parse(String(params[23]));
      expect(components.trendPersistenceShadow).toMatchObject({
        artifact: 'trend-persistence-shadow-v1',
        executionAuthority: 'NONE',
        modifiesExecution: false,
      });
    }
  });

  it('routes an evidence-qualified rejected-edge canary to PAPER with RESEARCH sizing and research-only metadata', async () => {
    const live = new LivePaperMarketDataService();
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const evidence = {
      global30m: { samples: 15, positive: 12, avgR: 1.088, minR: -0.381, maxR: 5.786 },
      pairSide30m: { samples: 2, positive: 1, avgR: 0.254, minR: -0.381, maxR: 0.888 },
    };
    const getRejectedEdgeCanaryEvidence = jest.fn().mockResolvedValue(evidence);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const canaryTarget = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          ...base,
          strategyRoute: 'TREND_CONTINUATION',
          portfolioQuality: 1,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: canaryTarget ? 5 : 3,
          consensusRequired: 6,
          metaProbability: canaryTarget ? 0.5 : 0.35,
          expectedR: canaryTarget ? 0.25 : -0.2,
          ensembleScore: canaryTarget ? 0.62 : 0.3,
          reasons: canaryTarget ? ['ENSEMBLE_CONSENSUS'] : ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const canaryTarget = input.instrument === 'EURUSD' && input.ensemble.expectedR > 0;
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: canaryTarget ? 0.25 : -0.2,
          estimatedExecutionCostR: 0.03,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: canaryTarget ? 0.22 : -0.23,
          paperNetExpectedRPassed: canaryTarget,
          netExpectedRPassed: canaryTarget,
          driftState: 'OUT_OF_DISTRIBUTION',
          driftQuality: 0.2,
          paperDriftPassed: false,
          driftPassed: false,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: canaryTarget
            ? [
                'ENSEMBLE_NOT_PAPER_ADMITTED',
                'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
                'DRIFT_OUT_OF_DISTRIBUTION',
              ]
            : ['PAPER_NET_EXPECTED_R'],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'DRIFT_OUT_OF_DISTRIBUTION', 'SLEEVE_COLLECTING'],
        };
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
      { getRejectedEdgeCanaryEvidence } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 30,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date().toISOString(),
    });

    try {
      const canaryPayload = allTrendPayload();
      const eurUsdValues = canaryPayload['EUR/USD'].values;
      const previousClose = Number(eurUsdValues.at(-2)!.close);
      const confirmedClose = previousClose + 0.00008;
      eurUsdValues[eurUsdValues.length - 1] = {
        ...eurUsdValues.at(-1)!,
        open: previousClose.toFixed(5),
        high: (confirmedClose + 0.00008).toFixed(5),
        low: (previousClose - 0.00008).toFixed(5),
        close: confirmedClose.toFixed(5),
      };
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => canaryPayload });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);

      expect(getRejectedEdgeCanaryEvidence).toHaveBeenCalledWith('user-1', 'EURUSD', 'BUY');
      expect(receiveSignal).toHaveBeenCalledTimes(1);
      expect(receiveSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          instrument: 'EURUSD',
          direction: 'BUY',
          suggestedVolume: 0.1,
          modelVersion:
            'external-provider/irexpro-multimodel-ensemble-v1/paper-rejected-edge-canary-v1',
          metadata: expect.objectContaining({
            rejected_edge_canary: true,
            rejected_edge_canary_artifact: 'rejected-edge-paper-canary-v1',
            main_strategy_qualification_evidence: false,
            production_eligible: false,
            position_sizing_tier: 'RESEARCH',
          }),
        }),
      );
    } finally {
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('routes momentum-confirmed exploration research-throughput to PAPER execution without qualification authority', async () => {
    const live = new LivePaperMarketDataService();
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          ...base,
          strategyRoute: 'TREND_CONTINUATION',
          portfolioQuality: 1,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: target ? 5 : 3,
          consensusRequired: 6,
          directionQuality: target ? 0 : 0.2,
          tradeQuality: target ? 0.44 : 0.2,
          exitQuality: target ? 0.43 : 0.2,
          metaProbability: target ? 0.5 : 0.35,
          expectedR: target ? 0.25 : -0.2,
          ensembleScore: target ? 0.62 : 0.3,
          reasons: target ? ['ENSEMBLE_CONSENSUS'] : ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target = input.instrument === 'EURUSD' && input.ensemble.expectedR > 0;
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: target ? 0.25 : -0.2,
          estimatedExecutionCostR: 0.03,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: target ? 0.22 : -0.23,
          paperNetExpectedRPassed: target,
          netExpectedRPassed: target,
          driftState: 'OUT_OF_DISTRIBUTION',
          driftQuality: 0.2,
          paperDriftPassed: false,
          driftPassed: false,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: target
            ? [
                'ENSEMBLE_NOT_PAPER_ADMITTED',
                'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
                'DRIFT_OUT_OF_DISTRIBUTION',
              ]
            : ['PAPER_NET_EXPECTED_R'],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'SLEEVE_COLLECTING'],
        };
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 30,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date().toISOString(),
    });
    jest.spyOn(collector as any, 'loadPaperResearchEpisodeState').mockResolvedValue({
      previousEpisodeKey: null,
      previousTradeStatus: null,
      previousClosedAt: null,
    });
    const logSpy = jest.spyOn((collector as any).logger, 'log');

    try {
      const directionConfirmedPayload = allTrendPayload();
      const eurusdRows = directionConfirmedPayload['EUR/USD'].values;
      const previousClose = Number(eurusdRows[eurusdRows.length - 2]!.close);
      const directionConfirmedClose = previousClose + 0.00008;
      eurusdRows[eurusdRows.length - 1] = {
        ...eurusdRows[eurusdRows.length - 1],
        open: previousClose.toFixed(5),
        high: (directionConfirmedClose + 0.00008).toFixed(5),
        low: (previousClose - 0.00008).toFixed(5),
        close: directionConfirmedClose.toFixed(5),
      };
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => directionConfirmedPayload,
      });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);
      expect(receiveSignal).toHaveBeenCalledTimes(1);
      expect(receiveSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          instrument: 'EURUSD',
          direction: 'BUY',
          suggestedVolume: 0.01,
          modelVersion:
            'external-provider/irexpro-multimodel-ensemble-v1/paper-research-throughput-v8-momentum-confirmed-exploration',
          metadata: expect.objectContaining({
            paper_execution_route: 'PAPER_RESEARCH_THROUGHPUT',
            paper_research_throughput: true,
            paper_research_throughput_qualification_evidence: false,
            paper_research_throughput_execution_authority: 'PAPER_ONLY_RESEARCH',
            paper_research_throughput_reason: 'RESEARCH_EXPLORATION_CANDIDATE',
            main_strategy_qualification_evidence: false,
            production_eligible: false,
            position_sizing_tier: 'RESEARCH',
          }),
        }),
      );
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'PAPER research-throughput EURUSD BUY execution=ELIGIBLE executionAuthority=PAPER_ONLY_RESEARCH',
          ),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('routes only the paired opposite-side winner into tiny reversal research without qualification authority', async () => {
    const live = new LivePaperMarketDataService();
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const actualMeta = V8ShadowMetaModule.scorePlanBShadowMeta;
    const actualPaired = PairedDirectionReversalModule.evaluatePairedDirectionReversal;

    const metaSpy = jest
      .spyOn(V8ShadowMetaModule, 'scorePlanBShadowMeta')
      .mockImplementation((input) => {
        const base = actualMeta(input);
        if (input.instrument !== 'EURUSD') return base;
        const probability = input.direction === 'BUY' ? 0.4 : 0.58;
        return {
          ...base,
          probability,
          expectedR: probability * (2.5 / 1.5) - (1 - probability),
          admitted: input.direction === 'SELL',
          reason: input.direction === 'SELL' ? 'ADMIT' : 'REJECT_EXPECTED_VALUE',
        };
      });
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target = input.instrument === 'EURUSD';
        return {
          ...base,
          regime: target ? 'TREND_WEAK' : base.regime,
          strategyRoute: 'TREND_CONTINUATION',
          regimeAllowed: false,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: target ? 4 : 2,
          consensusRequired: 6,
          directionQuality: target ? 0.45 : 0.2,
          tradeQuality: target ? 0.5 : 0.2,
          exitQuality: target ? 0.5 : 0.2,
          metaProbability: target ? (input.direction === 'BUY' ? 0.4 : 0.58) : 0.3,
          expectedR: target ? -0.1 : -0.3,
          ensembleScore: target ? 0.48 : 0.25,
          reasons: ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target = input.instrument === 'EURUSD';
        const pairedReversalDrift = input.driftRoute === 'PAIRED_REVERSAL_RESEARCH';
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: -0.1,
          estimatedExecutionCostR: 0.03,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: -0.13,
          paperNetExpectedRPassed: false,
          netExpectedRPassed: false,
          driftState: target
            ? pairedReversalDrift
              ? 'NORMAL'
              : 'OUT_OF_DISTRIBUTION'
            : 'OUT_OF_DISTRIBUTION',
          driftQuality: target && pairedReversalDrift ? 0.8 : 0.1,
          paperDriftPassed: target && pairedReversalDrift,
          driftPassed: target && pairedReversalDrift,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: [
            'ENSEMBLE_NOT_PAPER_ADMITTED',
            'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
            'PAPER_NET_EXPECTED_R',
            'DRIFT_OUT_OF_DISTRIBUTION',
          ],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'NET_EXPECTED_R', 'SLEEVE_COLLECTING'],
        };
      });
    const pairedSpy = jest
      .spyOn(PairedDirectionReversalModule, 'evaluatePairedDirectionReversal')
      .mockImplementation((input) => {
        if (input.buyProbability === 0.4 && input.sellProbability === 0.58) {
          return {
            buyDirectionalProbability: 0.326,
            sellDirectionalProbability: 0.674,
            preferredDirection: 'SELL',
            preferredAbsoluteProbability: 0.58,
            directionalEdge: 0.348,
            alignedMomentumAtr: 0.4,
            researchNetExpectedR: 0.31,
            reversalCandidate: true,
            reason: 'PAIRED_REVERSAL_CANDIDATE',
          };
        }
        return actualPaired(input);
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 30,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date().toISOString(),
    });

    try {
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => allTrendPayload() });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);

      expect(governanceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          driftRoute: 'PAIRED_REVERSAL_RESEARCH',
          paperSimulationSpreadPrice: 0.0001,
        }),
      );
      expect(receiveSignal).toHaveBeenCalledTimes(1);
      expect(receiveSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          instrument: 'EURUSD',
          direction: 'SELL',
          suggestedVolume: 0.01,
          modelVersion:
            'external-provider/irexpro-multimodel-ensemble-v1/paper-paired-reversal-research-v1',
          metadata: expect.objectContaining({
            paper_execution_route: 'PAIRED_REVERSAL_RESEARCH',
            paired_reversal_research: true,
            paired_reversal_research_qualification_evidence: false,
            paired_reversal_preferred_direction: 'SELL',
            paired_reversal_research_net_expected_r: 0.31,
            paired_reversal_drift_state: 'NORMAL',
            main_strategy_qualification_evidence: false,
            production_eligible: false,
            position_sizing_tier: 'RESEARCH',
          }),
        }),
      );
    } finally {
      metaSpy.mockRestore();
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
      pairedSpy.mockRestore();
    }
  });

  it('loads trend-route reliability from episode-collapsed predecessor/current policy shadow evidence', async () => {
    const outcome = (status: 'WIN' | 'LOSS', evaluatedAt: string, resolvedAt: string) => ({
      instrument: status === 'WIN' ? 'EURUSD' : 'USDJPY',
      direction: 'BUY',
      evaluated_at: evaluatedAt,
      outcome: {
        version: 'test',
        status,
        resolvedAt,
        barsObserved: 1,
        exitPrice: 1,
        grossR: status === 'WIN' ? 1.5 : -1,
        netR: status === 'WIN' ? 1.45 : -1.05,
        reason: status === 'WIN' ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
        postEntryTelemetry: null,
      },
    });
    const query = jest
      .fn()
      .mockResolvedValue([
        outcome('WIN', '2026-10-09T10:00:00Z', '2026-10-09T10:20:00Z'),
        outcome('WIN', '2026-10-09T10:05:00Z', '2026-10-09T10:25:00Z'),
        outcome('LOSS', '2026-10-09T10:02:00Z', '2026-10-09T10:10:00Z'),
      ]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const result = await (collector as any).loadPaperTrendRouteReliabilityEvidence(
      'user-1',
      'conn-1',
    );
    expect(result.closedTrades).toBe(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("components->>'strategyRoute' = 'TREND_CONTINUATION'");
    expect(sql).toContain('model_version = ANY($4::text[])');
    expect(params.slice(0, 3)).toEqual(['user-1', 'conn-1', 'irexpro-multimodel-ensemble-v1']);
    expect(params[3]).toEqual([
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1',
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1',
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1-trend-route-reliability-v1',
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v3-directional-momentum-wiring-v1-throughput-shadow-only-v1-trend-route-reliability-v1-pair-side-route-reliability-v1',
      'planb-v4-bi2-et2-nm2-hp3-dmw1-ts1-trr1-psrr1',
      'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
    ]);
  });
  it('loads pair-side continuation reliability from independent episode-collapsed shadow evidence', async () => {
    const row = (status: 'WIN' | 'LOSS', evaluatedAt: string, resolvedAt: string) => ({
      instrument: 'EURUSD',
      direction: 'SELL',
      evaluated_at: evaluatedAt,
      outcome: {
        version: 'test',
        status,
        resolvedAt,
        barsObserved: 1,
        exitPrice: 1,
        grossR: status === 'WIN' ? 1.5 : -1,
        netR: status === 'WIN' ? 1.45 : -1.05,
        reason: status === 'WIN' ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
        postEntryTelemetry: null,
      },
    });
    const query = jest
      .fn()
      .mockResolvedValue([
        row('WIN', '2026-10-09T10:00:00Z', '2026-10-09T10:20:00Z'),
        row('WIN', '2026-10-09T10:05:00Z', '2026-10-09T10:25:00Z'),
        row('LOSS', '2026-10-09T10:30:00Z', '2026-10-09T10:40:00Z'),
      ]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const result = await (collector as any).loadPaperTrendPairSideReliabilityEvidence(
      'user-1',
      'conn-1',
      'EURUSD',
      'SELL',
    );
    expect(result.closedTrades).toBe(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('instrument = $5');
    expect(sql).toContain('direction = $6');
    expect(params.slice(0, 3)).toEqual(['user-1', 'conn-1', 'irexpro-multimodel-ensemble-v1']);
    expect(params[4]).toBe('EURUSD');
    expect(params[5]).toBe('SELL');
  });

  it('loads pair-side research reliability only from the active episode-guarded research artifact', async () => {
    const query = jest.fn().mockResolvedValue([{ wins: '1', losses: '5' }]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await expect(
      (collector as any).loadPaperResearchPairSideEvidence('user-1', 'conn-1', 'GBPUSD', 'SELL'),
    ).resolves.toEqual({ wins: 1, losses: 5 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("paper_research_throughput_artifact' = ANY($5::text[])"),
      [
        'user-1',
        'conn-1',
        'GBPUSD',
        'SELL',
        [
          'paper-research-throughput-v2-episode-guarded',
          'paper-research-throughput-v3-episode-guarded',
          'paper-research-throughput-v4-pair-side-reliability',
          'paper-research-throughput-v5-controlled-execution',
          'paper-research-throughput-v6-controlled-exploration',
          'paper-research-throughput-v7-edge-tiered-exploration',
          'paper-research-throughput-v8-momentum-confirmed-exploration',
        ],
        expect.any(String),
      ],
    );
  });

  it('persists shadow evidence without an active PAPER session and keeps execution disabled', async () => {
    const live = new LivePaperMarketDataService();
    const receiveSignal = jest.fn();
    const heartbeat = jest.fn();
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      { getCurrentPriceForConnection: heartbeat } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() });

    await collector.collectOnce(fetchMock as unknown as typeof fetch);

    expect(receiveSignal).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(live.getQuote('EURUSD', 20 * 60_000, 'conn-1').bid).toBeTruthy();
    expect(live.isLiveConnection('conn-1')).toBe(false);
    expect(shadowQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO trading.ensemble_shadow_decisions'),
      expect.arrayContaining(['user-1', null, 'conn-1', 'irexpro-multimodel-ensemble-v1']),
    );
    expect((collector as any).lastEnsembleDecision.evaluatedAt).toBeInstanceOf(Date);
    expect((collector as any).lastEnsembleDecision.instrument).toBe('EURUSD');
  });

  it('does not block API bootstrap while startup market priming is unresolved', async () => {
    const live = new LivePaperMarketDataService();
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      {} as unknown as BrokerService,
      live,
      aiEngineClientMock(),
    );
    jest.spyOn(collector as any, 'marketSchedule').mockReturnValue({
      paused: false,
      reason: null,
      nextEligibleScanAt: '2026-10-12T11:45:00.000Z',
    });
    let releasePrime!: () => void;
    const primeGate = new Promise<void>((resolve) => {
      releasePrime = resolve;
    });
    const primeSpy = jest.spyOn(collector as any, 'primeMarketData').mockReturnValue(primeGate);
    const initPromise = collector.onModuleInit();

    try {
      const state = await Promise.race([
        initPromise.then(() => 'RESOLVED' as const),
        new Promise<'BLOCKED'>((resolve) => setTimeout(() => resolve('BLOCKED'), 75)),
      ]);
      expect(state).toBe('RESOLVED');
      expect(primeSpy).toHaveBeenCalledWith('real-key-123456', 'conn-1');
      expect(live.isLiveConnection('conn-1')).toBe(true);
      expect(() => live.getQuote('EURUSD', 20 * 60_000, 'conn-1')).toThrow();
      const collectSpy = jest.spyOn(collector, 'collectOnce').mockResolvedValue();
      await collector.maybeCollect(new Date('2026-10-12T11:45:00.000Z'));
      expect(collectSpy).not.toHaveBeenCalled();
    } finally {
      releasePrime();
      await initPromise;
      const startupPrime = (collector as any).startupPrimePromise as Promise<void> | null;
      if (startupPrime) await startupPrime;
      collector.onModuleDestroy();
    }
  });

  it('stops a legacy scheduler job for the exact active PAPER session on scanner startup', async () => {
    const live = new LivePaperMarketDataService();
    const aiEngine = aiEngineClientMock();
    const execution = {
      getActiveSession: jest.fn().mockResolvedValue({
        id: 'session-1',
        brokerConnectionId: 'conn-1',
        executionMode: ExecutionMode.PAPER_ONLY,
      }),
    } as unknown as ExecutionService;
    const startupHeartbeat = jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' });
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      execution,
      { getCurrentPriceForConnection: startupHeartbeat } as unknown as BrokerService,
      live,
      aiEngine,
    );

    jest.spyOn(collector as any, 'marketSchedule').mockReturnValue({
      paused: false,
      reason: null,
      nextEligibleScanAt: '2026-10-02T20:30:00.000Z',
    });
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() } as Response);

    await collector.onModuleInit();
    const startupPrime = (collector as any).startupPrimePromise as Promise<void> | null;
    if (startupPrime) await startupPrime;

    expect(aiEngine.notifySessionStopped).toHaveBeenCalledWith({ tradingSessionId: 'session-1' });
    expect(live.isLiveConnection('conn-1')).toBe(true);
    expect(live.status('conn-1').cachedInstrumentCount).toBe(6);
    expect(startupHeartbeat).toHaveBeenCalledTimes(6);

    collector.onModuleDestroy();
    fetchSpy.mockRestore();
    expect(live.isLiveConnection('conn-1')).toBe(false);
  });

  it('reuses a successful six-pair provider batch within the same UTC minute', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-1');
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const heartbeat = jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' });
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      { getCurrentPriceForConnection: heartbeat } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() });

    await collector.collectOnce(fetchMock as unknown as typeof fetch);
    await collector.collectOnce(fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(12);
  });

  it('primes all six pairs once, then refreshes only two pairs per M5 slot while retaining a coherent six-pair snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00.000Z'));
    try {
      const collector = createCollector(
        config({
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.apiKey': 'real-key-123456',
          'vpsForexScanner.userId': 'user-1',
          'vpsForexScanner.brokerConnectionId': 'conn-1',
        }),
        { receiveSignal: jest.fn() } as unknown as AiSignalService,
        { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
        {} as unknown as BrokerService,
        new LivePaperMarketDataService(),
        aiEngineClientMock(),
      );
      const fullPayload = payload();
      const requestedBatches: string[][] = [];
      const fetchMock = jest.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const requested = (url.searchParams.get('symbol') ?? '').split(',').filter(Boolean);
        requestedBatches.push(requested);
        const body = Object.fromEntries(requested.map((symbol) => [symbol, fullPayload[symbol]]));
        return new Response(JSON.stringify(body), { status: 200 });
      });

      const startup = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );
      expect(startup.size).toBe(6);
      expect(requestedBatches[0]).toEqual(PAIRS.map(([, provider]) => provider));

      jest.setSystemTime(new Date('2026-10-13T00:05:00.000Z'));
      const slotOne = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );
      jest.setSystemTime(new Date('2026-10-13T00:10:00.000Z'));
      const slotTwo = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );
      jest.setSystemTime(new Date('2026-10-13T00:15:00.000Z'));
      const slotThree = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );

      expect(requestedBatches.slice(1)).toEqual([
        ['USD/JPY', 'AUD/USD'],
        ['USD/CAD', 'USD/CHF'],
        ['EUR/USD', 'GBP/USD'],
      ]);
      expect(requestedBatches.slice(1).every((batch) => batch.length === 2)).toBe(true);
      for (const snapshot of [slotOne, slotTwo, slotThree]) {
        expect([...snapshot.keys()].sort()).toEqual(PAIRS.map(([instrument]) => instrument).sort());
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the steady-state Twelve Data budget below the 800-credit Basic daily allowance', () => {
    const fiveMinuteSlotsPerDay = (24 * 60) / 5;
    const steadyStateCredits = fiveMinuteSlotsPerDay * 2;
    const startupPrimeCredits = PAIRS.length;
    expect(steadyStateCredits).toBe(576);
    expect(steadyStateCredits + startupPrimeCredits).toBeLessThan(800);
  });

  it('reports PAPER authority waiting for a PAPER session when observation data is ready', async () => {
    const live = new LivePaperMarketDataService();
    for (const [instrument] of PAIRS) {
      const base =
        instrument === 'USDJPY'
          ? 157
          : instrument === 'GBPUSD'
            ? 1.34
            : instrument === 'USDCAD'
              ? 1.37
              : instrument === 'USDCHF'
                ? 0.8
                : instrument === 'AUDUSD'
                  ? 0.66
                  : 1.1;
      live.updateClosedCandles(
        instrument,
        trendCandles(base, instrument === 'USDJPY' ? 3 : 5),
        'conn-1',
      );
    }
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      {} as unknown as BrokerService,
      live,
      aiEngineClientMock(),
    );
    jest.spyOn(collector as any, 'marketSchedule').mockReturnValue({
      paused: false,
      reason: null,
      nextEligibleScanAt: '2026-10-05T10:10:00.000Z',
    });

    const status = await collector.getStatus('user-1');

    expect(status.activePaperSession).toBe(false);
    expect(status.marketCache.cachedInstrumentCount).toBe(6);
    expect(status.executionAuthority).toBe('PAPER_ONLY');
    expect(status.state).toBe('WAITING_FOR_PAPER_SESSION');
  });

  it('uses the full FX 24x5 session instead of pausing every weekday night', () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );

    const saturday = (collector as any).marketSchedule(new Date('2026-10-03T00:21:00.000Z'));
    expect(saturday).toEqual({
      paused: true,
      reason: 'WEEKEND',
      nextEligibleScanAt: '2026-10-04T21:00:00.000Z',
    });

    expect((collector as any).marketSchedule(new Date('2026-10-04T20:50:00.000Z')).paused).toBe(
      true,
    );
    expect((collector as any).marketSchedule(new Date('2026-10-04T21:00:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-10-05T22:10:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-10-09T20:50:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-10-09T21:00:00.000Z')).paused).toBe(
      true,
    );

    // New York switches back to EST in November. Weekly open/close must
    // continue to follow 17:00 America/New_York instead of a fixed UTC hour.
    expect((collector as any).marketSchedule(new Date('2026-12-06T21:55:00.000Z')).paused).toBe(
      true,
    );
    expect((collector as any).marketSchedule(new Date('2026-12-06T22:00:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-12-11T21:55:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-12-11T22:00:00.000Z')).paused).toBe(
      true,
    );
  });

  it('bounds broker-native six-pair history concurrency below the MetaApi per-account limit', async () => {
    let active = 0;
    let peak = 0;
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({ brokerId: 'metatrader5' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          const base = instrument === 'USDJPY' ? 157 : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );

    const series = await (collector as any).fetchBrokerNativeFallbackSeries('TEST_RATE_LIMIT');

    expect(series.size).toBe(6);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('discovers the same user connected MT5 source for broker-native history when deployment binding is absent', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'metaapi-auto-source-1' }]);
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({ brokerId: 'metatrader5' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          const base = instrument === 'USDJPY' ? 157 : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'paper-conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const series = await (collector as any).fetchBrokerNativeFallbackSeries('DAILY_CREDIT_LIMIT');

    expect(series.size).toBe(6);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("broker_id = 'metatrader5'"), [
      'user-1',
    ]);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledWith(
      'user-1',
      'metaapi-auto-source-1',
      expect.any(String),
      'M5',
      expect.any(Number),
    );
  });

  it('fails over to broker-native MetaTrader candles after Twelve Data exhausts the daily quota', async () => {
    const live = new LivePaperMarketDataService();
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({ brokerId: 'metatrader5' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          const base =
            instrument === 'USDJPY'
              ? 157
              : instrument === 'GBPUSD'
                ? 1.34
                : instrument === 'USDCAD'
                  ? 1.37
                  : instrument === 'USDCHF'
                    ? 0.8
                    : instrument === 'AUDUSD'
                      ? 0.66
                      : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      live,
      aiEngineClientMock(),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        status: 'error',
        message:
          'You have run out of API credits for the day. The current limit being 800 API credits per day.',
      }),
    });

    const series = await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      fetchMock as unknown as typeof fetch,
    );
    const status = await collector.getStatus('user-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(series.size).toBe(6);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(6);
    expect(status.providerCooldownReason).toBe('DAILY_CREDIT_LIMIT');
    expect(status.providerCooldownUntil).toBeTruthy();
    expect(status.marketDataAuthority).toBe('METAAPI_BROKER_FALLBACK');
    expect(status.providerFallbackActive).toBe(true);
  });

  it('reuses broker-native fallback within the minute while daily cooldown is active', async () => {
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({ brokerId: 'metatrader5' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          const base = instrument === 'USDJPY' ? 157 : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        status: 'error',
        message: 'You have run out of API credits for the day.',
      }),
    });

    await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      fetchMock as unknown as typeof fetch,
    );
    await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(6);
  });

  it('fails closed when both Twelve Data quota and broker-native fallback are unavailable', async () => {
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({ brokerId: 'metatrader5' }),
      getOhlcvForConnection: jest.fn().mockRejectedValue(new Error('broker candles unavailable')),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        status: 'error',
        message: 'You have run out of API credits for the day.',
      }),
    });

    await expect(
      (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/broker-native fallback failed/);
  });

  it('rejects the shared Twelve Data demo key for production evidence', async () => {
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'demo',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    await expect(collector.collectOnce(jest.fn() as unknown as typeof fetch)).rejects.toThrow(
      /production Twelve Data key/,
    );
  });
});

describe('scheduled scan recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T10:03:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  function scanner() {
    return createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
  }
  function goodFeed() {
    return new Response(JSON.stringify(allTrendPayload()), { status: 200 });
  }
  it('evaluates the current closed-bar slot after a restart between boundaries, only once per slot', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => goodFeed());
    const collector = scanner();
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe('2026-10-12T10:03:00.000Z');
    jest.setSystemTime(new Date('2026-10-12T10:04:15.000Z'));
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe('2026-10-12T10:03:00.000Z');
    jest.setSystemTime(new Date('2026-10-12T10:05:00.000Z'));
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe('2026-10-12T10:05:00.000Z');
  });
  it('recovers a failed slot after one minute without retrying on every 15-second timer tick', async () => {
    jest.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'feed unavailable' }), { status: 503 }),
      )
      .mockImplementation(async () => goodFeed());
    const collector = scanner();
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBeNull();
    jest.setSystemTime(new Date('2026-10-12T10:00:15.000Z'));
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBeNull();
    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe('2026-10-12T10:01:00.000Z');
  });
  it('cancels the pending initial scan when the scanner is destroyed', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => goodFeed());
    const collector = scanner();
    await collector.onModuleInit();
    const primedAt = (await collector.getStatus('user-1')).lastEvaluatedAt;
    collector.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(2_000);
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe(primedAt);
  });
  it('keeps recovery paused during the weekend', async () => {
    jest.setSystemTime(new Date('2026-10-10T10:03:00.000Z'));
    jest.spyOn(global, 'fetch').mockImplementation(async () => goodFeed());
    const collector = scanner();
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBeNull();
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('NONE');
  });
});

describe('transient primary-feed failover', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());
  function scanner(brokerOverrides: Partial<BrokerService> = {}) {
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({ brokerId: 'metatrader5' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_u: string, _c: string, instrument: string) =>
          trendCandles(instrument === 'USDJPY' ? 157 : 1.1, instrument === 'USDJPY' ? 3 : 5),
        ),
      ...brokerOverrides,
    } as unknown as BrokerService;
    return createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
  }
  async function assertFallback(fetchImpl: typeof fetch) {
    const collector = scanner();
    const series = await (collector as any).fetchSixPairSeries('real-key-123456', fetchImpl);
    expect([...series.keys()].sort()).toEqual(PAIRS.map(([p]) => p).sort());
    for (const candles of series.values()) {
      expect(candles.length).toBeGreaterThanOrEqual(55);
      expect(
        candles.every((c: { timestamp: Date }) => c.timestamp.getTime() + 300_000 <= Date.now()),
      ).toBe(true);
    }
    const status = await collector.getStatus('user-1');
    expect(status.marketDataAuthority).toBe('METAAPI_BROKER_FALLBACK');
    expect(status.providerCooldownReason).toBeNull();
    expect(status.executionAuthority).toBe('PAPER_ONLY');
  }
  it.each([429, 502, 503])('uses validated broker candles on transient HTTP %s', async (status) => {
    await assertFallback(
      async () =>
        new Response(JSON.stringify({ message: 'temporary provider limit or outage' }), { status }),
    );
  });
  it('uses validated broker candles when the provider request times out', async () => {
    await assertFallback((async () => {
      throw new Error('request timeout');
    }) as typeof fetch);
  });
  it('uses validated broker candles when the provider returns malformed JSON', async () => {
    await assertFallback(async () => new Response('{invalid', { status: 200 }));
  });
  it('uses one coherent broker batch when the primary batch omits an instrument', async () => {
    const batch = allTrendPayload();
    delete batch['USD/JPY'];
    await assertFallback(async () => new Response(JSON.stringify(batch), { status: 200 }));
  });
  it('uses validated broker candles when a primary instrument is stale', async () => {
    const batch = allTrendPayload();
    batch['EUR/USD'].values = batch['EUR/USD'].values.map((c: { datetime: string }) => ({
      ...c,
      datetime: new Date(new Date(c.datetime.replace(' ', 'T') + 'Z').getTime() - 3_600_000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' '),
    }));
    await assertFallback(async () => new Response(JSON.stringify(batch), { status: 200 }));
  });
  it('keeps authentication failures explicit instead of hiding configuration errors with fallback', async () => {
    const collector = scanner();
    await expect(
      (collector as any).fetchSixPairSeries(
        'real-key-123456',
        async () => new Response(JSON.stringify({ message: 'invalid API key' }), { status: 401 }),
      ),
    ).rejects.toThrow('Twelve Data HTTP 401');
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('NONE');
  });
  it('fails over on a JSON null payload rather than throwing a parser-shape error', async () => {
    await assertFallback(async () => new Response('null', { status: 200 }));
  });
  it('does not hide an authentication failure when its response body is not JSON', async () => {
    const collector = scanner();
    await expect(
      (collector as any).fetchSixPairSeries(
        'real-key-123456',
        async () => new Response('unauthorized', { status: 401 }),
      ),
    ).rejects.toThrow('Twelve Data HTTP 401');
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('NONE');
  });
  it('limits primary requests to one per minute even when both providers fail', async () => {
    const collector = scanner({
      getOhlcvForConnection: jest.fn().mockRejectedValue(new Error('broker unavailable')),
    });
    let primaryRequests = 0;
    const unavailableFeed = async () => {
      primaryRequests += 1;
      return new Response(JSON.stringify({ message: 'temporarily unavailable' }), { status: 503 });
    };
    await expect(
      (collector as any).fetchSixPairSeries('real-key-123456', unavailableFeed),
    ).rejects.toThrow('broker-native fallback failed');
    await expect(
      (collector as any).fetchSixPairSeries('real-key-123456', unavailableFeed),
    ).rejects.toThrow('broker-native fallback failed');
    expect(primaryRequests).toBe(1);
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('NONE');
    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    await expect(
      (collector as any).fetchSixPairSeries('real-key-123456', unavailableFeed),
    ).rejects.toThrow('broker-native fallback failed');
    expect(primaryRequests).toBe(2);
  });
  it('treats current-minute credit wording as a minute limit, not a daily cooldown', async () => {
    await assertFallback(
      async () =>
        new Response(
          JSON.stringify({
            message:
              'You have run out of API credits for the current minute. 12 API credits were used, with the current limit being 8.',
          }),
          { status: 429 },
        ),
    );
  });
  it('tries the primary provider again in the next minute after a minute-limit fallback', async () => {
    const collector = scanner();
    await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      async () =>
        new Response(
          JSON.stringify({
            message:
              'You have run out of API credits for the current minute, with the current limit being 8.',
          }),
          { status: 429 },
        ),
    );
    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      async () => new Response(JSON.stringify(allTrendPayload()), { status: 200 }),
    );
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('TWELVE_DATA');
    expect((await collector.getStatus('user-1')).providerCooldownUntil).toBeNull();
  });
  it.each([null, { open: '1.1' }])(
    'uses a coherent broker batch when a primary candle row is malformed (%s)',
    async (badRow) => {
      const batch = allTrendPayload();
      batch['EUR/USD'].values[0] = badRow;
      await assertFallback(async () => new Response(JSON.stringify(batch), { status: 200 }));
    },
  );
});

describe('PAPER post-loss history availability', () => {
  it.each([undefined, { query: jest.fn().mockResolvedValue([]) }])(
    'holds when the history store is missing or fails to return its anchored row',
    async (dataSource) => {
      const context = { dataSource, logger: { warn: jest.fn() } };
      const state = await VpsForexSignalCollectorService.prototype[
        'loadPaperPostLossEntryState'
      ].call(context, 'user', 'connection', 'EURUSD', 'BUY');
      expect(state).toEqual({ available: false, lastClosedTrade: null });
    },
  );
});
