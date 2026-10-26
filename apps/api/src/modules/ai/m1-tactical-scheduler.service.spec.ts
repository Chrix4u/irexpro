import * as fs from 'fs';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import type { LivePaperCandleInput } from '../broker/services/live-paper-market-data.service';
import type { AiSignalService } from './ai-signal.service';
import type { ExecutionService } from '../execution/execution.service';
import type { TradeIntentService } from '../execution/services/trade-intent.service';
import type { AllocationService } from '../execution/services/allocation.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { M1_TACTICAL_POLICY_V1, buildM1TacticalCandidates } from './m1-tactical-candidate';
import {
  M1_TACTICAL_FEATURE_ARTIFACT,
  type M1TacticalFeatureSnapshot,
} from './m1-tactical-features';
import { classifyM1TacticalRoute } from './m1-tactical-route';
import type { MacroEventRiskService } from './macro-event-risk.service';
import type { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import type {
  M1TacticalMarketDataService,
  M1TacticalMarketSnapshot,
} from './m1-tactical-market-data.service';
import {
  M1TacticalSchedulerService,
  M1_TACTICAL_ROLLOUT_POLICY_V1,
  M1_TACTICAL_ROLLOUT_POLICY_V2,
  M1_TACTICAL_ROLLOUT_POLICY_V3,
  M1_TACTICAL_ROLLOUT_POLICY_V4,
  M1_TACTICAL_ROLLOUT_POLICY_V5,
  M1_TACTICAL_ROLLOUT_POLICY_V6,
  M1_TACTICAL_ROLLOUT_POLICY_V7,
  m1RiskMarketRegime,
  m1RouteExecutableInPhase,
  m1ShadowOutcomeEligible,
} from './m1-tactical-scheduler.service';

function seriesEndingAt(
  decisionTime: Date,
  count: number,
  minutes: number,
  base = 1.1,
  step = 0.00008,
): LivePaperCandleInput[] {
  const ms = minutes * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const openTime = new Date(decisionTime.getTime() - (count - index) * ms);
    const mid = base + index * step;
    return {
      timestamp: openTime,
      open: mid.toFixed(6),
      high: (mid + 0.00025).toFixed(6),
      low: (mid - 0.0002).toFixed(6),
      close: (mid + step * 0.6).toFixed(6),
    };
  });
}

function snapshot(instrument: string, decisionTime: Date): M1TacticalMarketSnapshot {
  return {
    connectionId: 'conn-1',
    instrument,
    decisionTime,
    candleSource: 'metaapi-rpc-sampled',
    marketDataAuthority: 'BROKER_NATIVE',
    m1: seriesEndingAt(decisionTime, 60, 1),
    m5: seriesEndingAt(decisionTime, 35, 5, 1.09, 0.00012),
    m15: seriesEndingAt(decisionTime, 35, 15, 1.08, 0.00015),
    h1: seriesEndingAt(decisionTime, 35, 60, 1.06, 0.0002),
    h4: seriesEndingAt(decisionTime, 35, 240, 1.02, 0.0003),
    spreadEvidence: {
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00004,
      sampleCount: 20,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date(decisionTime.getTime() - 5_000).toISOString(),
    },
  };
}

function harness(options: { marketDataErrorFor?: string; warm?: boolean } = {}) {
  const configValues: Record<string, unknown> = {
    'vpsForexScanner.enabled': true,
    'vpsForexScanner.userId': 'user-1',
    'vpsForexScanner.brokerConnectionId': 'conn-1',
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => configValues[key] ?? fallback),
  } as unknown as ConfigService;
  const loadSnapshot = jest.fn(async (_connectionId: string, instrument: string, at: Date) => {
    if (options.marketDataErrorFor === instrument) throw new Error('M1 data failure');
    return options.warm === false ? null : snapshot(instrument, at);
  });
  const getLastReadiness = jest.fn((_connectionId: string, instrument: string) =>
    options.warm === false
      ? {
          ready: false,
          reason: 'PAPER_M1_STALE',
          authority: null,
          observedAt: OPEN_NOW.toISOString(),
          instrument,
        }
      : null,
  );
  const marketData = { loadSnapshot, getLastReadiness } as unknown as M1TacticalMarketDataService;
  const assess = jest.fn().mockResolvedValue({ state: 'CLEAR' });
  const macro = { assess } as unknown as MacroEventRiskService;
  const recordDecision = jest.fn(async (value: any) => ({
    id: `decision-${value.instrument}-${value.direction}-${value.route}`,
    ...value,
    signalId: null,
    tradeIntentId: null,
    outcomeState: null,
    outcomeObservedAt: null,
    createdAt: value.evaluatedAt,
    updatedAt: value.evaluatedAt,
  }));
  const loadRoutePairSideEvidence = jest.fn().mockResolvedValue([]);
  const loadPendingDriftCounterfactuals = jest.fn().mockResolvedValue([]);
  const markDriftCounterfactual15m = jest.fn().mockResolvedValue(undefined);
  const loadMatureShadowEpisodeLeaders = jest.fn().mockResolvedValue([]);
  const markShadowOutcome15mV1 = jest.fn().mockResolvedValue(undefined);
  const evidence = {
    recordDecision,
    loadRoutePairSideEvidence,
    loadPendingDriftCounterfactuals,
    markDriftCounterfactual15m,
    loadMatureShadowEpisodeLeaders,
    markShadowOutcome15mV1,
  } as unknown as M1TacticalEvidenceService;
  const receiveSignal = jest.fn();
  const signal = { receiveSignal } as unknown as AiSignalService;
  const service = new M1TacticalSchedulerService(config, marketData, macro, evidence, signal);
  return {
    service,
    loadSnapshot,
    getLastReadiness,
    assess,
    recordDecision,
    loadRoutePairSideEvidence,
    loadPendingDriftCounterfactuals,
    markDriftCounterfactual15m,
    loadMatureShadowEpisodeLeaders,
    markShadowOutcome15mV1,
    receiveSignal,
  };
}

const OPEN_NOW = new Date('2026-10-15T12:30:15.000Z');

describe('M1 active-rollout shadow outcome eligibility', () => {
  it('keeps a reliability-demoted but otherwise clean sleeve learning in shadow', () => {
    expect(
      m1ShadowOutcomeEligible({
        routeEligible: true,
        route: 'M1_EARLY_TRANSITION',
        routeReason: 'EARLY_TRANSITION',
        routePayoffEligible: true,
        blockers: ['M1_RELIABILITY_RECENT_NEGATIVE_PAYOFF'],
        eventRisk: 'CLEAR',
        paperExecutionCostUsable: true,
      }),
    ).toBe(true);
  });

  it('keeps hard safety failures out of the promotion ledger', () => {
    expect(
      m1ShadowOutcomeEligible({
        routeEligible: true,
        route: 'M1_EARLY_TRANSITION',
        routeReason: 'EARLY_TRANSITION',
        routePayoffEligible: true,
        blockers: ['EXECUTION_SPREAD_UNAVAILABLE'],
        eventRisk: 'CLEAR',
        paperExecutionCostUsable: false,
      }),
    ).toBe(false);
    expect(
      m1ShadowOutcomeEligible({
        routeEligible: true,
        route: 'M1_EARLY_TRANSITION',
        routeReason: 'EARLY_TRANSITION',
        routePayoffEligible: true,
        blockers: ['EVENT_RISK_UNVERIFIED'],
        eventRisk: 'UNVERIFIED',
        paperExecutionCostUsable: true,
      }),
    ).toBe(false);
  });

  it('allows only the explicit local-impulse drift counterfactual exception', () => {
    expect(
      m1ShadowOutcomeEligible({
        routeEligible: true,
        route: 'M1_EARLY_TRANSITION',
        routeReason: 'LOCAL_IMPULSE_AGAINST_HTF',
        routePayoffEligible: true,
        blockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'M1_RELIABILITY_NEGATIVE_EXPECTANCY'],
        eventRisk: 'CLEAR',
        paperExecutionCostUsable: true,
      }),
    ).toBe(true);
    expect(
      m1ShadowOutcomeEligible({
        routeEligible: true,
        route: 'M1_TREND_CONTINUATION',
        routeReason: 'TREND_CONTINUATION',
        routePayoffEligible: true,
        blockers: ['DRIFT_OUT_OF_DISTRIBUTION'],
        eventRisk: 'CLEAR',
        paperExecutionCostUsable: true,
      }),
    ).toBe(false);
  });
});

