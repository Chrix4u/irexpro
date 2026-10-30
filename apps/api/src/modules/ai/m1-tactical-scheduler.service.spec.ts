import * as fs from 'fs';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import type { LivePaperCandleInput } from '../broker/services/live-paper-market-data.service';
import type { AiSignalService } from './ai-signal.service';
import type { ExecutionService } from '../execution/execution.service';
import type { TradeIntentService } from '../execution/services/trade-intent.service';
import type { AllocationService } from '../execution/services/allocation.service';
import type { HighConvictionBrokerExpertService } from './high-conviction-broker-expert.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { M1_TACTICAL_POLICY_V2, buildM1TacticalCandidates } from './m1-tactical-candidate';
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
  M1_TACTICAL_ROLLOUT_POLICY_V8,
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
    expect(
      m1ShadowOutcomeEligible({
        routeEligible: true,
        route: 'M1_EARLY_TRANSITION',
        routeReason: 'EARLY_TRANSITION_IMPULSE',
        routePayoffEligible: true,
        blockers: ['M1_TIERED_SCOUT_RELIABILITY_WEAK_PROVISIONAL_EXPECTANCY'],
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

  it('finds the largest clear professional intermediate cap instead of falling straight from 4.0 to 0.20', async () => {
    const { service } = guardHarness(900, []);
    const professionalCandidate = {
      instrument: 'EURUSD',
      direction: 'BUY',
      entry: 1.1123,
      stopLoss: 1.1118,
    } as any;

    await expect(
      (service as any).resolveM1CurrencyExposureGuard(
        'user-1',
        'conn-1',
        professionalCandidate,
        4,
      ),
    ).resolves.toMatchObject({
      allowed: true,
      volumeCap: 0.35,
      decision: { capacity: 'CLEAR' },
      productFloorBlocked: false,
    });
  });

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
    interval.mockRestore();
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
      expect(row.policyVersion).toBe('m1-tactical-v2-m5-lifecycle');
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
      policyVersion: 'm1-tactical-v2-m5-lifecycle',
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
              policyVersion: 'm1-tactical-v2-m5-lifecycle',
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
      policyVersion: 'm1-tactical-v2-m5-lifecycle',
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
        policyVersion: 'm1-tactical-v2-m5-lifecycle',
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
              policyVersion: 'm1-tactical-v2-m5-lifecycle',
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
              policyVersion: 'm1-tactical-v2-m5-lifecycle',
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
    m5BodyPressure3: 0.35,
    m5Momentum1Atr: 0.22,
    m5Momentum3Atr: 0.48,
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
    currentSession?: Record<string, unknown> | null;
    macroState?: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
    spreadUsable?: boolean;
    reliabilityLosses?: number;
    signalOutcome?: 'EXECUTION_SUCCEEDED' | 'RISK_REJECTED';
    rollout?: any;
    evidenceByRoute?: Record<string, any[]>;
    shadowPairSideOutcomes?: Array<{ observedAt: Date; netR: number }>;
    shadowPairSideOutcomesByConnection?: Record<string, Array<{ observedAt: Date; netR: number }>>;
    openPositions?: any[];
    duplicateOppositeIntent?: boolean;
    duplicateSameDirectionIntent?: boolean;
    tradeIntentId?: string | null;
    m5EarlyTransitionEvidence?: {
      instrument: string;
      direction: 'BUY' | 'SELL';
      marketBarTime: Date;
      evaluatedAt: Date;
      strategyRoute: string;
      paperAdmitted: boolean;
      paperExecutionEligible: boolean;
      eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
      driftState: string;
      netExpectedR: number;
      ensembleScore: number;
      consensusPassed: number;
      consensusRequired: number;
    } | null;
    fastStopBrake?: {
      active: boolean;
      reason: 'CLEAR' | 'RECENT_FAST_STOP';
      latestFastStopClosedAt: Date | null;
      latestFastStopDurationMinutes: number | null;
      cooldownMinutes: number;
      maxStopDurationMinutes: number;
    };
    multimodelLossStreakBrake?: {
      artifact: 'm1-multimodel-loss-streak-brake-v1';
      active: boolean;
      reason: 'CLEAR' | 'RECENT_MULTIMODEL_LOSS_STREAK';
      strategyRoute: 'TREND_CONTINUATION' | 'CONFIRMED_REVERSAL' | 'EARLY_TRANSITION';
      recentClosedTrades: number;
      recentLosses: number;
      recentWins: number;
      cumulativeRealisedPnl: number;
      latestClosedAt: Date | null;
      cooldownHours: number;
      cooldownRemainingSeconds: number;
    };
    trainedExpertState?: 'CONFIRM' | 'CONFLICT' | 'ABSTAIN' | 'STALE' | 'UNAVAILABLE';
    trainedExpertDirection?: 'BUY' | 'SELL';
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
        'vpsForexScanner.m1MarketDataConnectionId': 'demo-conn-1',
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
    policyVersion: 'm1-tactical-v2-m5-lifecycle',
    realisedPnl: -1,
    closedAt: new Date(`2026-10-15T10:${20 + index}:00.000Z`),
  }));
  const loadRoutePairSideEvidence = jest.fn(
    async (request: any) => options.evidenceByRoute?.[request.route] ?? continuationLosses,
  );
  const loadShadowPairSideOutcomes = jest.fn(async (request: any) => {
    return (
      options.shadowPairSideOutcomesByConnection?.[request.brokerConnectionId] ??
      options.shadowPairSideOutcomes ??
      []
    );
  });
  const markExecutionLink = jest.fn().mockResolvedValue(undefined);
  const markOutcomeState = jest.fn().mockResolvedValue(undefined);
  const loadOpenPaperPositions = jest.fn().mockResolvedValue(options.openPositions ?? []);
  const loadOpenPaperRiskPositions = jest.fn().mockResolvedValue([]);
  const loadLatestM5EarlyTransitionEvidence = jest
    .fn()
    .mockResolvedValue(options.m5EarlyTransitionEvidence ?? null);
  const loadFastStopRegimeBrake = jest.fn().mockResolvedValue(
    options.fastStopBrake ?? {
      active: false,
      reason: 'CLEAR',
      latestFastStopClosedAt: null,
      latestFastStopDurationMinutes: null,
      cooldownMinutes: 5,
      maxStopDurationMinutes: 2,
    },
  );
  const loadMultimodelLossStreakBrake = jest.fn().mockResolvedValue(
    options.multimodelLossStreakBrake ?? { artifact: 'm1-multimodel-loss-streak-brake-v1', active: false, reason: 'CLEAR', strategyRoute: 'TREND_CONTINUATION', recentClosedTrades: 0, recentLosses: 0, recentWins: 0, cumulativeRealisedPnl: 0, latestClosedAt: null, cooldownHours: 12, cooldownRemainingSeconds: 0 },
  );
  const hasActiveM1Intent = jest
    .fn()
    .mockResolvedValue(options.duplicateSameDirectionIntent ?? false);
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
    loadLatestM5EarlyTransitionEvidence,
    loadFastStopRegimeBrake,
    loadMultimodelLossStreakBrake,
    hasActiveM1Intent,
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
  const getActiveSessionForClient = jest
    .fn()
    .mockResolvedValue(options.currentSession === undefined ? null : options.currentSession);
  const closeTrade = jest.fn();
  const execution = {
    getActiveSession,
    getActiveSessionForClient,
    closeTrade,
  } as unknown as ExecutionService;
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
  const trainedExpertEvaluate = jest.fn().mockImplementation(async (input: any) => {
    const state = options.trainedExpertState ?? 'CONFIRM';
    const direction = options.trainedExpertDirection ?? input.candidateDirection;
    return {
      state,
      reason: state === 'UNAVAILABLE' ? 'BROKER_MARKET_DATA_UNAVAILABLE' : null,
      decisionTime: input.candidateCloseTime.toISOString(),
      freshnessSeconds: 0,
      allBrokerNative: state !== 'STALE',
      direction: state === 'ABSTAIN' || state === 'UNAVAILABLE' ? null : direction,
      admitted: state === 'CONFIRM' || state === 'CONFLICT',
      ensembleConfidence: 0.76,
      meanOpportunityProbability: 0.63,
      longVotes: direction === 'BUY' ? 3 : 0,
      shortVotes: direction === 'SELL' ? 3 : 0,
      regime: 'calm',
      modifiesExecution: false,
    };
  });
  const highConvictionExpert = {
    evaluate: trainedExpertEvaluate,
  } as unknown as HighConvictionBrokerExpertService;
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
  (service as any).highConvictionBrokerExpert = highConvictionExpert;
  return {
    service,
    recordDecision,
    loadRoutePairSideEvidence,
    loadShadowPairSideOutcomes,
    markExecutionLink,
    markOutcomeState,
    receiveSignal,
    getActiveSession,
    getActiveSessionForClient,
    closeTrade,
    loadOpenPaperPositions,
    loadOpenPaperRiskPositions,
    loadLatestM5EarlyTransitionEvidence,
    loadFastStopRegimeBrake,
    loadMultimodelLossStreakBrake,
    hasActiveM1Intent,
    hasActiveOppositeM1Intent,
    markRescueObservation,
    loadPendingDriftCounterfactuals,
    markDriftCounterfactual15m,
    findBySignal,
    trainedExpertEvaluate,
    loadSnapshot: (marketData as any).loadSnapshot as jest.Mock,
  };
}

