import * as fs from 'fs';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import type { LivePaperCandleInput } from '../broker/services/live-paper-market-data.service';
import type { AiSignalService } from './ai-signal.service';
import type { ExecutionService } from '../execution/execution.service';
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
  m1RouteExecutableInPhase,
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
  const marketData = { loadSnapshot } as unknown as M1TacticalMarketDataService;
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
  const evidence = {
    recordDecision,
    loadRoutePairSideEvidence,
  } as unknown as M1TacticalEvidenceService;
  const receiveSignal = jest.fn();
  const signal = { receiveSignal } as unknown as AiSignalService;
  const service = new M1TacticalSchedulerService(config, marketData, macro, evidence, signal);
  return {
    service,
    loadSnapshot,
    assess,
    recordDecision,
    loadRoutePairSideEvidence,
    receiveSignal,
  };
}

const OPEN_NOW = new Date('2026-10-15T12:30:15.000Z');

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
    }
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
    openPositions?: any[];
    duplicateOppositeIntent?: boolean;
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
    signalId: null,
    tradeIntentId: null,
    outcomeState: null,
    outcomeReason: null,
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
  const markExecutionLink = jest.fn().mockResolvedValue(undefined);
  const markOutcomeState = jest.fn().mockResolvedValue(undefined);
  const loadOpenPaperPositions = jest.fn().mockResolvedValue(options.openPositions ?? []);
  const hasActiveOppositeM1Intent = jest
    .fn()
    .mockResolvedValue(options.duplicateOppositeIntent ?? false);
  const markRescueObservation = jest.fn().mockResolvedValue(undefined);
  const evidence = {
    recordDecision,
    loadRoutePairSideEvidence,
    markExecutionLink,
    markOutcomeState,
    loadOpenPaperPositions,
    hasActiveOppositeM1Intent,
    markRescueObservation,
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
  const rollout = {
    ...(options.rollout ?? M1_TACTICAL_ROLLOUT_POLICY_V2),
    instruments: ['EURUSD'] as const,
  };
  const service = new M1TacticalSchedulerService(
    config,
    marketData,
    macro,
    evidence,
    signal,
    rollout,
    execution,
  );
  return {
    service,
    recordDecision,
    loadRoutePairSideEvidence,
    markExecutionLink,
    markOutcomeState,
    receiveSignal,
    getActiveSession,
    closeTrade,
    loadOpenPaperPositions,
    hasActiveOppositeM1Intent,
    markRescueObservation,
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
      metadata: expect.objectContaining({
        external_provider_paper_only: true,
        production_eligible: false,
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

  it('allows conservative PAPER simulation spread without upgrading it to production evidence', async () => {
    const h = phase2Harness();
    const features = cleanContinuationFeatures();
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
) {
  const [buy, sell] = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
  const route = classifyM1TacticalRoute(buy, sell, features, M1_TACTICAL_POLICY_V1);
  await (h.service as any).persistCandidate(
    'user-1',
    'conn-1',
    buy,
    sell,
    features,
    'CLEAR',
    {
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00004,
      sampleCount: 20,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: features.decisionTime.toISOString(),
    },
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

describe('M1 tactical phase-3 module wiring', () => {
  it('binds AiModule to the versioned PAPER_ALL_ROUTES rollout without an environment escape hatch', () => {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, './ai.module.ts'), 'utf8');
    expect(moduleSource).toContain('M1_TACTICAL_ROLLOUT_POLICY_V3');
    expect(moduleSource).toMatch(
      /provide:\s*M1_TACTICAL_ROLLOUT_POLICY_TOKEN[\s\S]*useValue:\s*M1_TACTICAL_ROLLOUT_POLICY_V3/,
    );
    expect(moduleSource).not.toMatch(/process\.env[^\n]*M1_TACTICAL/);
  });
});