describe('M1 tactical aligned-currency exposure guard', () => {
  function guardHarness(
    allocatedCapital: number,
    positions: Array<{ instrument: string; direction: 'BUY' | 'SELL'; riskAtStop: number | null }>,
  ) {
    const evidence = {
      loadOpenPaperRiskPositions: jest.fn().mockResolvedValue(positions),
    } as unknown as M1TacticalEvidenceService;
    const allocation = {
      getUserCapitalAllocationState: jest.fn().mockResolvedValue({
        hasAllocation: true,
        allocatedCapital: String(allocatedCapital),
      }),
    } as unknown as AllocationService;
    const service = new M1TacticalSchedulerService(
      {} as ConfigService,
      {} as M1TacticalMarketDataService,
      {} as MacroEventRiskService,
      evidence,
      {} as AiSignalService,
      undefined,
      undefined,
      undefined,
      allocation,
    );
    return { service, evidence, allocation };
  }

  const candidate = {
    instrument: 'EURUSD',
    direction: 'SELL',
    entry: 1.1222,
    stopLoss: 1.1227,
  } as any;

  it('keeps full M1 scout size while aligned stop-risk stays below two percent', async () => {
    const { service } = guardHarness(1000, [
      { instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 5 },
    ]);
    await expect(
      (service as any).resolveM1CurrencyExposureGuard('user-1', 'conn-1', candidate, 0.1),
    ).resolves.toMatchObject({
      allowed: true,
      volumeCap: 0.1,
      decision: { capacity: 'CLEAR' },
    });
  });

  it('blocks when a 0.10 scout would require a sub-floor exposure reduction', async () => {
    const { service } = guardHarness(1000, [
      { instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 25 },
    ]);
    await expect(
      (service as any).resolveM1CurrencyExposureGuard('user-1', 'conn-1', candidate, 0.1),
    ).resolves.toMatchObject({
      allowed: false,
      volumeCap: 0,
      decision: { capacity: 'REDUCED' },
    });
  });

  it('blocks another aligned M1 entry when even 0.05 lots remains above three percent', async () => {
    const { service } = guardHarness(1000, [
      { instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 35 },
    ]);
    await expect(
      (service as any).resolveM1CurrencyExposureGuard('user-1', 'conn-1', candidate, 0.1),
    ).resolves.toMatchObject({
      allowed: false,
      volumeCap: 0,
      decision: { capacity: 'BLOCKED' },
    });
  });
});

