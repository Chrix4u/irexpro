import { ConfigService } from '@nestjs/config';
import { AiSignalService } from './ai-signal.service';
import {
  VpsForexSignalCollectorService,
  canExecuteMultiModelPaper,
  buildCandidate,
  isFreshOpportunity,
} from './vps-forex-signal-collector.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { BrokerService } from '../broker/broker.service';
import { LivePaperMarketDataService } from '../broker/services/live-paper-market-data.service';

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
      canExecuteMultiModelPaper(
        { admitted: true },
        { paperExecutionEligible: true },
      ),
    ).toBe(true);
  });

  it('fails closed when model admission or PAPER governance fails', () => {
    expect(
      canExecuteMultiModelPaper(
        { admitted: false },
        { paperExecutionEligible: true },
      ),
    ).toBe(false);
    expect(
      canExecuteMultiModelPaper(
        { admitted: true },
        { paperExecutionEligible: false },
      ),
    ).toBe(false);
  });
});

describe('VpsForexSignalCollectorService', () => {
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

  it('blocks a repeated unchanged setup but permits genuinely fresh same-side evidence', () => {
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

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM trading.ensemble_shadow_decisions'),
      ['user-1', 'conn-1', 'irexpro-multimodel-ensemble-v1'],
    );
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

  it('reports weekend pause and the next eligible Monday scan deterministically', () => {
    const collector = new VpsForexSignalCollectorService(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const schedule = (collector as any).marketSchedule(new Date('2026-10-03T00:21:00.000Z'));
    expect(schedule).toEqual({
      paused: true,
      reason: 'WEEKEND',
      nextEligibleScanAt: '2026-10-05T00:00:00.000Z',
    });
  });

  it('enters a daily provider cooldown after Twelve Data exhausts the account quota', async () => {
    const live = new LivePaperMarketDataService();
    const execution = {
      getActiveSession: jest.fn().mockResolvedValue({
        id: 'session-1',
        brokerConnectionId: 'conn-1',
        executionMode: ExecutionMode.PAPER_ONLY,
      }),
    } as unknown as ExecutionService;
    const collector = new VpsForexSignalCollectorService(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      execution,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
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

    await expect(collector.collectOnce(fetchMock as unknown as typeof fetch)).rejects.toThrow(
      /daily credit limit reached; scanner paused until/,
    );
    const status = await collector.getStatus('user-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status.providerCooldownReason).toBe('DAILY_CREDIT_LIMIT');
    expect(status.providerCooldownUntil).toBeTruthy();
    expect(status.state).toBe(
      status.marketSchedule.paused ? 'MARKET_PAUSED' : 'WAITING_FOR_PROVIDER_QUOTA',
    );
  });

  it('does not call Twelve Data again while the same-process daily quota cooldown is active', async () => {
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
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
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

    await expect(collector.collectOnce(fetchMock as unknown as typeof fetch)).rejects.toThrow(
      /daily credit limit reached/,
    );
    await expect(collector.collectOnce(fetchMock as unknown as typeof fetch)).rejects.toThrow(
      /daily credit cooldown active/,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
