import { MarketIntelligenceService } from '../market-data/market-intelligence.service';
import { RiskIntelligenceService } from '../risk/risk-intelligence.service';
import { StrategyLabService } from '../strategy/strategy-lab.service';
import { AiCopilotService } from './ai-copilot.service';
import { AiDecisionExplorerService } from './ai-decision-explorer.service';

const marketSnapshot = {
  instrument: 'EURUSD',
  timeframe: 'H1',
  source: 'BROKER' as const,
  status: 'FRESH' as const,
  retrievedAt: '2026-08-31T03:15:00.000Z',
  latestCandleAt: '2026-08-31T03:00:00.000Z',
  quote: {
    bid: '1.17010',
    ask: '1.17022',
    spread: '0.00012',
    timestamp: '2026-08-31T03:14:59.000Z',
    freshness: 'FRESH' as const,
  },
  candles: [],
};

const riskSnapshot = {
  engine: { killSwitchActive: false, brokerConnected: true },
  policy: {
    riskAcknowledgementAccepted: true,
    allowedTradingMode: 'FULL_AUTO' as const,
    limits: {
      maxDailyLossPercent: '3',
      maxDrawdownPercent: '10',
      maxOpenTrades: 5,
      maxPositionSizeLot: '1',
      minStopLossPips: '10',
      maxVolatilityScore: '0.8',
      maxTradeRiskPercent: '1',
      maxLeverageAllowed: 30,
      allowedInstruments: null,
      rejectLowLiquidity: true,
    },
  },
  execution: {
    openPositions: 1,
    maxOpenPositions: 5,
    openPositionSlotsRemaining: 4,
    todayTrades: 2,
    dailyTradeCountPolicy: 'UNBOUNDED' as const,
  },
  portfolio: {
    totalAccounts: 1,
    connectedAccounts: 1,
    freshSnapshots: 1,
    staleSnapshots: 0,
    unavailableSnapshots: 0,
  },
  recentViolations: [],
};

const decisionsSnapshot = {
  generatedAt: '2026-08-31T03:15:00.000Z',
  decisions: [
    {
      signalId: 'signal-1',
      outcome: 'RISK_APPROVED' as const,
      receivedAt: '2026-08-31T03:12:00.000Z',
      evidence: {
        instrument: 'EURUSD',
        direction: 'BUY' as const,
        confidenceScore: 0.82,
        strategyCode: 'TREND_H1',
        modelVersion: 'model-v1',
        timeframe: 'H1',
        marketRegime: 'TRENDING',
        volatilityScore: 0.4,
        generatedAt: '2026-08-31T03:11:59.000Z',
      },
      risk: { decision: 'APPROVED' as const, rejectionCode: null, rejectionReason: null },
      execution: null,
      timeline: [],
    },
  ],
};

const strategySnapshot = {
  dataset: {
    id: 'strategy-lab-v1',
    version: '1.0.0',
    asOf: '2026-08-01',
    checksumSha256: 'sha256:test',
    methodologyVersion: 'strategy-score-v1',
  },
  methodology: {
    objective: 'test',
    weights: {
      expectedReturn: 0.25,
      profitFactor: 0.25,
      drawdownProtection: 0.25,
      stability: 0.15,
      winRate: 0.1,
    },
    constraints: { maxDrawdownPct: 12, minProfitFactor: 1.1, maxExposurePct: 35 },
  },
  scenarios: [
    {
      id: 'trend-normal',
      name: 'Trend',
      marketRegime: 'TRENDING' as const,
      volatility: 'MODERATE' as const,
      description: 'fixture',
      recommendation: { strategyCode: 'TREND_H1', summary: 'historical ranking only' },
      candidates: [
        {
          rank: 1,
          strategyCode: 'TREND_H1',
          name: 'Trend H1',
          timeframe: 'H1',
          eligible: true,
          score: 83.4,
          metrics: {
            expectedReturnPct: 8,
            maxDrawdownPct: 7,
            winRate: 0.58,
            profitFactor: 1.4,
            stability: 0.8,
            exposurePct: 25,
          },
          scorecard: {
            expectedReturn: 70,
            profitFactor: 70,
            drawdownProtection: 65,
            stability: 80,
            winRate: 58,
          },
          constraints: [],
          rationale: [],
          tradeoffs: [],
        },
      ],
    },
  ],
  disclaimer: 'advisory only',
};