describe('M1TacticalSchedulerService shadow phase', () => {
  afterEach(() => jest.useRealTimers());

  it('owns an independent 15-second wake-up and defaults to SHADOW', () => {
    jest.useFakeTimers();
    const interval = jest.spyOn(global, 'setInterval');
    const { service } = harness();

    service.onModuleInit();

    expect(M1_TACTICAL_ROLLOUT_POLICY_V1.phase).toBe('SHADOW');
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 15_000);
    service.onModuleDestroy();
  });

  it('evaluates one completed minute only once even when woken again inside the same minute', async () => {
    const h = harness();
    await h.service.runOnce(OPEN_NOW);
    await h.service.runOnce(new Date('2026-10-15T12:30:45.000Z'));

    expect(h.loadSnapshot).toHaveBeenCalledTimes(6);
    expect(h.recordDecision).toHaveBeenCalledTimes(12);
  });

  it('skips the closed FX weekly session', async () => {
    const h = harness();
    await h.service.runOnce(new Date('2026-10-17T12:30:15.000Z'));
    expect(h.loadSnapshot).not.toHaveBeenCalled();
    expect(h.recordDecision).not.toHaveBeenCalled();
  });

  it('waits for warm history instead of creating a decision from incomplete context', async () => {
    const h = harness({ warm: false });
    await h.service.runOnce(OPEN_NOW);
    expect(h.loadSnapshot).toHaveBeenCalledTimes(6);
    expect(h.recordDecision).not.toHaveBeenCalled();
  });

  it('surfaces per-pair readiness when warm history is unavailable', async () => {
    const h = harness({ warm: false });

    await h.service.runOnce(OPEN_NOW);

    expect(h.service.getStatus()).toEqual(
      expect.objectContaining({
        marketReadiness: expect.objectContaining({
          EURUSD: expect.objectContaining({
            ready: false,
            reason: 'PAPER_M1_STALE',
          }),
          USDJPY: expect.objectContaining({
            ready: false,
            reason: 'PAPER_M1_STALE',
          }),
        }),
      }),
    );
    expect(h.recordDecision).not.toHaveBeenCalled();
  });

  it('evaluates all six pairs independently and persists both BUY and SELL observations', async () => {
    const h = harness();
    await h.service.runOnce(OPEN_NOW);

    const instruments = h.loadSnapshot.mock.calls.map((call) => call[1]);
    expect(new Set(instruments)).toEqual(
      new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF']),
    );
    const persisted = h.recordDecision.mock.calls.map((call) => call[0]);
    expect(persisted.filter((row) => row.direction === 'BUY')).toHaveLength(6);
    expect(persisted.filter((row) => row.direction === 'SELL')).toHaveLength(6);
    for (const row of persisted) {
      expect(row.executionAuthority).toBe('NONE');
      expect(row.blockers).toContain('M1_PHASE_SHADOW');
      expect(row.policyVersion).toBe('m1-tactical-v1');
      expect(row.barTime).toBeInstanceOf(Date);
      expect(typeof row.governance.shadowOutcomeEligible).toBe('boolean');
      expect(row.governance.expectancy).toEqual(
        expect.objectContaining({
          artifact: 'm1-tactical-statistical-expectancy-v2',
          targetR: 1.6,
          statisticalExpectedR: expect.any(Number),
        }),
      );
      expect(row.governance.netExpectedR).not.toBeCloseTo(1.6, 6);
    }
    expect(h.receiveSignal).not.toHaveBeenCalled();
  });

  it('settles a mature drift-blocked decision from real completed M1 bars without submitting a signal', async () => {
    const h = harness();
    h.loadPendingDriftCounterfactuals.mockImplementation(async (request: any) =>
      request.instrument === 'EURUSD'
        ? [
            {
              id: 'decision-drift-1',
              instrument: 'EURUSD',
              direction: 'BUY',
              route: 'M1_TREND_CONTINUATION',
              evaluatedAt: new Date('2026-10-15T12:14:00.000Z'),
              stopDistance: 0.0005,
              targetDistance: 0.0008,
              estimatedExecutionCostR: 0.0625,
              driftState: 'OUT_OF_DISTRIBUTION',
              driftDiagnostics: ['extensionAtr:HARD_HIGH'],
            },
          ]
        : [],
    );

    await h.service.runOnce(OPEN_NOW);

    expect(h.loadPendingDriftCounterfactuals).toHaveBeenCalledWith({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      asOf: new Date('2026-10-15T12:30:00.000Z'),
      policyVersion: 'm1-tactical-v1',
    });
    expect(h.markDriftCounterfactual15m).toHaveBeenCalledTimes(1);
    expect(h.markDriftCounterfactual15m.mock.calls[0]![0]).toBe('decision-drift-1');
    expect(h.markDriftCounterfactual15m.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        artifact: 'm1-drift-counterfactual-15m-v1',
        modifiesExecution: false,
        source: 'COMPLETED_M1_OHLC',
        horizonBars: 15,
      }),
    );
    expect(h.receiveSignal).not.toHaveBeenCalled();
  });

  it('settles a mature governance-clean SHADOW episode from the existing M1 window without dispatching a signal', async () => {
    const h = harness();
    h.loadMatureShadowEpisodeLeaders.mockImplementation(async (request: any) =>
      request.instrument === 'EURUSD'
        ? [
            {
              id: 'shadow-leader-1',
              instrument: 'EURUSD',
              direction: 'BUY',
              route: 'M1_EARLY_TRANSITION',
              barTime: new Date('2026-10-15T12:14:00.000Z'),
              evaluatedAt: new Date('2026-10-15T12:14:00.000Z'),
              policyVersion: 'm1-tactical-v1',
              stopDistance: 0.0005,
              targetDistance: 0.0008,
              estimatedExecutionCostR: 0.0625,
              executionCostSource: 'BROKER_OBSERVED_P90',
              rolloutPhase: 'SHADOW',
            },
          ]
        : [],
    );

    await h.service.runOnce(OPEN_NOW);

    expect(h.loadMatureShadowEpisodeLeaders).toHaveBeenCalledWith({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      policyVersion: 'm1-tactical-v1',
      asOf: new Date('2026-10-15T12:30:00.000Z'),
    });
    expect(h.markShadowOutcome15mV1).toHaveBeenCalledTimes(1);
    expect(h.markShadowOutcome15mV1).toHaveBeenCalledWith(
      'shadow-leader-1',
      expect.objectContaining({
        artifact: 'm1-shadow-outcome-15m-v1',
        modifiesExecution: false,
        episodeLeaderDecisionId: 'shadow-leader-1',
        route: 'M1_EARLY_TRANSITION',
        instrument: 'EURUSD',
        direction: 'BUY',
        policyVersion: 'm1-tactical-v1',
        source: 'COMPLETED_M1_OHLC',
        outcome: 'TP',
      }),
    );
    expect(M1_TACTICAL_ROLLOUT_POLICY_V1.phase).toBe('SHADOW');
    expect(h.receiveSignal).not.toHaveBeenCalled();
  });

  it('keeps a SHADOW episode pending while its causal 15-bar window is not complete', async () => {
    const h = harness();
    h.loadMatureShadowEpisodeLeaders.mockImplementation(async (request: any) =>
      request.instrument === 'EURUSD'
        ? [
            {
              id: 'shadow-pending-1',
              instrument: 'EURUSD',
              direction: 'SELL',
              route: 'M1_TREND_CONTINUATION',
              barTime: new Date('2026-10-15T12:20:00.000Z'),
              evaluatedAt: new Date('2026-10-15T12:20:00.000Z'),
              policyVersion: 'm1-tactical-v1',
              stopDistance: 0.0005,
              targetDistance: 0.0008,
              estimatedExecutionCostR: 0.05,
              executionCostSource: 'PAPER_SIMULATION_SPREAD',
              rolloutPhase: 'SHADOW',
            },
          ]
        : [],
    );

    await h.service.runOnce(OPEN_NOW);

    expect(h.markShadowOutcome15mV1).not.toHaveBeenCalled();
    expect(h.receiveSignal).not.toHaveBeenCalled();
  });

  it('finalizes an unreconstructable SHADOW episode beyond the 60-minute observability boundary as a data gap', async () => {
    const h = harness();
    h.loadMatureShadowEpisodeLeaders.mockImplementation(async (request: any) =>
      request.instrument === 'EURUSD'
        ? [
            {
              id: 'shadow-gap-1',
              instrument: 'EURUSD',
              direction: 'BUY',
              route: 'M1_CONFIRMED_REVERSAL',
              barTime: new Date('2026-10-15T11:20:00.000Z'),
              evaluatedAt: new Date('2026-10-15T11:20:00.000Z'),
              policyVersion: 'm1-tactical-v1',
              stopDistance: 0.0005,
              targetDistance: 0.0008,
              estimatedExecutionCostR: 0.07,
              executionCostSource: 'BROKER_OBSERVED_P90',
              rolloutPhase: 'SHADOW',
            },
          ]
        : [],
    );

    await h.service.runOnce(OPEN_NOW);

    expect(h.markShadowOutcome15mV1).toHaveBeenCalledTimes(1);
    expect(h.markShadowOutcome15mV1).toHaveBeenCalledWith(
      'shadow-gap-1',
      expect.objectContaining({
        artifact: 'm1-shadow-outcome-15m-v1',
        modifiesExecution: false,
        source: 'UNOBSERVABLE_DATA_GAP',
        outcome: 'UNOBSERVABLE_DATA_GAP',
        grossRMultiple: null,
        netRMultiple: null,
      }),
    );
    expect(h.receiveSignal).not.toHaveBeenCalled();
  });

  it('generates the same durable identity after a restart so the database fence can converge duplicates', async () => {
    const first = harness();
    const second = harness();
    await first.service.runOnce(OPEN_NOW);
    await second.service.runOnce(OPEN_NOW);

    const identity = (call: any[]) => {
      const row = call[0];
      return `${row.userId}|${row.brokerConnectionId}|${row.instrument}|${row.direction}|${row.route}|${row.barTime.toISOString()}|${row.policyVersion}`;
    };
    expect(first.recordDecision.mock.calls.map(identity).sort()).toEqual(
      second.recordDecision.mock.calls.map(identity).sort(),
    );
    expect(first.receiveSignal).not.toHaveBeenCalled();
    expect(second.receiveSignal).not.toHaveBeenCalled();
  });

  it('isolates one M1 pair failure and leaves M5 ownership structurally independent', async () => {
    const h = harness({ marketDataErrorFor: 'EURUSD' });
    const m5State = { slot: 'm5-unchanged', calls: 0 };
    const m5Cycle = jest.fn(() => {
      m5State.calls += 1;
    });
    m5Cycle();

    await expect(h.service.runOnce(OPEN_NOW)).resolves.toBeUndefined();
    m5Cycle();

    expect(h.loadSnapshot).toHaveBeenCalledTimes(6);
    expect(h.recordDecision).toHaveBeenCalledTimes(10);
    expect(m5State).toEqual({ slot: 'm5-unchanged', calls: 2 });
    const m5Source = fs.readFileSync(
      path.resolve(__dirname, './vps-forex-signal-collector.service.ts'),
      'utf8',
    );
    expect(m5Source).not.toContain('M1TacticalSchedulerService');
    expect(m5Source).not.toContain("'./m1-tactical-scheduler.service'");
  });
});

function cleanContinuationFeatures(): M1TacticalFeatureSnapshot {
  return {
    artifact: M1_TACTICAL_FEATURE_ARTIFACT,
    instrument: 'EURUSD',
    decisionTime: new Date('2026-10-15T10:30:00.000Z'),
    latestM1OpenTime: new Date('2026-10-15T10:29:00.000Z'),
    price: 1.1,
    atr14: 0.0005,
    rsi14: 58,
    bodyRangeRatio: 0.55,
    upperWickRatio: 0.15,
    lowerWickRatio: 0.3,
    closeLocation: 0.8,
    ema9: 1.1002,
    ema21: 1.0998,
    emaSeparationAtr: 0.4,
    emaSlopeAtr: 0.22,
    momentum1Atr: 0.22,
    momentum3Atr: 0.55,
    momentum5Atr: 0.72,
    breakoutUpAtr: 0.18,
    breakoutDownAtr: 0,
    failedBreakoutUp: false,
    failedBreakoutDown: false,
    efficiency5: 0.72,
    volatilityChange: 0.08,
    extensionAtr: 0.4,
    volatilityScore: 0.28,
    session: 'LONDON',
    alignment: { m5: 0.6, m15: 0.72, h1: 0.65, h4: 0.52 },
    higherTimeframeAgreement: 0.6225,
  };
}

