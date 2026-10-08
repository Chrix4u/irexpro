import { ConfigService } from '@nestjs/config';
import { AiSignalService } from './ai-signal.service';
import {
  VpsForexSignalCollectorService,
  canExecuteMultiModelPaper,
  buildCandidate,
  buildDirectionalCandidates,
  selectCounterfactualExecutionCandidate,
  dynamicPaperLotUpperBound,
  isFreshOpportunity,
} from './vps-forex-signal-collector.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { BrokerService } from '../broker/broker.service';
import { LivePaperMarketDataService } from '../broker/services/live-paper-market-data.service';
import * as PlanBEnsembleModule from './plan-b-multimodel-shadow';
import * as EnsembleGovernanceModule from './ensemble-governance';

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

describe('VpsForexSignalCollectorService', () => {
  it('collects every closed M5 slot across the FX 24x5 market week', async () => {
    const collector = new VpsForexSignalCollectorService(
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
    expect(isCollectionSlot('2026-10-05T10:03:00.000Z')).toBe(false);

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

    const collector = new VpsForexSignalCollectorService(
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
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v2-directional-momentum-v1',
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
    const collector = new VpsForexSignalCollectorService(
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
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v2-directional-momentum-v1',
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
    const collector = new VpsForexSignalCollectorService(
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
    const collector = new VpsForexSignalCollectorService(
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
    const evidence = await (collector as any).loadExecutionSpreadEvidence('EURUSD', evaluatedAt);

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

  it('builds sleeve qualification evidence from the actual PAPER execution policy cohort', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const collector = new VpsForexSignalCollectorService(
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
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v2-hard-portfolio-v2-directional-momentum-v1',
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
    const collector = new VpsForexSignalCollectorService(
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

  it('evaluates every qualifying pair in the same scan instead of only the top-ranked pair', async () => {
    const live = new LivePaperMarketDataService();
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const collector = new VpsForexSignalCollectorService(
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
  });

  it('routes an evidence-qualified rejected-edge canary to PAPER with BASE sizing and research-only metadata', async () => {
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

    const collector = new VpsForexSignalCollectorService(
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
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => allTrendPayload() });
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
            position_sizing_tier: 'BASE',
          }),
        }),
      );
    } finally {
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('persists shadow evidence without an active PAPER session and keeps execution disabled', async () => {
    const live = new LivePaperMarketDataService();
    const receiveSignal = jest.fn();
    const heartbeat = jest.fn();
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const collector = new VpsForexSignalCollectorService(
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
    const collector = new VpsForexSignalCollectorService(
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
    const collector = new VpsForexSignalCollectorService(
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
    const collector = new VpsForexSignalCollectorService(
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
    const collector = new VpsForexSignalCollectorService(
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
    const collector = new VpsForexSignalCollectorService(
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

  it('uses broker-native fallback without retrying Twelve Data while daily cooldown is active', async () => {
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
    const collector = new VpsForexSignalCollectorService(
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
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(12);
  });

  it('fails closed when both Twelve Data quota and broker-native fallback are unavailable', async () => {
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({ brokerId: 'metatrader5' }),
      getOhlcvForConnection: jest.fn().mockRejectedValue(new Error('broker candles unavailable')),
    } as unknown as BrokerService;
    const collector = new VpsForexSignalCollectorService(
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
    const collector = new VpsForexSignalCollectorService(
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