describe('M1 tactical scheduler broker binding', () => {
  it('binds professional DEMO V8 execution to the broker-native M1 connection', () => {
    const { service } = phase2Harness({ rollout: M1_TACTICAL_ROLLOUT_POLICY_V8 });

    expect((service as any).connectionId()).toBe('demo-conn-1');
  });

  it('reports promoted DEMO authority in V8 startup telemetry', () => {
    const { service } = phase2Harness({ rollout: M1_TACTICAL_ROLLOUT_POLICY_V8 });
    const log = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    service.onModuleInit();
    service.onModuleDestroy();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('authority=DEMO_FULL_AUTO_PROMOTED'));
  });

  it('keeps PAPER rollout execution bound to the research paper connection', () => {
    const { service } = phase2Harness({ rollout: M1_TACTICAL_ROLLOUT_POLICY_V7 });

    expect((service as any).connectionId()).toBe('conn-1');
  });
});

async function driveCleanContinuation(
  h: ReturnType<typeof phase2Harness>,
  options: { spreadUsable?: boolean } = {},
) {
  const features = cleanContinuationFeatures();
  const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V2);
  const route = classifyM1TacticalRoute(buy, sell, features, M1_TACTICAL_POLICY_V2);
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
      modelVersion: 'external-provider/irexpro-m1-tactical/m1-tactical-v2-m5-lifecycle',
      marketRegime: 'TREND_HEALTHY',
      metadata: expect.objectContaining({
        external_provider_paper_only: true,
        production_eligible: false,
        position_sizing_tier: 'RESEARCH',
        m1_tactical_route: 'M1_TREND_CONTINUATION',
        m1_policy_version: 'm1-tactical-v2-m5-lifecycle',
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
    const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V2);

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
    const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V2);
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

  it('blocks an otherwise executable pair-side for five minutes after an unusually fast stop-out', async () => {
    const h = phase2Harness({
      fastStopBrake: {
        active: true,
        reason: 'RECENT_FAST_STOP',
        latestFastStopClosedAt: new Date('2026-10-15T10:28:30.000Z'),
        latestFastStopDurationMinutes: 0.75,
        cooldownMinutes: 5,
        maxStopDurationMinutes: 2,
      },
    });

    await driveCleanContinuation(h);

    expect(h.loadFastStopRegimeBrake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        brokerConnectionId: 'conn-1',
        instrument: 'EURUSD',
        direction: 'BUY',
      }),
    );
    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAuthority: 'NONE',
        blockers: expect.arrayContaining(['M1_FAST_STOP_REGIME_BRAKE']),
        governance: expect.objectContaining({
          fastStopRegimeBrake: expect.objectContaining({
            active: true,
            reason: 'RECENT_FAST_STOP',
          }),
        }),
      }),
    );
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
    // 0.28 remains an M1 early-transition structure while mapping to the
    // frozen Plan-B transition minimum (0.14 after the historical /2 scale).
    emaSeparationAtr: 0.28,
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
    brokerConnectionId?: string;
  } = {},
) {
  const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V2);
  const route = classifyM1TacticalRoute(buy, sell, features, M1_TACTICAL_POLICY_V2);
  await (h.service as any).persistCandidate(
    'user-1',
    options.brokerConnectionId ?? 'conn-1',
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

  it('uses a distinct M5-lifecycle policy version so pre-lifecycle losses cannot veto fresh timing evidence', async () => {
    const h = phase2Harness();

    await driveCleanContinuation(h);

    expect(h.loadRoutePairSideEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPolicyVersion: 'm1-tactical-v2-m5-lifecycle',
        compatiblePolicyVersions: ['m1-tactical-v2-m5-lifecycle'],
      }),
    );
    expect(h.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ policyVersion: 'm1-tactical-v2-m5-lifecycle' }),
    );
  });

  it('qualifies reversal only from the reversal route evidence key and never borrows continuation losses', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V3,
      evidenceByRoute: {
        M1_TREND_CONTINUATION: Array.from({ length: 3 }, () => ({
          route: 'M1_TREND_CONTINUATION',
          instrument: 'EURUSD',
          direction: 'BUY',
          policyVersion: 'm1-tactical-v2-m5-lifecycle',
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

  it('preserves same pair-side participation while realised reliability remains eligible', async () => {
    const h = phase2Harness({ duplicateSameDirectionIntent: true });

    await driveCleanContinuation(h);

    expect(h.hasActiveM1Intent).not.toHaveBeenCalled();
    expect(h.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        blockers: expect.not.arrayContaining(['M1_ACTIVE_PAIR_SIDE_INTENT']),
        executionAuthority: 'PAPER_ONLY_RESEARCH',
      }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
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
          policyVersion: 'm1-tactical-v2-m5-lifecycle',
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
      policyVersion: 'm1-tactical-v2-m5-lifecycle',
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
          policyVersion: 'm1-tactical-v2-m5-lifecycle',
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

  it('keeps the tiered v7 rollout immutable but no longer binds it once v8 is active', () => {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, './ai.module.ts'), 'utf8');
    expect(M1_TACTICAL_ROLLOUT_POLICY_V7).toMatchObject({
      version: 'm1-tactical-rollout-v7-early-transition-tiered-scout',
      phase: 'PAPER_EARLY_TRANSITION_SCOUT_TIERED',
      paperVolumeCap: 0.1,
    });
    expect(moduleSource).not.toMatch(
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

describe('M1 professional v8 DEMO promotion', () => {
  const matureHealthyOutcomes = [
    { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 0.74 },
    { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: 0.44 },
    { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: -0.2 },
    { observedAt: new Date('2026-10-15T09:59:00.000Z'), netR: -0.08 },
    { observedAt: new Date('2026-10-15T09:49:00.000Z'), netR: 0.46 },
    { observedAt: new Date('2026-10-15T09:39:00.000Z'), netR: -0.06 },
  ];

  it('keeps the validated early-transition route but replaces the scout cap with a 4.00 professional ceiling', () => {
    expect(M1_TACTICAL_ROLLOUT_POLICY_V8).toMatchObject({
      version: 'm1-tactical-rollout-v8-demo-professional',
      phase: 'DEMO_EARLY_TRANSITION_PROFESSIONAL',
      paperVolumeCap: 4,
    });
    expect(
      m1RouteExecutableInPhase(M1_TACTICAL_ROLLOUT_POLICY_V8.phase, 'M1_EARLY_TRANSITION'),
    ).toBe(true);
    expect(
      m1RouteExecutableInPhase(M1_TACTICAL_ROLLOUT_POLICY_V8.phase, 'M1_TREND_CONTINUATION'),
    ).toBe(false);
    expect(
      m1RouteExecutableInPhase(M1_TACTICAL_ROLLOUT_POLICY_V8.phase, 'M1_CONFIRMED_REVERSAL'),
    ).toBe(false);
  });

  it('binds AiModule to v8 and leaves v7 immutable for historical evidence', () => {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, './ai.module.ts'), 'utf8');
    expect(M1_TACTICAL_ROLLOUT_POLICY_V7).toMatchObject({
      version: 'm1-tactical-rollout-v7-early-transition-tiered-scout',
      paperVolumeCap: 0.1,
    });
    expect(moduleSource).toContain('M1_TACTICAL_ROLLOUT_POLICY_V8');
    expect(moduleSource).toMatch(
      /provide:\s*M1_TACTICAL_ROLLOUT_POLICY_TOKEN[\s\S]*useValue:\s*M1_TACTICAL_ROLLOUT_POLICY_V8/,
    );
  });

  it('uses the active FULL_AUTO session connection for V8 market-data routing instead of the configured paper connection', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: {
        id: 'session-demo-1',
        executionMode: ExecutionMode.FULL_AUTO,
        brokerConnectionId: 'demo-conn-2',
      },
    });
    h.loadSnapshot.mockResolvedValue(null);

    await h.service.runOnce(new Date('2026-10-15T10:30:00.000Z'));

    expect(h.loadSnapshot).toHaveBeenCalledWith(
      'demo-conn-2',
      'EURUSD',
      new Date('2026-10-15T10:30:00.000Z'),
    );
  });

  it('bootstraps V8 provisional reliability from at most three compatible paper outcomes until cTrader has its own minimum sample', async () => {
    const bootstrapOutcomes = [
      { observedAt: new Date('2026-10-15T10:20:00.000Z'), netR: 0.6 },
      { observedAt: new Date('2026-10-15T10:10:00.000Z'), netR: 0.4 },
      { observedAt: new Date('2026-10-15T10:00:00.000Z'), netR: -0.1 },
    ];
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: {
        id: 'session-demo-1',
        executionMode: ExecutionMode.FULL_AUTO,
        brokerConnectionId: 'demo-conn-2',
      },
      shadowPairSideOutcomesByConnection: {
        'demo-conn-2': [],
        'conn-1': bootstrapOutcomes,
      },
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    await driveFeatures(h, transitionFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.loadShadowPairSideOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ brokerConnectionId: 'demo-conn-2' }),
    );
    expect(h.loadShadowPairSideOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ brokerConnectionId: 'conn-1' }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0].metadata).toEqual(
      expect.objectContaining({
        m1_scout_broker_native_reliability_samples: 0,
        m1_scout_bootstrap_reliability_samples: 3,
        m1_scout_evidence_connection_ids: ['demo-conn-2', 'conn-1'],
      }),
    );
  });

  it('stops using paper bootstrap evidence once cTrader has three native reliability samples', async () => {
    const nativeOutcomes = [
      { observedAt: new Date('2026-10-15T10:20:00.000Z'), netR: 0.6 },
      { observedAt: new Date('2026-10-15T10:10:00.000Z'), netR: 0.4 },
      { observedAt: new Date('2026-10-15T10:00:00.000Z'), netR: -0.1 },
    ];
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: {
        id: 'session-demo-1',
        executionMode: ExecutionMode.FULL_AUTO,
        brokerConnectionId: 'demo-conn-2',
      },
      shadowPairSideOutcomesByConnection: {
        'demo-conn-2': nativeOutcomes,
        'conn-1': [
          { observedAt: new Date('2026-10-15T10:25:00.000Z'), netR: 1.2 },
          { observedAt: new Date('2026-10-15T10:15:00.000Z'), netR: 1.1 },
          { observedAt: new Date('2026-10-15T10:05:00.000Z'), netR: 1.0 },
        ],
      },
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    await driveFeatures(h, transitionFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.loadShadowPairSideOutcomes).toHaveBeenCalledTimes(1);
    expect(h.loadShadowPairSideOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ brokerConnectionId: 'demo-conn-2' }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0].metadata).toEqual(
      expect.objectContaining({
        m1_scout_broker_native_reliability_samples: 3,
        m1_scout_bootstrap_reliability_samples: 0,
        m1_scout_evidence_connection_ids: ['demo-conn-2'],
      }),
    );
  });

  it('halves adaptive risk after the first exact pair/side winner-to-loser giveback while keeping the setup eligible', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: {
        id: 'session-demo-1',
        executionMode: ExecutionMode.FULL_AUTO,
        brokerConnectionId: 'demo-conn-2',
      },
      shadowPairSideOutcomes: [
        { observedAt: new Date('2026-10-15T10:20:00.000Z'), netR: 0.74 },
        { observedAt: new Date('2026-10-15T10:10:00.000Z'), netR: 0.44 },
        { observedAt: new Date('2026-10-15T10:00:00.000Z'), netR: -0.1 },
        { observedAt: new Date('2026-10-15T09:50:00.000Z'), netR: 0.3 },
        { observedAt: new Date('2026-10-15T09:40:00.000Z'), netR: -0.05 },
        { observedAt: new Date('2026-10-15T09:30:00.000Z'), netR: 0.2 },
      ],
      evidenceByRoute: {
        M1_EARLY_TRANSITION: [{
          route: 'M1_EARLY_TRANSITION', instrument: 'EURUSD', direction: 'BUY',
          policyVersion: 'm1-tactical-v2-m5-lifecycle', realisedPnl: -9, riskAtStop: 9,
          maxFavorablePnl: 6, profitGiveback: 15,
          closedAt: new Date('2026-10-15T10:25:00.000Z'),
        }],
      },
    });

    await driveFeatures(h, transitionFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0].metadata).toEqual(
      expect.objectContaining({
        adaptive_risk_multiplier: 0.5,
        m1_route_reliability_reason: 'PROFIT_GIVEBACK_CAUTION',
      }),
    );
  });

  it('follows the exact active FULL_AUTO DEMO session connection and emits a professional-sized M1 candidate', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: {
        id: 'session-demo-1',
        executionMode: ExecutionMode.FULL_AUTO,
        brokerConnectionId: 'demo-conn-2',
      },
      shadowPairSideOutcomes: matureHealthyOutcomes,
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });

    await driveFeatures(h, transitionFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    const signal = h.receiveSignal.mock.calls[0]![0];
    expect(signal.brokerConnectionId).toBe('demo-conn-2');
    expect(signal.suggestedVolume).toBeGreaterThanOrEqual(0.2);
    expect(signal.suggestedVolume).toBeLessThanOrEqual(4);
    expect(signal.metadata).toEqual(
      expect.objectContaining({
        m1_rollout_phase: 'DEMO_EARLY_TRANSITION_PROFESSIONAL',
        position_sizing_tier: expect.stringMatching(/^(BASE|STRONG|VERY_STRONG|ELITE)$/),
        feature_candidate_score: expect.any(Number),
        feature_extension_atr: expect.any(Number),
        feature_volatility_score: expect.any(Number),
        feature_ema_separation: expect.any(Number),
        feature_mtf_strength: expect.any(Number),
        feature_rsi14: expect.any(Number),
      }),
    );
  });
});