function phase2Harness(
  options: {
    session?: Record<string, unknown> | null;
    macroState?: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
    spreadUsable?: boolean;
    reliabilityLosses?: number;
    signalOutcome?: 'EXECUTION_SUCCEEDED' | 'RISK_REJECTED';
    rollout?: any;
    evidenceByRoute?: Record<string, any[]>;
    shadowPairSideOutcomes?: Array<{ observedAt: Date; netR: number }>;
    openPositions?: any[];
    duplicateOppositeIntent?: boolean;
    tradeIntentId?: string | null;
    existingDecision?: {
      signalId?: string | null;
      tradeIntentId?: string | null;
      outcomeState?: string | null;
      outcomeReason?: string | null;
    };
  } = {},
) {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      };
      return values[key] ?? fallback;
    }),
  } as unknown as ConfigService;
  const marketData = { loadSnapshot: jest.fn() } as unknown as M1TacticalMarketDataService;
  const macro = {
    assess: jest.fn().mockResolvedValue({ state: options.macroState ?? 'CLEAR' }),
  } as unknown as MacroEventRiskService;
  const recordDecision = jest.fn(async (value: any) => ({
    id: `decision-${value.instrument}-${value.direction}-${value.route}`,
    ...value,
    signalId: options.existingDecision?.signalId ?? null,
    tradeIntentId: options.existingDecision?.tradeIntentId ?? null,
    outcomeState: options.existingDecision?.outcomeState ?? null,
    outcomeReason: options.existingDecision?.outcomeReason ?? null,
    outcomeObservedAt: null,
    createdAt: value.evaluatedAt,
    updatedAt: value.evaluatedAt,
  }));
  const lossCount = options.reliabilityLosses ?? 0;
  const continuationLosses = Array.from({ length: lossCount }, (_, index) => ({
    route: 'M1_TREND_CONTINUATION',
    instrument: 'EURUSD',
    direction: 'BUY',
    policyVersion: 'm1-tactical-v1',
    realisedPnl: -1,
    closedAt: new Date(`2026-10-15T10:${20 + index}:00.000Z`),
  }));
  const loadRoutePairSideEvidence = jest.fn(
    async (request: any) => options.evidenceByRoute?.[request.route] ?? continuationLosses,
  );
  const loadShadowPairSideOutcomes = jest
    .fn()
    .mockResolvedValue(options.shadowPairSideOutcomes ?? []);
  const markExecutionLink = jest.fn().mockResolvedValue(undefined);
  const markOutcomeState = jest.fn().mockResolvedValue(undefined);
  const loadOpenPaperPositions = jest.fn().mockResolvedValue(options.openPositions ?? []);
  const loadOpenPaperRiskPositions = jest.fn().mockResolvedValue([]);
  const hasActiveOppositeM1Intent = jest
    .fn()
    .mockResolvedValue(options.duplicateOppositeIntent ?? false);
  const markRescueObservation = jest.fn().mockResolvedValue(undefined);
  const loadPendingDriftCounterfactuals = jest.fn().mockResolvedValue([]);
  const markDriftCounterfactual15m = jest.fn().mockResolvedValue(undefined);
  const evidence = {
    recordDecision,
    loadRoutePairSideEvidence,
    loadShadowPairSideOutcomes,
    markExecutionLink,
    markOutcomeState,
    loadOpenPaperPositions,
    loadOpenPaperRiskPositions,
    hasActiveOppositeM1Intent,
    markRescueObservation,
    loadPendingDriftCounterfactuals,
    markDriftCounterfactual15m,
  } as unknown as M1TacticalEvidenceService;
  const receiveSignal = jest.fn(async (candidate: any) => ({
    outcome: options.signalOutcome ?? 'EXECUTION_SUCCEEDED',
    signalId: candidate.signalId,
    ...(options.signalOutcome === 'RISK_REJECTED'
      ? { reason: 'risk gate rejected test candidate' }
      : { tradeId: 'trade-1' }),
  }));
  const signal = { receiveSignal } as unknown as AiSignalService;
  const getActiveSession = jest
    .fn()
    .mockResolvedValue(
      options.session === undefined
        ? { id: 'session-1', executionMode: ExecutionMode.PAPER_ONLY, brokerConnectionId: 'conn-1' }
        : options.session,
    );
  const closeTrade = jest.fn();
  const execution = { getActiveSession, closeTrade } as unknown as ExecutionService;
  const findBySignal = jest
    .fn()
    .mockResolvedValue(options.tradeIntentId ? { id: options.tradeIntentId } : null);
  const tradeIntent = { findBySignal } as unknown as TradeIntentService;
  const rollout = {
    ...(options.rollout ?? M1_TACTICAL_ROLLOUT_POLICY_V2),
    instruments: ['EURUSD'] as const,
  };
  const allocation = {
    getUserCapitalAllocationState: jest.fn().mockResolvedValue({
      hasAllocation: true,
      allocatedCapital: '1000',
    }),
  } as unknown as AllocationService;
  const service = new M1TacticalSchedulerService(
    config,
    marketData,
    macro,
    evidence,
    signal,
    rollout,
    execution,
    options.tradeIntentId === undefined ? undefined : tradeIntent,
    allocation,
  );
  return {
    service,
    recordDecision,
    loadRoutePairSideEvidence,
    loadShadowPairSideOutcomes,
    markExecutionLink,
    markOutcomeState,
    receiveSignal,
    getActiveSession,
    closeTrade,
    loadOpenPaperPositions,
    loadOpenPaperRiskPositions,
    hasActiveOppositeM1Intent,
    markRescueObservation,
    loadPendingDriftCounterfactuals,
    markDriftCounterfactual15m,
    findBySignal,
  };
}

async function driveCleanContinuation(
  h: ReturnType<typeof phase2Harness>,
  options: { spreadUsable?: boolean } = {},
) {
  const features = cleanContinuationFeatures();
  const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
  const route = classifyM1TacticalRoute(buy, sell, features, M1_TACTICAL_POLICY_V1);
  expect(route.route).toBe('M1_TREND_CONTINUATION');
  expect(route.eligible).toBe(true);
  const spreadEvidence =
    options.spreadUsable === false
      ? null
      : {
          source: 'BROKER_OBSERVED_P90' as const,
          spreadPrice: 0.00004,
          sampleCount: 20,
          percentile: 0.9,
          windowMinutes: 30,
          latestSampleAt: '2026-10-15T10:30:00.000Z',
        };
  await (h.service as any).persistCandidate(
    'user-1',
    'conn-1',
    buy,
    sell,
    features,
    'CLEAR',
    spreadEvidence,
    features.decisionTime,
  );
}

describe('M1 risk-regime contract', () => {
  it('maps M1 strategy routes into the risk engine regime vocabulary', () => {
    expect(m1RiskMarketRegime('M1_TREND_CONTINUATION')).toBe('TREND_HEALTHY');
    expect(m1RiskMarketRegime('M1_CONFIRMED_REVERSAL')).toBe('REVERSAL');
    expect(m1RiskMarketRegime('M1_EARLY_TRANSITION')).toBe('TRANSITION');
    expect(m1RiskMarketRegime('ABSTAIN')).toBeUndefined();
  });
});

