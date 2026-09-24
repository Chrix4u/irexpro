import { RiskIntelligenceService } from './risk-intelligence.service';
import { RiskService } from './risk.service';
import { ExecutionService } from '../execution/execution.service';
import { PortfolioReadService } from '../broker/services/portfolio-read.service';
import { AllowedTradingMode } from './entities/risk-profile.entity';
import { RiskRejectionCode } from './interfaces/risk.interface';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('RiskIntelligenceService', () => {
  it('aggregates only frontend-safe policy, capacity, freshness, and violation data', async () => {
    const riskService = {
      getOrCreateProfile: jest.fn().mockResolvedValue({
        riskAcknowledgementAccepted: true,
        allowedTradingModes: AllowedTradingMode.FULL_AUTO,
        maxDailyLossPercent: '5.00',
        maxDrawdownPercent: '10.00',
        maxOpenTrades: 3,
        maxPositionSizeLot: '0.1000',
        minStopLossPips: '5.00',
        maxVolatilityScore: '0.85',
        maxTradeRiskPercent: '2.00',
        maxLeverageAllowed: 30,
        allowedInstruments: ['EURUSD', 'GBPUSD'],
        rejectLowLiquidity: true,
      }),
      hasBrokerConnection: jest.fn().mockResolvedValue(true),
      isKillSwitchActive: jest.fn().mockResolvedValue(false),
      getViolations: jest.fn().mockResolvedValue([
        {
          id: 'risk-v-1',
          userId: USER_ID,
          signalId: '22222222-2222-4222-8222-222222222222',
          rejectionCode: RiskRejectionCode.MAX_CONCURRENT_TRADES,
          rejectionReason: 'Open trade limit reached',
          riskContext: {
            brokerBalance: '10000.00',
            brokerEquity: '9500.00',
            proposedInstrument: 'EURUSD',
          },
          evaluatedAt: new Date('2026-08-28T21:00:00.000Z'),
        },
      ]),
    };
    const executionService = {
      countOpenTrades: jest.fn().mockResolvedValue(2),
      countTodayTrades: jest.fn().mockResolvedValue(7),
    };
    const portfolioReadService = {
      listAccounts: jest.fn().mockResolvedValue([
        {
          connectionId: 'broker-1',
          brokerName: 'Paper Broker',
          displayName: 'Demo',
          accountType: 'DEMO',
          connectionStatus: 'CONNECTED',
          liveTradingEnabled: false,
          snapshot: {
            currency: 'USD',
            balance: '10000.00',
            equity: '10000.00',
            freshness: 'FRESH',
            syncedAt: new Date('2026-08-28T21:00:00.000Z'),
            ageSeconds: 30,
          },
          snapshotUnavailableReason: null,
        },
        {
          connectionId: 'broker-2',
          brokerName: 'MetaTrader',
          displayName: null,
          accountType: 'LIVE',
          connectionStatus: 'DISCONNECTED',
          liveTradingEnabled: false,
          snapshot: {
            currency: 'EUR',
            balance: '2500.00',
            equity: '2480.00',
            freshness: 'STALE',
            syncedAt: new Date('2026-08-28T20:00:00.000Z'),
            ageSeconds: 3600,
          },
          snapshotUnavailableReason: null,
        },
        {
          connectionId: 'broker-3',
          brokerName: 'MetaTrader',
          displayName: 'Awaiting sync',
          accountType: 'DEMO',
          connectionStatus: 'CONNECTED',
          liveTradingEnabled: false,
          snapshot: null,
          snapshotUnavailableReason: 'NO_SYNC',
        },
      ]),
    };

    const service = new RiskIntelligenceService(
      riskService as unknown as RiskService,
      executionService as unknown as ExecutionService,
      portfolioReadService as unknown as PortfolioReadService,
    );

    const result = await service.getIntelligence(USER_ID);

    expect(result.engine).toEqual({ killSwitchActive: false, brokerConnected: true });
    expect(result.execution).toEqual({
      openPositions: 2,
      maxOpenPositions: 3,
      openPositionSlotsRemaining: 1,
      todayTrades: 7,
      dailyTradeCountPolicy: 'UNBOUNDED',
    });
    expect(result.portfolio).toEqual({
      totalAccounts: 3,
      connectedAccounts: 2,
      freshSnapshots: 1,
      staleSnapshots: 1,
      unavailableSnapshots: 1,
    });
    expect(result.recentViolations).toEqual([
      {
        id: 'risk-v-1',
        rejectionCode: RiskRejectionCode.MAX_CONCURRENT_TRADES,
        rejectionReason: 'Open trade limit reached',
        evaluatedAt: new Date('2026-08-28T21:00:00.000Z'),
      },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('riskContext');
    expect(serialized).not.toContain('signalId');
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('brokerBalance');
    expect(serialized).not.toContain('brokerEquity');
  });

  it('never returns negative capacity when usage is already above a configured limit', async () => {
    const riskService = {
      getOrCreateProfile: jest.fn().mockResolvedValue({
        riskAcknowledgementAccepted: true,
        allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
        maxDailyLossPercent: '5.00',
        maxDrawdownPercent: '10.00',
        maxOpenTrades: 2,
        maxPositionSizeLot: '0.1000',
        minStopLossPips: '5.00',
        maxVolatilityScore: '0.85',
        maxTradeRiskPercent: '2.00',
        maxLeverageAllowed: 30,
        allowedInstruments: null,
        rejectLowLiquidity: true,
      }),
      hasBrokerConnection: jest.fn().mockResolvedValue(false),
      isKillSwitchActive: jest.fn().mockResolvedValue(true),
      getViolations: jest.fn().mockResolvedValue([]),
    };
    const executionService = {
      countOpenTrades: jest.fn().mockResolvedValue(4),
      countTodayTrades: jest.fn().mockResolvedValue(8),
    };
    const portfolioReadService = { listAccounts: jest.fn().mockResolvedValue([]) };

    const service = new RiskIntelligenceService(
      riskService as unknown as RiskService,
      executionService as unknown as ExecutionService,
      portfolioReadService as unknown as PortfolioReadService,
    );

    const result = await service.getIntelligence(USER_ID);

    expect(result.execution.openPositionSlotsRemaining).toBe(0);
    expect(result.execution.todayTrades).toBe(8);
    expect(result.execution.dailyTradeCountPolicy).toBe('UNBOUNDED');
  });
});