describe('AiCopilotService', () => {
  const market = { getSnapshot: jest.fn() };
  const risk = { getIntelligence: jest.fn() };
  const decisions = { getRecentDecisions: jest.fn() };
  const strategy = { getSnapshot: jest.fn() };
  const service = new AiCopilotService(
    market as unknown as MarketIntelligenceService,
    risk as unknown as RiskIntelligenceService,
    decisions as unknown as AiDecisionExplorerService,
    strategy as unknown as StrategyLabService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    market.getSnapshot.mockResolvedValue(marketSnapshot);
    risk.getIntelligence.mockResolvedValue(riskSnapshot);
    decisions.getRecentDecisions.mockResolvedValue(decisionsSnapshot);
    strategy.getSnapshot.mockReturnValue(strategySnapshot);
  });

  it('composes existing authoritative evidence without creating an execution instruction', async () => {
    const result = await service.getContext('user-1', { instrument: 'eurusd', timeframe: 'H1' });

    expect(result.status).toBe('READY');
    expect(result.posture).toBe('NORMAL');
    expect(result.market?.bid).toBe('1.17010');
    expect(result.decision?.signalId).toBe('signal-1');
    expect(result.strategyResearch).toMatchObject({
      strategyCode: 'TREND_H1',
      eligible: true,
      score: 83.4,
      advisoryOnly: true,
    });
    expect(result.policy).toEqual({
      explanationOnly: true,
      noTradeInstruction: true,
      hiddenReasoningExposed: false,
      strategyResearchAdvisoryOnly: true,
    });
    expect(market.getSnapshot).toHaveBeenCalledWith('user-1', {
      instrument: 'EURUSD',
      timeframe: 'H1',
      limit: 60,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /brokerConnectionId|providerAccountId|encryptedCredentials|idempotencyKey|placeOrder/,
    );
  });

  it('fails closed when authoritative risk intelligence is unavailable', async () => {
    risk.getIntelligence.mockRejectedValue(new Error('risk read unavailable'));

    const result = await service.getContext('user-1', { instrument: 'EURUSD', timeframe: 'H1' });

    expect(result.status).toBe('PARTIAL');
    expect(result.posture).toBe('BLOCKED');
    expect(result.risk).toBeNull();
    expect(result.explanation).toContain('fails closed');
    expect(result.evidence).toContainEqual({
      source: 'RISK',
      state: 'UNAVAILABLE',
      summary: 'Authoritative Risk Intelligence is unavailable.',
    });
  });

  it('preserves stale provider-backed market evidence as caution instead of estimating freshness', async () => {
    market.getSnapshot.mockResolvedValue({
      ...marketSnapshot,
      status: 'STALE',
      quote: { ...marketSnapshot.quote, freshness: 'STALE' },
    });

    const result = await service.getContext('user-1', { instrument: 'EURUSD', timeframe: 'H1' });

    expect(result.status).toBe('READY');
    expect(result.posture).toBe('CAUTION');
    expect(result.market?.freshness).toBe('STALE');
    expect(result.nextChecks).toContain(
      'Wait for fresh provider-backed market evidence before relying on market context.',
    );
  });

  it('reports no matching decision rather than reusing evidence from another timeframe', async () => {
    const result = await service.getContext('user-1', { instrument: 'EURUSD', timeframe: 'M15' });

    expect(result.decision).toBeNull();
    expect(result.strategyResearch).toBeNull();
    expect(result.evidence).toContainEqual({
      source: 'AI_DECISION',
      state: 'NONE',
      summary: 'No persisted AI decision matches the selected instrument and timeframe.',
    });
  });
});