describe('M1TacticalSchedulerService PAPER continuation phase', () => {
  it('version-gates route execution so phase 2 permits continuation only', () => {
    expect(M1_TACTICAL_ROLLOUT_POLICY_V2.phase).toBe('PAPER_CONTINUATION');
    expect(m1RouteExecutableInPhase('PAPER_CONTINUATION', 'M1_TREND_CONTINUATION')).toBe(true);
    expect(m1RouteExecutableInPhase('PAPER_CONTINUATION', 'M1_CONFIRMED_REVERSAL')).toBe(false);
    expect(m1RouteExecutableInPhase('PAPER_CONTINUATION', 'M1_EARLY_TRANSITION')).toBe(false);
    expect(m1RouteExecutableInPhase('PAPER_CONTINUATION', 'ABSTAIN')).toBe(false);
  });

  it('submits a governed continuation only with the exact active PAPER session', async () => {
    const h = phase2Harness();
    await driveCleanContinuation(h);
    expect(h.getActiveSession).toHaveBeenCalledWith('user-1');
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);

    for (const badSession of [
      null,
      { id: 'session-2', executionMode: ExecutionMode.FULL_AUTO, brokerConnectionId: 'conn-1' },
      {
        id: 'session-3',
        executionMode: ExecutionMode.PAPER_ONLY,
        brokerConnectionId: 'other-conn',
      },
    ]) {
      const bad = phase2Harness({ session: badSession });
      await driveCleanContinuation(bad);
      expect(bad.receiveSignal).not.toHaveBeenCalled();
    }
  });

  it('keeps PAPER execution independent when the counterfactual observer is unavailable', async () => {
    const h = phase2Harness();
    h.loadPendingDriftCounterfactuals.mockRejectedValueOnce(new Error('observer unavailable'));
    const market = snapshot('EURUSD', new Date('2026-10-15T10:30:00.000Z'));

    await expect(
      (h.service as any).settleMatureDriftCounterfactuals(
        'user-1',
        'conn-1',
        'EURUSD',
        new Date('2026-10-15T10:30:00.000Z'),
        market.m1,
      ),
    ).resolves.toBeUndefined();
    await driveCleanContinuation(h);

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
  });

  it('emits a PAPER-only M1 signal with durable decision and payoff metadata', async () => {
    const h = phase2Harness();
    await driveCleanContinuation(h);
    const signal = h.receiveSignal.mock.calls[0]![0];
    expect(signal).toMatchObject({
      userId: 'user-1',
      tradingSessionId: 'session-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      timeframe: 'M1',
      strategyCode: 'external-irexpro-m1-tactical',
      modelVersion: 'external-provider/irexpro-m1-tactical/m1-tactical-v1',
      marketRegime: 'TREND_HEALTHY',
      metadata: expect.objectContaining({
        external_provider_paper_only: true,
        production_eligible: false,
        position_sizing_tier: 'RESEARCH',
        m1_tactical_route: 'M1_TREND_CONTINUATION',
        m1_policy_version: 'm1-tactical-v1',
        m1_decision_id: 'decision-EURUSD-BUY-M1_TREND_CONTINUATION',
        m1_gross_expected_r: expect.any(Number),
        m1_execution_cost_r: expect.any(Number),
        m1_net_expected_r: expect.any(Number),
      }),
    });
    expect(signal.signalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.markExecutionLink).toHaveBeenCalledWith(
      'decision-EURUSD-BUY-M1_TREND_CONTINUATION',
      signal.signalId,
      undefined,
    );
  });

  it('does not resubmit a durable decision that already created a trade intent', async () => {
    const h = phase2Harness({
      existingDecision: {
        signalId: 'existing-signal',
        tradeIntentId: 'existing-intent',
        outcomeState: 'EXECUTION_SUCCEEDED',
      },
    });

    await driveCleanContinuation(h);

    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.markExecutionLink).not.toHaveBeenCalled();
    expect(h.markOutcomeState).not.toHaveBeenCalled();
  });

  it('keeps a pre-intent RISK_REJECTED decision retryable', async () => {
    const h = phase2Harness({
      existingDecision: {
        signalId: 'existing-signal',
        tradeIntentId: null,
        outcomeState: 'RISK_REJECTED',
      },
    });

    await driveCleanContinuation(h);

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
  });

  it('backfills the durable TradeIntent id onto an executed M1 decision after signal processing', async () => {
    const h = phase2Harness({ tradeIntentId: 'intent-1' });
    await driveCleanContinuation(h);

    const signalId = h.receiveSignal.mock.calls[0]![0].signalId;
    expect(h.findBySignal).toHaveBeenCalledWith('user-1', signalId);
    expect(h.markExecutionLink).toHaveBeenLastCalledWith(
      'decision-EURUSD-BUY-M1_TREND_CONTINUATION',
      signalId,
      'intent-1',
    );
  });

  it('allows conservative PAPER simulation spread without upgrading it to production evidence', async () => {
    const h = phase2Harness();
    const features = { ...cleanContinuationFeatures(), closeLocation: 0.85 };
    const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);

    await (h.service as any).persistCandidate(
      'user-1',
      'conn-1',
      buy,
      sell,
      features,
      'CLEAR',
      null,
      features.decisionTime,
      0.0001,
    );

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0].metadata).toEqual(
      expect.objectContaining({
        external_provider_paper_only: true,
        production_eligible: false,
        m1_execution_cost_source: 'PAPER_SIMULATION_SPREAD',
      }),
    );
    expect(h.recordDecision.mock.calls[0]![0].governance.genericGovernance).toEqual(
      expect.objectContaining({
        executionCostSource: 'PAPER_SIMULATION_SPREAD',
        executionSpreadEvidenceValid: false,
        paperExecutionCostUsable: true,
        paperPromotionEligible: false,
      }),
    );
  });

  it('keeps event-risk, spread and reliability blockers ahead of signal submission', async () => {
    const eventBlocked = phase2Harness({ macroState: 'UNVERIFIED' });
    const features = cleanContinuationFeatures();
    const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
    await (eventBlocked.service as any).persistCandidate(
      'user-1',
      'conn-1',
      buy,
      sell,
      features,
      'UNVERIFIED',
      {
        source: 'BROKER_OBSERVED_P90',
        spreadPrice: 0.00004,
        sampleCount: 20,
        percentile: 0.9,
        windowMinutes: 30,
        latestSampleAt: '2026-10-15T10:30:00.000Z',
      },
      features.decisionTime,
    );
    expect(eventBlocked.receiveSignal).not.toHaveBeenCalled();

    const spreadBlocked = phase2Harness();
    await driveCleanContinuation(spreadBlocked, { spreadUsable: false });
    expect(spreadBlocked.receiveSignal).not.toHaveBeenCalled();

    const reliabilityBlocked = phase2Harness({ reliabilityLosses: 3 });
    await driveCleanContinuation(reliabilityBlocked);
    expect(reliabilityBlocked.receiveSignal).not.toHaveBeenCalled();
  });

  it('persists downstream risk rejection and reuses the same signal identity on retry/restart', async () => {
    const rejected = phase2Harness({ signalOutcome: 'RISK_REJECTED' });
    await driveCleanContinuation(rejected);
    expect(rejected.markOutcomeState).toHaveBeenCalledWith(
      'decision-EURUSD-BUY-M1_TREND_CONTINUATION',
      'RISK_REJECTED',
      expect.any(Date),
      'risk gate rejected test candidate',
    );

    const first = phase2Harness();
    const second = phase2Harness();
    await driveCleanContinuation(first);
    await driveCleanContinuation(second);
    expect(first.receiveSignal.mock.calls[0]![0].signalId).toBe(
      second.receiveSignal.mock.calls[0]![0].signalId,
    );
  });
});

