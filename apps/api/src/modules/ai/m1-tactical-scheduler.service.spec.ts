import * as fs from 'fs';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import type { LivePaperCandleInput } from '../broker/services/live-paper-market-data.service';
import type { AiSignalService } from './ai-signal.service';
import type { MacroEventRiskService } from './macro-event-risk.service';
import type { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import type {
  M1TacticalMarketDataService,
  M1TacticalMarketSnapshot,
} from './m1-tactical-market-data.service';
import {
  M1TacticalSchedulerService,
  M1_TACTICAL_ROLLOUT_POLICY_V1,
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
