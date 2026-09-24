import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { PortfolioReadService } from '../broker/services/portfolio-read.service';
import { ExecutionService } from '../execution/execution.service';
import { RiskService } from './risk.service';
import { RiskIntelligenceResponseDto } from './dto/risk-intelligence-response.dto';
import { toRiskViolationSummary } from './risk-response.mapper';

@Injectable()
export class RiskIntelligenceService {
  constructor(
    private readonly riskService: RiskService,
    @Inject(forwardRef(() => ExecutionService))
    private readonly executionService: ExecutionService,
    private readonly portfolioReadService: PortfolioReadService,
  ) {}

  async getIntelligence(userId: string): Promise<RiskIntelligenceResponseDto> {
    const [
      profile,
      brokerConnected,
      killSwitchActive,
      openPositions,
      todayTrades,
      portfolioAccounts,
      violations,
    ] = await Promise.all([
      this.riskService.getOrCreateProfile(userId),
      this.riskService.hasBrokerConnection(userId),
      this.riskService.isKillSwitchActive(userId),
      this.executionService.countOpenTrades(userId),
      this.executionService.countTodayTrades(userId),
      this.portfolioReadService.listAccounts(userId),
      this.riskService.getViolations(userId, 10),
    ]);

    const connectedAccounts = portfolioAccounts.filter(
      (account) => account.connectionStatus === 'CONNECTED',
    ).length;
    const freshSnapshots = portfolioAccounts.filter(
      (account) => account.snapshot?.freshness === 'FRESH',
    ).length;
    const staleSnapshots = portfolioAccounts.filter(
      (account) => account.snapshot?.freshness === 'STALE',
    ).length;
    const unavailableSnapshots = portfolioAccounts.filter(
      (account) => account.snapshot === null,
    ).length;

    return {
      engine: {
        killSwitchActive,
        brokerConnected,
      },
      policy: {
        riskAcknowledgementAccepted: profile.riskAcknowledgementAccepted,
        allowedTradingMode: profile.allowedTradingModes,
        limits: {
          maxDailyLossPercent: profile.maxDailyLossPercent,
          maxDrawdownPercent: profile.maxDrawdownPercent,
          maxOpenTrades: profile.maxOpenTrades,
          maxPositionSizeLot: profile.maxPositionSizeLot,
          minStopLossPips: profile.minStopLossPips,
          maxVolatilityScore: profile.maxVolatilityScore,
          maxTradeRiskPercent: profile.maxTradeRiskPercent,
          maxLeverageAllowed: profile.maxLeverageAllowed,
          allowedInstruments: profile.allowedInstruments,
          rejectLowLiquidity: profile.rejectLowLiquidity,
        },
      },
      execution: {
        openPositions,
        maxOpenPositions: profile.maxOpenTrades,
        openPositionSlotsRemaining: Math.max(profile.maxOpenTrades - openPositions, 0),
        todayTrades,
        dailyTradeCountPolicy: 'UNBOUNDED' as const,
      },
      portfolio: {
        totalAccounts: portfolioAccounts.length,
        connectedAccounts,
        freshSnapshots,
        staleSnapshots,
        unavailableSnapshots,
      },
      recentViolations: violations.map(toRiskViolationSummary),
    };
  }
}