function reversalFeatures(): M1TacticalFeatureSnapshot {
  return {
    ...cleanContinuationFeatures(),
    failedBreakoutDown: true,
    breakoutUpAtr: 0.1,
    emaSeparationAtr: 0.22,
    emaSlopeAtr: 0.35,
    momentum1Atr: 0.55,
    momentum3Atr: 0.72,
    momentum5Atr: 0.48,
    alignment: { m5: 0.08, m15: -0.08, h1: -0.18, h4: -0.22 },
    higherTimeframeAgreement: -0.1,
    closeLocation: 0.9,
    lowerWickRatio: 0.55,
    upperWickRatio: 0.05,
  };
}

function transitionFeatures(): M1TacticalFeatureSnapshot {
  return {
    ...cleanContinuationFeatures(),
    emaSeparationAtr: 0.2,
    emaSlopeAtr: 0.32,
    momentum1Atr: 0.42,
    momentum3Atr: 0.5,
    momentum5Atr: 0.45,
    breakoutUpAtr: 0.12,
    alignment: { m5: 0.25, m15: 0.11, h1: -0.06, h4: -0.08 },
    higherTimeframeAgreement: 0.055,
    efficiency5: 0.78,
    closeLocation: 0.88,
  };
}

async function driveFeatures(
  h: ReturnType<typeof phase2Harness>,
  features: M1TacticalFeatureSnapshot,
  options: {
    eventRisk?: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
    spreadEvidence?: any;
  } = {},
) {
  const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
  const route = classifyM1TacticalRoute(buy, sell, features, M1_TACTICAL_POLICY_V1);
  await (h.service as any).persistCandidate(
    'user-1',
    'conn-1',
    buy,
    sell,
    features,
    options.eventRisk ?? 'CLEAR',
    options.spreadEvidence === undefined
      ? {
          source: 'BROKER_OBSERVED_P90',
          spreadPrice: 0.00004,
          sampleCount: 20,
          percentile: 0.9,
          windowMinutes: 30,
          latestSampleAt: features.decisionTime.toISOString(),
        }
      : options.spreadEvidence,
    features.decisionTime,
  );
  return route;
}

describe('M1TacticalSchedulerService PAPER all-routes phase', () => {
  it('version-gates phase 3 to all three research routes', () => {
    expect(M1_TACTICAL_ROLLOUT_POLICY_V3.phase).toBe('PAPER_ALL_ROUTES');
    expect(m1RouteExecutableInPhase('PAPER_ALL_ROUTES', 'M1_TREND_CONTINUATION')).toBe(true);
    expect(m1RouteExecutableInPhase('PAPER_ALL_ROUTES', 'M1_CONFIRMED_REVERSAL')).toBe(true);
    expect(m1RouteExecutableInPhase('PAPER_ALL_ROUTES', 'M1_EARLY_TRANSITION')).toBe(true);
    expect(m1RouteExecutableInPhase('PAPER_ALL_ROUTES', 'ABSTAIN')).toBe(false);
  });

  it('qualifies reversal only from the reversal route evidence key and never borrows continuation losses', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V3,
      evidenceByRoute: {
        M1_TREND_CONTINUATION: Array.from({ length: 3 }, () => ({
          route: 'M1_TREND_CONTINUATION',
          instrument: 'EURUSD',
          direction: 'BUY',
          policyVersion: 'm1-tactical-v1',
          realisedPnl: -1,
          closedAt: new Date('2026-10-15T10:20:00.000Z'),
        })),
        M1_CONFIRMED_REVERSAL: [],
      },
    });
    const route = await driveFeatures(h, reversalFeatures());
    expect(route.route).toBe('M1_CONFIRMED_REVERSAL');
    expect(h.loadRoutePairSideEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'M1_CONFIRMED_REVERSAL' }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0].metadata.m1_tactical_route).toBe(
      'M1_CONFIRMED_REVERSAL',
    );
  });

  it('qualifies early transition only from the transition evidence key with its own route floor', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V3,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    const route = await driveFeatures(h, transitionFeatures());
    expect(route.route).toBe('M1_EARLY_TRANSITION');
    expect(h.loadRoutePairSideEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'M1_EARLY_TRANSITION' }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0].metadata).toEqual(
      expect.objectContaining({
        m1_tactical_route: 'M1_EARLY_TRANSITION',
        m1_route_net_expected_r_floor: expect.any(Number),
      }),
    );
  });

  it('loads the authoritative open M1 position and duplicate-opposite state before recording rescue shadow evidence', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V3,
      openPositions: [
        {
          tradeId: 'trade-1',
          tradeIntentId: 'intent-1',
          instrument: 'EURUSD',
          direction: 'SELL',
          openedAt: new Date('2026-10-15T10:00:00.000Z'),
          decisionId: 'decision-old',
          route: 'M1_TREND_CONTINUATION',
          policyVersion: 'm1-tactical-v1',
          originalNetExpectedR: 0.18,
        },
      ],
      duplicateOppositeIntent: false,
    });

    const rescue = await (h.service as any).observeOpenPositionRescueShadow({
      decisionId: 'decision-current',
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      originalDirection: 'SELL',
      oppositeDirection: 'BUY',
      originalInvalidated: true,
      originalNetExpectedR: -0.1,
      oppositeNetExpectedR: 0.45,
      oppositeGovernanceEligible: true,
      oppositeBlockers: [],
      observedAt: new Date('2026-10-15T10:31:00.000Z'),
    });

    expect(h.loadOpenPaperPositions).toHaveBeenCalledWith({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
    });
    expect(h.hasActiveOppositeM1Intent).toHaveBeenCalledWith({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'BUY',
    });
    expect(rescue).toMatchObject({
      eligible: true,
      reason: 'SHADOW_RESCUE_CANDIDATE',
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
    expect(h.markRescueObservation).toHaveBeenCalledWith(
      'decision-current',
      expect.objectContaining({
        openTradeId: 'trade-1',
        openDecisionId: 'decision-old',
        rescue: expect.objectContaining({ executionAuthority: 'NONE', modifiesExecution: false }),
      }),
    );
    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.closeTrade).not.toHaveBeenCalled();
  });

  it('records a rescue candidate as shadow evidence without submitting or closing anything', async () => {
    const h = phase2Harness({ rollout: M1_TACTICAL_ROLLOUT_POLICY_V3 });
    const schedulerSource = fs.readFileSync(
      path.resolve(__dirname, './m1-tactical-scheduler.service.ts'),
      'utf8',
    );
    const decision = await (h.service as any).recordFailedMoveRescueShadow(
      'decision-current',
      {
        originalInvalidated: true,
        originalNetExpectedR: -0.1,
        oppositeNetExpectedR: 0.45,
        oppositeGovernanceEligible: true,
        oppositeBlockers: [],
        duplicateOppositeIntent: false,
        reversalAllowedByPolicy: true,
      },
      { openTradeId: 'trade-1', openDecisionId: 'decision-old' },
      new Date('2026-10-15T10:31:00.000Z'),
    );
    expect(decision).toMatchObject({
      eligible: true,
      reason: 'SHADOW_RESCUE_CANDIDATE',
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
    expect(h.markRescueObservation).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.closeTrade).not.toHaveBeenCalled();
    expect(schedulerSource).not.toContain('BrokerAdapter');
    expect(schedulerSource).not.toContain('BrokerService');
  });
});