describe('M1 V8 multi-model DEMO authority', () => {
  const fullAutoSession = {
    id: 'session-demo-1',
    executionMode: ExecutionMode.FULL_AUTO,
    brokerConnectionId: 'demo-conn-2',
  };

  it('promotes a fresh durable M5 early transition as a 0.20 DEMO canary when cTrader M1 confirms continuation', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: [] },
      m5EarlyTransitionEvidence: {
        instrument: 'EURUSD',
        direction: 'BUY',
        marketBarTime: new Date('2026-10-15T10:25:00.000Z'),
        evaluatedAt: new Date('2026-10-15T10:29:00.000Z'),
        strategyRoute: 'EARLY_TRANSITION',
        paperAdmitted: true,
        paperExecutionEligible: true,
        eventRisk: 'CLEAR',
        driftState: 'NORMAL',
        netExpectedR: 0.31,
        ensembleScore: 0.66,
        consensusPassed: 7,
        consensusRequired: 6,
      },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: { ...result.ensemble, strategyRoute: 'TREND_CONTINUATION', paperAdmitted: false },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
        },
      };
    });

    const route = await driveFeatures(h, cleanContinuationFeatures(), {
      brokerConnectionId: 'demo-conn-2',
    });

    expect(route.route).toBe('M1_TREND_CONTINUATION');
    expect(h.loadLatestM5EarlyTransitionEvidence).toHaveBeenCalledWith({
      userId: 'user-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      asOf: new Date('2026-10-15T10:30:00.000Z'),
    });
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerConnectionId: 'demo-conn-2',
        suggestedVolume: 0.2,
        strategyCode: 'external-irexpro-multimodel-ensemble',
        metadata: expect.objectContaining({
          multimodel_execution_authority_path: 'M5_EARLY_TRANSITION_HANDOFF',
          m5_early_transition_handoff: true,
          m5_early_transition_handoff_reason: 'M5_EARLY_TRANSITION_M1_CONFIRMED_PROBE',
          m5_early_transition_net_expected_r: 0.31,
        }),
      }),
    );
  });

  it('keeps the M5 early-transition canary blocked after three recent losses on the same demo pair-side-route', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: [] },
      m5EarlyTransitionEvidence: {
        instrument: 'EURUSD',
        direction: 'BUY',
        marketBarTime: new Date('2026-10-15T10:25:00.000Z'),
        evaluatedAt: new Date('2026-10-15T10:29:00.000Z'),
        strategyRoute: 'EARLY_TRANSITION',
        paperAdmitted: true,
        paperExecutionEligible: true,
        eventRisk: 'CLEAR',
        driftState: 'NORMAL',
        netExpectedR: 0.31,
        ensembleScore: 0.66,
        consensusPassed: 7,
        consensusRequired: 6,
      },
      multimodelLossStreakBrake: {
        artifact: 'm1-multimodel-loss-streak-brake-v1',
        active: true,
        reason: 'RECENT_MULTIMODEL_LOSS_STREAK',
        strategyRoute: 'EARLY_TRANSITION',
        recentClosedTrades: 3,
        recentLosses: 3,
        recentWins: 0,
        cumulativeRealisedPnl: -24.37,
        latestClosedAt: new Date('2026-10-15T10:27:00.000Z'),
        cooldownHours: 12,
        cooldownRemainingSeconds: 42_900,
      },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: { ...result.ensemble, strategyRoute: 'TREND_CONTINUATION', paperAdmitted: false },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
        },
      };
    });

    await driveFeatures(h, cleanContinuationFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.loadMultimodelLossStreakBrake).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerConnectionId: 'demo-conn-2',
        instrument: 'EURUSD',
        direction: 'BUY',
        strategyRoute: 'EARLY_TRANSITION',
      }),
    );
    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.direction === 'BUY' && value.route === 'M1_TREND_CONTINUATION',
    )?.[0];
    expect(recorded?.blockers).toContain('M1_MULTIMODEL_LOSS_STREAK_BRAKE');
  });

  it('bootstraps a strong cold-start M1 continuation at the conservative cap without Plan-B admission', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: [] },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest
      .spyOn(h.service as any, 'evaluateDemoMultimodel')
      .mockImplementation(async (...args: any[]) => {
        const result = await original(...args);
        return {
          ...result,
          ensemble: {
            ...result.ensemble,
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: false,
            admitted: false,
          },
          authority: {
            ...result.authority,
            executable: false,
            authorityPath: 'BLOCKED',
            rescueVolumeCap: null,
            blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED', 'MULTIMODEL_GOVERNANCE_BLOCKED'],
          },
        };
      });

    const route = await driveFeatures(h, cleanContinuationFeatures(), {
      brokerConnectionId: 'demo-conn-2',
    });

    expect(route).toEqual(
      expect.objectContaining({ route: 'M1_TREND_CONTINUATION', eligible: true }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        suggestedVolume: 0.2,
        strategyCode: 'external-irexpro-m1-tactical',
        metadata: expect.objectContaining({
          m1_professional_fallback: true,
          m1_professional_fallback_tier: 'BOOTSTRAP_CONTINUATION',
          m1_tactical_route: 'M1_TREND_CONTINUATION',
        }),
      }),
    );
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.executionAuthority).toBe('BROKER_NATIVE');
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({
        eligible: true,
        tier: 'BOOTSTRAP_CONTINUATION',
        reason: 'M1_COLD_START_CONTINUATION_BOOTSTRAP',
        lotCap: 0.2,
      }),
    );
  });

  it('allows strong non-extended cold-start continuation through a drift-only OOD veto', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: [] },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest
      .spyOn(h.service as any, 'evaluateDemoMultimodel')
      .mockImplementation(async (...args: any[]) => {
        const result = await original(...args);
        return {
          ...result,
          ensemble: {
            ...result.ensemble,
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: false,
          },
          authority: {
            ...result.authority,
            executable: false,
            authorityPath: 'BLOCKED',
            rescueVolumeCap: null,
            blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
          },
        };
      });
    const driftOnly = cleanContinuationFeatures();
    driftOnly.rsi14 = 70;

    await driveFeatures(h, driftOnly, { brokerConnectionId: 'demo-conn-2' });

    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.governance.genericGovernance.driftState).toBe('OUT_OF_DISTRIBUTION');
    expect(recorded?.governance.genericGovernance.paperExecutionBlockers).toEqual([
      'DRIFT_OUT_OF_DISTRIBUTION',
    ]);
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({ eligible: true, tier: 'BOOTSTRAP_CONTINUATION' }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
  });

  it('bootstraps an early-stage continuation before M5 alignment fully turns', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: [] },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest
      .spyOn(h.service as any, 'evaluateDemoMultimodel')
      .mockImplementation(async (...args: any[]) => {
        const result = await original(...args);
        return {
          ...result,
          ensemble: {
            ...result.ensemble,
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: false,
          },
          authority: {
            ...result.authority,
            executable: false,
            authorityPath: 'BLOCKED',
            rescueVolumeCap: null,
            blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
          },
        };
      });
    const earlyStage = cleanContinuationFeatures();
    earlyStage.alignment.m5 = -0.13;
    earlyStage.m5BodyPressure3 = 0.063;
    earlyStage.m5Momentum1Atr = 0.171;
    earlyStage.m5Momentum3Atr = 0.256;
    earlyStage.extensionAtr = 1.256;

    const route = await driveFeatures(h, earlyStage, { brokerConnectionId: 'demo-conn-2' });

    expect(route).toEqual(
      expect.objectContaining({ route: 'M1_TREND_CONTINUATION', eligible: true }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({
        eligible: true,
        tier: 'BOOTSTRAP_CONTINUATION',
        reason: 'M1_COLD_START_CONTINUATION_BOOTSTRAP',
      }),
    );
  });

  it('does not stack a second bootstrap continuation on the same pair and direction', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: [] },
      duplicateSameDirectionIntent: true,
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest
      .spyOn(h.service as any, 'evaluateDemoMultimodel')
      .mockImplementation(async (...args: any[]) => {
        const result = await original(...args);
        return {
          ...result,
          ensemble: {
            ...result.ensemble,
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: false,
          },
          authority: {
            ...result.authority,
            executable: false,
            authorityPath: 'BLOCKED',
            rescueVolumeCap: null,
            blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
          },
        };
      });

    await driveFeatures(h, cleanContinuationFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.hasActiveM1Intent).toHaveBeenCalledWith({
      userId: 'user-1',
      brokerConnectionId: 'demo-conn-2',
      instrument: 'EURUSD',
      direction: 'BUY',
    });
    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.blockers).toContain('M1_BOOTSTRAP_ACTIVE_SAME_SIDE_INTENT');
  });

  it('keeps cold-start continuation blocked after a recent realized loss', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: {
        M1_TREND_CONTINUATION: [
          {
            route: 'M1_TREND_CONTINUATION',
            instrument: 'EURUSD',
            direction: 'BUY',
            policyVersion: 'm1-tactical-v2-m5-lifecycle',
            realisedPnl: -4,
            riskAtStop: 10,
            closedAt: new Date('2026-10-15T10:19:00.000Z'),
          },
        ],
      },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest
      .spyOn(h.service as any, 'evaluateDemoMultimodel')
      .mockImplementation(async (...args: any[]) => {
        const result = await original(...args);
        return {
          ...result,
          ensemble: {
            ...result.ensemble,
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: false,
          },
          authority: {
            ...result.authority,
            executable: false,
            authorityPath: 'BLOCKED',
            rescueVolumeCap: null,
            blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
          },
        };
      });

    await driveFeatures(h, cleanContinuationFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.governance.reliability).toEqual(
      expect.objectContaining({ reason: 'INSUFFICIENT_EVIDENCE', recentRealizedR: -0.4 }),
    );
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({ eligible: false }),
    );
  });

  it('keeps cold-start continuation blocked when broker execution cost destroys expected R', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: [] },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest
      .spyOn(h.service as any, 'evaluateDemoMultimodel')
      .mockImplementation(async (...args: any[]) => {
        const result = await original(...args);
        return {
          ...result,
          ensemble: {
            ...result.ensemble,
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: false,
          },
          authority: {
            ...result.authority,
            executable: false,
            authorityPath: 'BLOCKED',
            rescueVolumeCap: null,
            blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
          },
        };
      });

    await driveFeatures(h, cleanContinuationFeatures(), {
      brokerConnectionId: 'demo-conn-2',
      spreadEvidence: {
        source: 'BROKER_OBSERVED_P90',
        spreadPrice: 0.0006,
        sampleCount: 30,
        percentile: 0.9,
        windowMinutes: 30,
        latestSampleAt: cleanContinuationFeatures().decisionTime.toISOString(),
      },
    });

    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.governance.genericGovernance.paperExecutionBlockers).toContain(
      'PAPER_NET_EXPECTED_R',
    );
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({ eligible: false }),
    );
  });

  it('keeps a stretched cold-start continuation blocked even when Plan-B is unavailable', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: [] },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest
      .spyOn(h.service as any, 'evaluateDemoMultimodel')
      .mockImplementation(async (...args: any[]) => {
        const result = await original(...args);
        return {
          ...result,
          ensemble: {
            ...result.ensemble,
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: false,
          },
          authority: {
            ...result.authority,
            executable: false,
            authorityPath: 'BLOCKED',
            rescueVolumeCap: null,
            blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
          },
        };
      });
    const stretched = cleanContinuationFeatures();
    stretched.extensionAtr = 1.8;

    await driveFeatures(h, stretched, { brokerConnectionId: 'demo-conn-2' });

    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({ eligible: false }),
    );
  });

  it('executes only a mature positive-expectancy M1 continuation fallback at the conservative cap', async () => {
    const maturePositiveContinuation = [
      { realisedPnl: 8, riskAtStop: 10, closedAt: '2026-10-15T10:29:00.000Z' },
      { realisedPnl: 6, riskAtStop: 10, closedAt: '2026-10-15T10:19:00.000Z' },
      { realisedPnl: -2, riskAtStop: 10, closedAt: '2026-10-15T10:09:00.000Z' },
      { realisedPnl: 5, riskAtStop: 10, closedAt: '2026-10-15T09:59:00.000Z' },
      { realisedPnl: 4, riskAtStop: 10, closedAt: '2026-10-15T09:49:00.000Z' },
      { realisedPnl: 3, riskAtStop: 10, closedAt: '2026-10-15T09:39:00.000Z' },
    ].map((row) => ({
      route: 'M1_TREND_CONTINUATION',
      instrument: 'EURUSD',
      direction: 'BUY',
      policyVersion: 'm1-tactical-v2-m5-lifecycle',
      ...row,
      closedAt: new Date(row.closedAt),
    }));
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: maturePositiveContinuation },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: {
          ...result.ensemble,
          strategyRoute: 'TREND_CONTINUATION',
          paperAdmitted: false,
          admitted: false,
        },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED', 'MULTIMODEL_GOVERNANCE_BLOCKED'],
        },
      };
    });

    const route = await driveFeatures(h, cleanContinuationFeatures(), {
      brokerConnectionId: 'demo-conn-2',
    });

    expect(route.route).toBe('M1_TREND_CONTINUATION');
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        suggestedVolume: 0.2,
        strategyCode: 'external-irexpro-m1-tactical',
        metadata: expect.objectContaining({
          m1_professional_fallback: true,
          m1_professional_fallback_tier: 'QUALIFIED_CONTINUATION',
          m1_tactical_route: 'M1_TREND_CONTINUATION',
        }),
      }),
    );
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.executionAuthority).toBe('BROKER_NATIVE');
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({ eligible: true, tier: 'QUALIFIED_CONTINUATION', lotCap: 0.2 }),
    );
    expect(recorded?.governance.professionalM1FallbackExecutionEnabled).toBe(true);
  });

  it('does not stack a mature qualified continuation on an active same pair-side M1 intent', async () => {
    const maturePositiveContinuation = [
      { realisedPnl: 8, riskAtStop: 10, closedAt: '2026-10-15T10:29:00.000Z' },
      { realisedPnl: 6, riskAtStop: 10, closedAt: '2026-10-15T10:19:00.000Z' },
      { realisedPnl: -2, riskAtStop: 10, closedAt: '2026-10-15T10:09:00.000Z' },
      { realisedPnl: 5, riskAtStop: 10, closedAt: '2026-10-15T09:59:00.000Z' },
      { realisedPnl: 4, riskAtStop: 10, closedAt: '2026-10-15T09:49:00.000Z' },
      { realisedPnl: 3, riskAtStop: 10, closedAt: '2026-10-15T09:39:00.000Z' },
    ].map((row) => ({
      route: 'M1_TREND_CONTINUATION',
      instrument: 'EURUSD',
      direction: 'BUY',
      policyVersion: 'm1-tactical-v2-m5-lifecycle',
      ...row,
      closedAt: new Date(row.closedAt),
    }));
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: maturePositiveContinuation },
      duplicateSameDirectionIntent: true,
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: {
          ...result.ensemble,
          strategyRoute: 'TREND_CONTINUATION',
          paperAdmitted: false,
          admitted: false,
        },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED', 'MULTIMODEL_GOVERNANCE_BLOCKED'],
        },
      };
    });

    await driveFeatures(h, cleanContinuationFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.hasActiveM1Intent).toHaveBeenCalledWith({
      userId: 'user-1',
      brokerConnectionId: 'demo-conn-2',
      instrument: 'EURUSD',
      direction: 'BUY',
    });
    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.executionAuthority).toBe('NONE');
    expect(recorded?.blockers).toContain('M1_PROFESSIONAL_ACTIVE_SAME_SIDE_INTENT');
  });

  it('keeps continuation fallback blocked when the exact M1 sleeve has a recent loss streak', async () => {
    const lossStreakEvidence = [
      { realisedPnl: -4, closedAt: '2026-10-15T10:29:00.000Z' },
      { realisedPnl: -3, closedAt: '2026-10-15T10:19:00.000Z' },
      { realisedPnl: -2, closedAt: '2026-10-15T10:09:00.000Z' },
      { realisedPnl: 8, closedAt: '2026-10-15T09:59:00.000Z' },
      { realisedPnl: 7, closedAt: '2026-10-15T09:49:00.000Z' },
      { realisedPnl: 6, closedAt: '2026-10-15T09:39:00.000Z' },
    ].map((row) => ({
      route: 'M1_TREND_CONTINUATION',
      instrument: 'EURUSD',
      direction: 'BUY',
      policyVersion: 'm1-tactical-v2-m5-lifecycle',
      riskAtStop: 10,
      ...row,
      closedAt: new Date(row.closedAt),
    }));
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: lossStreakEvidence },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: { ...result.ensemble, strategyRoute: 'TREND_CONTINUATION', paperAdmitted: false },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
        },
      };
    });

    await driveFeatures(h, cleanContinuationFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.governance.reliability.reason).toBe('EARLY_LOSS_STREAK');
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({ eligible: false }),
    );
  });

  it('does not promote a mature continuation when M1 drift is out of distribution', async () => {
    const maturePositiveContinuation = Array.from({ length: 6 }, (_, index) => ({
      route: 'M1_TREND_CONTINUATION',
      instrument: 'EURUSD',
      direction: 'BUY',
      policyVersion: 'm1-tactical-v2-m5-lifecycle',
      realisedPnl: index === 2 ? -2 : 5,
      riskAtStop: 10,
      closedAt: new Date(`2026-10-15T${String(10 - Math.floor(index / 3)).padStart(2, '0')}:${String(29 - (index % 3) * 10).padStart(2, '0')}:00.000Z`),
    }));
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      evidenceByRoute: { M1_TREND_CONTINUATION: maturePositiveContinuation },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: { ...result.ensemble, strategyRoute: 'TREND_CONTINUATION', paperAdmitted: false },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
        },
      };
    });
    const outOfDistribution = cleanContinuationFeatures();
    outOfDistribution.extensionAtr = 1.8;

    await driveFeatures(h, outOfDistribution, { brokerConnectionId: 'demo-conn-2' });

    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_TREND_CONTINUATION' && value.direction === 'BUY',
    )?.[0];
    expect(recorded?.governance.genericGovernance.driftState).toBe('OUT_OF_DISTRIBUTION');
    expect(recorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({ eligible: false }),
    );
  });

  it('keeps a qualified M1 early-transition fallback observational while direct M1 DEMO authority is paused', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      shadowPairSideOutcomes: [
        { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 0.74 },
        { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: 0.44 },
        { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: -0.2 },
        { observedAt: new Date('2026-10-15T09:59:00.000Z'), netR: -0.08 },
        { observedAt: new Date('2026-10-15T09:49:00.000Z'), netR: 0.46 },
        { observedAt: new Date('2026-10-15T09:39:00.000Z'), netR: -0.06 },
      ],
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: {
          ...result.ensemble,
          strategyRoute: 'TREND_CONTINUATION',
          paperAdmitted: false,
          admitted: false,
        },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: [
            'MULTIMODEL_PLAN_B_NOT_ADMITTED',
            'MULTIMODEL_CONTINUATION_TIMING_NOT_READY',
          ],
        },
      };
    });

    const route = await driveFeatures(h, transitionFeatures(), {
      brokerConnectionId: 'demo-conn-2',
    });

    expect(route.route).toBe('M1_EARLY_TRANSITION');
    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_EARLY_TRANSITION',
    )?.[0];
    expect(recorded?.executionAuthority).toBe('NONE');
    expect(recorded?.blockers).toContain('M1_PROFESSIONAL_FALLBACK_OBSERVATIONAL_ONLY');
    expect(recorded?.governance).toEqual(
      expect.objectContaining({
        professionalM1Fallback: expect.objectContaining({ eligible: true, tier: 'QUALIFIED' }),
        professionalM1FallbackExecutionEnabled: false,
      }),
    );
  });

  it('keeps a recovery-probe M1 fallback observational while direct M1 DEMO authority is paused', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      shadowPairSideOutcomes: [
        { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 0.35 },
        { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: 0.25 },
        { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: 0.15 },
        { observedAt: new Date('2026-10-15T09:59:00.000Z'), netR: -0.6 },
        { observedAt: new Date('2026-10-15T09:49:00.000Z'), netR: -0.5 },
        { observedAt: new Date('2026-10-15T09:39:00.000Z'), netR: -0.4 },
      ],
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    const strongTransition = transitionFeatures();
    strongTransition.emaSeparationAtr = 0.9;
    strongTransition.emaSlopeAtr = 0.9;
    strongTransition.momentum1Atr = 0.7;
    strongTransition.momentum3Atr = 0.95;
    strongTransition.momentum5Atr = 0.9;
    strongTransition.closeLocation = 0.95;
    strongTransition.lowerWickRatio = 0.8;
    strongTransition.upperWickRatio = 0.05;
    strongTransition.rsi14 = 70;
    strongTransition.breakoutUpAtr = 0.5;
    strongTransition.efficiency5 = 0.9;
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: {
          ...result.ensemble,
          strategyRoute: 'TREND_CONTINUATION',
          paperAdmitted: false,
          admitted: false,
        },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: [
            'MULTIMODEL_PLAN_B_NOT_ADMITTED',
            'MULTIMODEL_CONTINUATION_TIMING_NOT_READY',
          ],
        },
      };
    });

    const route = await driveFeatures(h, strongTransition, { brokerConnectionId: 'demo-conn-2' });

    expect(route.route).toBe('M1_EARLY_TRANSITION');
    const recoveryRecorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_EARLY_TRANSITION',
    )?.[0];
    expect(recoveryRecorded?.governance.professionalM1Fallback).toEqual(
      expect.objectContaining({ eligible: true, tier: 'RECOVERY_PROBE' }),
    );
    expect(recoveryRecorded?.governance.professionalM1FallbackExecutionEnabled).toBe(false);
    expect(recoveryRecorded?.executionAuthority).toBe('NONE');
    expect(recoveryRecorded?.blockers).toContain('M1_PROFESSIONAL_FALLBACK_OBSERVATIONAL_ONLY');
    expect(h.receiveSignal).not.toHaveBeenCalled();
  });

  it('does not let the professional M1 fallback bypass a high-impact event block', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      shadowPairSideOutcomes: [
        { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 0.74 },
        { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: 0.44 },
        { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: -0.2 },
        { observedAt: new Date('2026-10-15T09:59:00.000Z'), netR: -0.08 },
        { observedAt: new Date('2026-10-15T09:49:00.000Z'), netR: 0.46 },
        { observedAt: new Date('2026-10-15T09:39:00.000Z'), netR: -0.06 },
      ],
      evidenceByRoute: { M1_EARLY_TRANSITION: [] },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: { ...result.ensemble, strategyRoute: 'TREND_CONTINUATION', paperAdmitted: false },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: ['MULTIMODEL_PLAN_B_NOT_ADMITTED'],
        },
      };
    });

    await driveFeatures(h, transitionFeatures(), {
      brokerConnectionId: 'demo-conn-2',
      eventRisk: 'HIGH_IMPACT_BLOCK',
    });

    expect(h.receiveSignal).not.toHaveBeenCalled();
  });

  it('keeps a real M1 early-transition loss streak blocked even when Plan-B disagrees on the route', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      shadowPairSideOutcomes: [
        { observedAt: new Date('2026-10-15T10:29:00.000Z'), netR: 0.4 },
        { observedAt: new Date('2026-10-15T10:19:00.000Z'), netR: 0.3 },
        { observedAt: new Date('2026-10-15T10:09:00.000Z'), netR: 0.2 },
      ],
      evidenceByRoute: {
        M1_EARLY_TRANSITION: [
          {
            route: 'M1_EARLY_TRANSITION', instrument: 'EURUSD', direction: 'BUY',
            policyVersion: 'm1-tactical-v2-m5-lifecycle', realisedPnl: -10, riskAtStop: 10,
            closedAt: new Date('2026-10-15T10:25:00.000Z'),
          },
          {
            route: 'M1_EARLY_TRANSITION', instrument: 'EURUSD', direction: 'BUY',
            policyVersion: 'm1-tactical-v2-m5-lifecycle', realisedPnl: -9, riskAtStop: 9,
            closedAt: new Date('2026-10-15T10:15:00.000Z'),
          },
        ],
      },
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: { ...result.ensemble, strategyRoute: 'TREND_CONTINUATION', paperAdmitted: false },
        authority: {
          ...result.authority,
          executable: false,
          authorityPath: 'BLOCKED',
          rescueVolumeCap: null,
          blockers: ['MULTIMODEL_CONTINUATION_TIMING_NOT_READY'],
        },
      };
    });

    await driveFeatures(h, transitionFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.route === 'M1_EARLY_TRANSITION',
    )?.[0];
    expect(recorded?.governance.reliability.reason).toBe('EARLY_LOSS_STREAK');
  });

  it('lets a Plan-B + trained-expert confirmed continuation execute even though the M1 rollout route was historically shadow-only', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      trainedExpertState: 'CONFIRM',
    });

    const route = await driveFeatures(h, cleanContinuationFeatures(), {
      brokerConnectionId: 'demo-conn-2',
    });

    expect(route.route).toBe('M1_TREND_CONTINUATION');
    expect(h.trainedExpertEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        brokerConnectionId: 'demo-conn-2',
        instrument: 'EURUSD',
        candidateDirection: 'BUY',
      }),
    );
    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerConnectionId: 'demo-conn-2',
        strategyCode: 'external-irexpro-multimodel-ensemble',
        modelVersion: expect.stringContaining('irexpro-multimodel-ensemble-v1'),
        metadata: expect.objectContaining({
          signal_source: 'EXTERNAL_PROVIDER',
          external_provider_code: 'irexpro-multimodel-ensemble-v1',
          primary_engine_code: 'irexpro-multimodel-ensemble-v1',
          m1_tactical_role: 'TIMING_SPECIALIST',
          multimodel_trained_expert_state: 'CONFIRM',
          multimodel_trained_expert_long_votes: 3,
          multimodel_trained_expert_short_votes: 0,
        }),
      }),
    );
    const recorded = h.recordDecision.mock.calls.find(
      ([value]) => value.direction === 'BUY' && value.route === 'M1_TREND_CONTINUATION',
    )?.[0];
    expect(recorded?.blockers ?? []).not.toContain('M1_PHASE_ROUTE_SHADOW');
    expect(recorded?.executionAuthority).toBe('BROKER_NATIVE');
    expect(recorded?.governance).toEqual(
      expect.objectContaining({
        primaryEngineCode: 'irexpro-multimodel-ensemble-v1',
        m1TacticalRole: 'TIMING_SPECIALIST',
        multimodelAuthority: expect.objectContaining({ executable: true }),
      }),
    );
  });

  it('submits trained-expert confidence for an EARLY_TRANSITION high-conviction rescue', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: fullAutoSession,
      trainedExpertState: 'CONFIRM',
    });
    const original = (h.service as any).evaluateDemoMultimodel.bind(h.service);
    jest.spyOn(h.service as any, 'evaluateDemoMultimodel').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      return {
        ...result,
        ensemble: { ...result.ensemble, ensembleScore: 0.579, paperAdmitted: false, strategyRoute: 'EARLY_TRANSITION' as const },
        trainedExpert: { ...result.trainedExpert, ensembleConfidence: 0.738 },
        authority: {
          ...result.authority,
          executable: true,
          authorityPath: 'HIGH_CONVICTION_RESCUE',
          rescueVolumeCap: 0.2,
          blockers: [],
        },
      };
    });

    await driveFeatures(h, cleanContinuationFeatures(), { brokerConnectionId: 'demo-conn-2' });

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        confidenceScore: 0.738,
        strategyCode: 'external-irexpro-multimodel-ensemble',
        metadata: expect.objectContaining({
          multimodel_execution_authority_path: 'HIGH_CONVICTION_RESCUE',
          multimodel_trained_expert_confidence: 0.738,
        }),
      }),
    );
  });

  it('blocks V8 execution after three recent losses on the same Plan-B pair-side-route while retaining telemetry', async () => {
    const h = phase2Harness({ rollout: M1_TACTICAL_ROLLOUT_POLICY_V8, session: fullAutoSession, trainedExpertState: 'CONFIRM', multimodelLossStreakBrake: { artifact: 'm1-multimodel-loss-streak-brake-v1', active: true, reason: 'RECENT_MULTIMODEL_LOSS_STREAK', strategyRoute: 'TREND_CONTINUATION', recentClosedTrades: 3, recentLosses: 3, recentWins: 0, cumulativeRealisedPnl: -31.2, latestClosedAt: new Date('2026-10-15T10:25:00.000Z'), cooldownHours: 12, cooldownRemainingSeconds: 42900 } });
    await driveFeatures(h, cleanContinuationFeatures(), { brokerConnectionId: 'demo-conn-2' });
    expect(h.loadMultimodelLossStreakBrake).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', brokerConnectionId: 'demo-conn-2', instrument: 'EURUSD', direction: 'BUY', strategyRoute: 'TREND_CONTINUATION' }));
    expect(h.receiveSignal).not.toHaveBeenCalled();
    const recorded = h.recordDecision.mock.calls.find(([value]) => value.direction === 'BUY' && value.route === 'M1_TREND_CONTINUATION')?.[0];
    expect(recorded).toEqual(expect.objectContaining({ executionAuthority: 'NONE', blockers: expect.arrayContaining(['M1_MULTIMODEL_LOSS_STREAK_BRAKE']), governance: expect.objectContaining({ multimodelLossStreakBrake: expect.objectContaining({ active: true, reason: 'RECENT_MULTIMODEL_LOSS_STREAK', recentLosses: 3 }) }) }));
  });

  it.each(['CONFLICT', 'UNAVAILABLE'] as const)(
    'keeps trained expert state %s observational when the promoted PAPER champion qualifies',
    async (trainedExpertState) => {
      const h = phase2Harness({
        rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
        session: fullAutoSession,
        trainedExpertState,
        trainedExpertDirection: trainedExpertState === 'CONFLICT' ? 'SELL' : 'BUY',
      });

      await driveFeatures(h, cleanContinuationFeatures(), {
        brokerConnectionId: 'demo-conn-2',
      });

      expect(h.trainedExpertEvaluate).toHaveBeenCalled();
      expect(h.receiveSignal).toHaveBeenCalledTimes(1);
      expect(h.receiveSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            multimodel_trained_expert_state: trainedExpertState,
          }),
        }),
      );
      const recorded = h.recordDecision.mock.calls.find(
        ([value]) => value.direction === 'BUY' && value.route === 'M1_TREND_CONTINUATION',
      )?.[0];
      expect(recorded?.blockers ?? []).not.toContain(
        `MULTIMODEL_TRAINED_EXPERT_${trainedExpertState}`,
      );
      expect(recorded?.governance).toEqual(
        expect.objectContaining({
          multimodelAuthority: expect.objectContaining({ executable: true }),
        }),
      );
    },
  );

  it('reports a risk-suspended FULL_AUTO session as risk protection instead of session inactivity', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: null,
      currentSession: {
        ...fullAutoSession,
        status: 'SUSPENDED_RISK_LIMIT',
      },
      trainedExpertState: 'CONFIRM',
    });

    await driveFeatures(h, cleanContinuationFeatures(), {
      brokerConnectionId: 'demo-conn-2',
    });

    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.getActiveSessionForClient).toHaveBeenCalledWith('user-1');
    expect(h.markOutcomeState).toHaveBeenCalledWith(
      expect.any(String),
      'RISK_REJECTED',
      expect.any(Date),
      expect.stringContaining('SUSPENDED_RISK_LIMIT'),
    );
    expect(h.markOutcomeState).not.toHaveBeenCalledWith(
      expect.any(String),
      'SESSION_INACTIVE',
      expect.any(Date),
      expect.any(String),
    );
  });

  it('still requires the exact active FULL_AUTO broker connection at final dispatch', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V8,
      session: {
        ...fullAutoSession,
        brokerConnectionId: 'different-demo-connection',
      },
      trainedExpertState: 'CONFIRM',
    });

    await driveFeatures(h, cleanContinuationFeatures(), {
      brokerConnectionId: 'demo-conn-2',
    });

    expect(h.receiveSignal).not.toHaveBeenCalled();
    expect(h.markOutcomeState).toHaveBeenCalledWith(
      expect.any(String),
      'SESSION_INACTIVE',
      expect.any(Date),
      expect.stringContaining('exact active FULL_AUTO DEMO session'),
    );
  });

  it('leaves historical PAPER route gating independent of the trained expert', async () => {
    const h = phase2Harness({
      rollout: M1_TACTICAL_ROLLOUT_POLICY_V2,
      trainedExpertState: 'CONFLICT',
    });

    await driveCleanContinuation(h);

    expect(h.receiveSignal).toHaveBeenCalledTimes(1);
    expect(h.trainedExpertEvaluate).not.toHaveBeenCalled();
  });
});