describe('M1 early-transition micro PAPER phase', () => {
  const positiveShadowOutcomes = [
    { observedAt: new Date('2026-10-15T10:20:00.000Z'), netR: 1.5 },
    { observedAt: new Date('2026-10-15T09:20:00.000Z'), netR: 0.225 },
    { observedAt: new Date('2026-10-15T08:20:00.000Z'), netR: -0.195 },
  ];

  it('executes only early-transition at a 0.01 lot cap', () => {
    expect(M1_TACTICAL_ROLLOUT_POLICY_V4.phase).toBe('PAPER_EARLY_TRANSITION_MICRO');
    expect(M1_TACTICAL_ROLLOUT_POLICY_V4.paperVolumeCap).toBe(0.01);
    expect(m1RouteExecutableInPhase('PAPER_EARLY_TRANSITION_MICRO', 'M1_EARLY_TRANSITION')).toBe(
      true,
    );
    expect(m1RouteExecutableInPhase('PAPER_EARLY_TRANSITION_MICRO', 'M1_TREND_CONTINUATION')).toBe(
      false,
    );
    expect(m1RouteExecutableInPhase('PAPER_EARLY_TRANSITION_MICRO', 'M1_CONFIRMED_REVERSAL')).toBe(
      false,
    );
    expect(m1RouteExecutableInPhase('PAPER_EARLY_TRANSITION_MICRO', 'ABSTAIN')).toBe(false);
  });

  it('submits a causally qualified early-transition sleeve at micro size', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V4,
      shadowPairSideOutcomes: positiveShadowOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    const route = await driveFeatures(h, transitionFeatures());

    expect(route.route).toBe('M1_EARLY_TRANSITION');
    expect(h.loadShadowPairSideOutcomes).toHaveBeenCalledWith({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      route: 'M1_EARLY_TRANSITION',
      instrument: 'EURUSD',
      direction: 'BUY',
      policyVersion: 'm1-tactical-v1',
      evaluatedAt: new Date('2026-10-15T10:30:00.000Z'),
    });
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        suggestedVolume: 0.01,
        timeframe: 'M1',
        metadata: expect.objectContaining({
          m1_rollout_phase: 'PAPER_EARLY_TRANSITION_MICRO',
          m1_shadow_pair_side_reliability_reason: 'POSITIVE_SHADOW_EXPECTANCY',
          m1_shadow_pair_side_reliability_samples: 3,
        }),
      }),
    );
  });

  it('keeps an early-transition sleeve shadow-only until causal pair-side evidence qualifies', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V4,
      shadowPairSideOutcomes: positiveShadowOutcomes.slice(0, 2),
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    await driveFeatures(h, transitionFeatures());

    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.recordDecision.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        executionAuthority: 'NONE',
        blockers: expect.arrayContaining(['M1_SHADOW_RELIABILITY_INSUFFICIENT_SHADOW_EVIDENCE']),
      }),
    );
  });

  it('rescues only an out-of-distribution generic governance blocker for a qualified micro sleeve', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V4,
      shadowPairSideOutcomes: positiveShadowOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    const features = { ...transitionFeatures(), volatilityScore: 0.9 };

    const route = await driveFeatures(h, features);

    expect(route.route).toBe('M1_EARLY_TRANSITION');
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0].metadata).toEqual(
      expect.objectContaining({ m1_micro_drift_only_rescue: true }),
    );
  });

  it('never lets micro authority bypass event, cost, or mature actual-trade reliability blockers', async () => {
    const eventBlocked = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V4,
      shadowPairSideOutcomes: positiveShadowOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    await driveFeatures(eventBlocked, transitionFeatures(), { eventRisk: 'UNVERIFIED' });
    expect(eventBlocked.receiveSignal).not.toHaveBeenCalled();

    const costBlocked = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V4,
      shadowPairSideOutcomes: positiveShadowOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    await driveFeatures(costBlocked, transitionFeatures(), { spreadEvidence: null });
    expect(costBlocked.receiveSignal).not.toHaveBeenCalled();

    const reliabilityBlocked = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V4,
      shadowPairSideOutcomes: positiveShadowOutcomes,
      evidenceByRoute: {
        M1_EARLY_TRANSITION: [0, 1, 2].map((index) => ({
          route: 'M1_EARLY_TRANSITION',
          instrument: 'EURUSD',
          direction: 'BUY',
          policyVersion: 'm1-tactical-v1',
          realisedPnl: -1,
          closedAt: new Date(`2026-10-15T10:${20 + index}:00.000Z`),
        })),
      },
    });
    await driveFeatures(reliabilityBlocked, transitionFeatures());
    expect(reliabilityBlocked.receiveSignal).not.toHaveBeenCalled();
  });
});

describe('M1 meaningful-size shadow module wiring', () => {
  it('keeps the historical 0.01 V4 cohort immutable but makes V5 shadow-only at the 0.20 product floor', () => {
    expect(M1_TACTICAL_ROLLOUT_POLICY_V4.phase).toBe('PAPER_EARLY_TRANSITION_MICRO');
    expect(M1_TACTICAL_ROLLOUT_POLICY_V4.paperVolumeCap).toBe(0.01);
    expect(M1_TACTICAL_ROLLOUT_POLICY_V5).toMatchObject({
      version: 'm1-tactical-rollout-v5-meaningful-size-shadow',
      phase: 'SHADOW',
      paperVolumeCap: 0.2,
    });
    expect(
      m1RouteExecutableInPhase(M1_TACTICAL_ROLLOUT_POLICY_V5.phase, 'M1_EARLY_TRANSITION'),
    ).toBe(false);
  });

  it('keeps historical V5 immutable but no longer binds it as the active rollout', () => {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, './ai.module.ts'), 'utf8');
    expect(M1_TACTICAL_ROLLOUT_POLICY_V5).toMatchObject({
      version: 'm1-tactical-rollout-v5-meaningful-size-shadow',
      phase: 'SHADOW',
      paperVolumeCap: 0.2,
    });
    expect(moduleSource).not.toMatch(
      /provide:\s*M1_TACTICAL_ROLLOUT_POLICY_TOKEN[\s\S]*useValue:\s*M1_TACTICAL_ROLLOUT_POLICY_V5/,
    );
    expect(moduleSource).not.toMatch(/process\.env[^\n]*M1_TACTICAL/);
  });
});

describe('M1 early-transition meaningful 0.10 PAPER scout phase', () => {
  const matureHealthyOutcomes = [
    { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 0.74 },
    { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: 0.44 },
    { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: -0.2 },
    { observedAt: new Date('2026-10-15T09:59:00.000Z'), netR: -0.08 },
    { observedAt: new Date('2026-10-15T09:49:00.000Z'), netR: 0.46 },
    { observedAt: new Date('2026-10-15T09:39:00.000Z'), netR: -0.06 },
  ];

  it('version-gates V6 to early-transition only at a 0.10 lot cap', () => {
    expect(M1_TACTICAL_ROLLOUT_POLICY_V6).toMatchObject({
      version: 'm1-tactical-rollout-v6-early-transition-scout-010',
      phase: 'PAPER_EARLY_TRANSITION_SCOUT_010',
      paperVolumeCap: 0.1,
    });
    expect(
      m1RouteExecutableInPhase('PAPER_EARLY_TRANSITION_SCOUT_010', 'M1_EARLY_TRANSITION'),
    ).toBe(true);
    expect(
      m1RouteExecutableInPhase('PAPER_EARLY_TRANSITION_SCOUT_010', 'M1_TREND_CONTINUATION'),
    ).toBe(false);
    expect(
      m1RouteExecutableInPhase('PAPER_EARLY_TRANSITION_SCOUT_010', 'M1_CONFIRMED_REVERSAL'),
    ).toBe(false);
  });

  it('submits only a mature healthy early-transition sleeve at 0.10 lots with explicit sizing provenance', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V6,
      shadowPairSideOutcomes: matureHealthyOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    const route = await driveFeatures(h, transitionFeatures());

    expect(route.route).toBe('M1_EARLY_TRANSITION');
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        suggestedVolume: 0.1,
        timeframe: 'M1',
        strategyCode: 'external-irexpro-m1-tactical',
        metadata: expect.objectContaining({
          m1_rollout_phase: 'PAPER_EARLY_TRANSITION_SCOUT_010',
          m1_evidence_qualified_scout_eligible: true,
          m1_meaningful_scout_reliability_artifact: 'm1-meaningful-scout-reliability-v1',
          m1_meaningful_scout_reliability_samples: 6,
          m1_meaningful_scout_reliability_recent_net_r: expect.any(Number),
        }),
      }),
    );
  });

  it('executes a mature healthy local-impulse scout despite bounded HTF drift conflict', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V6,
      shadowPairSideOutcomes: matureHealthyOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    const features = {
      ...transitionFeatures(),
      emaSeparationAtr: 1.04,
      emaSlopeAtr: 0.54,
      momentum1Atr: 0.38,
      momentum3Atr: 2.01,
      momentum5Atr: 2.87,
      alignment: { m5: 1, m15: -0.27, h1: -0.37, h4: 0.3 },
      higherTimeframeAgreement: -0.336,
      efficiency5: 0.82,
      closeLocation: 0.9,
      extensionAtr: 0.4,
      volatilityScore: 0.28,
    };

    const route = await driveFeatures(h, features);

    expect(route).toMatchObject({
      route: 'M1_EARLY_TRANSITION',
      direction: 'BUY',
      reason: 'LOCAL_IMPULSE_AGAINST_HTF',
      eligible: true,
    });
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        suggestedVolume: 0.1,
        timeframe: 'M1',
        metadata: expect.objectContaining({
          m1_evidence_qualified_scout_eligible: true,
          m1_local_impulse_drift_only_rescue: true,
        }),
      }),
    );
  });

  it('keeps a strong three-sample sleeve shadow-only until meaningful evidence matures', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V6,
      shadowPairSideOutcomes: matureHealthyOutcomes.slice(0, 3),
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    await driveFeatures(h, transitionFeatures());

    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.recordDecision.mock.calls[0]![0].blockers).toEqual(
      expect.arrayContaining(['M1_MEANINGFUL_SCOUT_RELIABILITY_INSUFFICIENT_MEANINGFUL_EVIDENCE']),
    );
  });

  it('does not carry the legacy micro OOD-only rescue into meaningful 0.10 sizing', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V6,
      shadowPairSideOutcomes: matureHealthyOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    const features = { ...transitionFeatures(), volatilityScore: 0.9 };

    const route = await driveFeatures(h, features);

    expect(route.route).toBe('M1_EARLY_TRANSITION');
    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.recordDecision.mock.calls[0]![0].blockers).toEqual(
      expect.arrayContaining(['DRIFT_OUT_OF_DISTRIBUTION']),
    );
  });

  it('keeps continuation and confirmed-reversal shadow-only in V6', async () => {
    const continuation = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V6,
      shadowPairSideOutcomes: matureHealthyOutcomes,
    });
    await driveCleanContinuation(continuation);
    expect(continuation.receiveSignal).not.toHaveBeenCalled();

    const reversal = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V6,
      shadowPairSideOutcomes: matureHealthyOutcomes,
    });
    const route = await driveFeatures(reversal, reversalFeatures());
    expect(route.route).toBe('M1_CONFIRMED_REVERSAL');
    expect(reversal.receiveSignal).not.toHaveBeenCalled();
  });

  it('keeps historical V6 immutable but no longer binds it once v7 is active', () => {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, './ai.module.ts'), 'utf8');
    expect(M1_TACTICAL_ROLLOUT_POLICY_V6).toMatchObject({
      version: 'm1-tactical-rollout-v6-early-transition-scout-010',
      phase: 'PAPER_EARLY_TRANSITION_SCOUT_010',
      paperVolumeCap: 0.1,
    });
    expect(moduleSource).not.toMatch(
      /provide:\s*M1_TACTICAL_ROLLOUT_POLICY_TOKEN[\s\S]*useValue:\s*M1_TACTICAL_ROLLOUT_POLICY_V6/,
    );
  });
});

describe('M1 early-transition tiered v7 PAPER scout', () => {
  const strongProvisionalOutcomes = [
    { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 1.5 },
    { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: 0.3 },
    { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: -0.2 },
  ];
  const matureHealthyOutcomes = [
    { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 0.74 },
    { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: 0.44 },
    { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: -0.2 },
    { observedAt: new Date('2026-10-15T09:59:00.000Z'), netR: -0.08 },
    { observedAt: new Date('2026-10-15T09:49:00.000Z'), netR: 0.46 },
    { observedAt: new Date('2026-10-15T09:39:00.000Z'), netR: -0.06 },
  ];

  it('version-gates v7 to early-transition and keeps trend/reversal shadow-only', () => {
    expect(M1_TACTICAL_ROLLOUT_POLICY_V7).toMatchObject({
      version: 'm1-tactical-rollout-v7-early-transition-tiered-scout',
      phase: 'PAPER_EARLY_TRANSITION_SCOUT_TIERED',
      paperVolumeCap: 0.1,
    });
    expect(
      m1RouteExecutableInPhase(M1_TACTICAL_ROLLOUT_POLICY_V7.phase, 'M1_EARLY_TRANSITION'),
    ).toBe(true);
    expect(
      m1RouteExecutableInPhase(M1_TACTICAL_ROLLOUT_POLICY_V7.phase, 'M1_TREND_CONTINUATION'),
    ).toBe(false);
    expect(
      m1RouteExecutableInPhase(M1_TACTICAL_ROLLOUT_POLICY_V7.phase, 'M1_CONFIRMED_REVERSAL'),
    ).toBe(false);
  });

  it('executes a strong three-sample provisional sleeve at 0.05 lots with explicit provenance', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V7,
      shadowPairSideOutcomes: strongProvisionalOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    await driveFeatures(h, transitionFeatures());

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        suggestedVolume: 0.05,
        metadata: expect.objectContaining({
          m1_rollout_phase: 'PAPER_EARLY_TRANSITION_SCOUT_TIERED',
          m1_scout_reliability_tier: 'PROVISIONAL',
          m1_provisional_scout_reliability_artifact: 'm1-provisional-scout-reliability-v1',
          m1_provisional_scout_reliability_samples: 3,
          m1_provisional_scout_reliability_recent_net_r: expect.any(Number),
        }),
      }),
    );
  });

  it('keeps a mature healthy sleeve at the existing 0.10 meaningful tier', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V7,
      shadowPairSideOutcomes: matureHealthyOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    await driveFeatures(h, transitionFeatures());

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        suggestedVolume: 0.1,
        metadata: expect.objectContaining({
          m1_scout_reliability_tier: 'MATURE',
          m1_meaningful_scout_reliability_artifact: 'm1-meaningful-scout-reliability-v1',
          m1_meaningful_scout_reliability_samples: 6,
          m1_provisional_scout_reliability_artifact: null,
        }),
      }),
    );
  });

  it('binds AiModule to the tiered v7 rollout', () => {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, './ai.module.ts'), 'utf8');
    expect(moduleSource).toContain('M1_TACTICAL_ROLLOUT_POLICY_V7');
    expect(moduleSource).toMatch(
      /provide:\s*M1_TACTICAL_ROLLOUT_POLICY_TOKEN[\s\S]*useValue:\s*M1_TACTICAL_ROLLOUT_POLICY_V7/,
    );
  });

  it('does not let weak mature evidence fall back to the provisional tier', async () => {
    const weakMature = [
      { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 0.4 },
      { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: -0.8 },
      { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: 0.2 },
      { observedAt: new Date('2026-10-15T09:59:00.000Z'), netR: -0.6 },
      { observedAt: new Date('2026-10-15T09:49:00.000Z'), netR: 0.1 },
      { observedAt: new Date('2026-10-15T09:39:00.000Z'), netR: -0.5 },
    ];
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V7,
      shadowPairSideOutcomes: weakMature,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    await driveFeatures(h, transitionFeatures());

    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.recordDecision.mock.calls[0]![0].blockers).toEqual(
      expect.arrayContaining([expect.stringContaining('M1_TIERED_SCOUT_RELIABILITY_')]),
    );
  });
});
