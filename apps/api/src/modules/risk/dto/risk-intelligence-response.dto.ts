import type { AllowedTradingMode } from '../entities/risk-profile.entity';
import type { RiskRejectionCode } from '../interfaces/risk.interface';

export class RiskViolationSummaryResponseDto {
  id: string;
  rejectionCode: RiskRejectionCode;
  rejectionReason: string;
  evaluatedAt: Date;
}

export class RiskPolicyLimitsResponseDto {
  maxDailyLossPercent: string;
  maxDrawdownPercent: string;
  maxOpenTrades: number;
  maxPositionSizeLot: string;
  minStopLossPips: string;
  maxVolatilityScore: string;
  maxTradeRiskPercent: string;
  maxLeverageAllowed: number;
  allowedInstruments: string[] | null;
  rejectLowLiquidity: boolean;
}

export class RiskPolicySummaryResponseDto {
  riskAcknowledgementAccepted: boolean;
  allowedTradingMode: AllowedTradingMode;
  limits: RiskPolicyLimitsResponseDto;
}

export class RiskEngineSummaryResponseDto {
  killSwitchActive: boolean;
  brokerConnected: boolean;
}

export class RiskExecutionCapacityResponseDto {
  openPositions: number;
  maxOpenPositions: number;
  openPositionSlotsRemaining: number;
  todayTrades: number;
  dailyTradeCountPolicy: 'UNBOUNDED';
}

export class PortfolioFreshnessSummaryResponseDto {
  totalAccounts: number;
  connectedAccounts: number;
  freshSnapshots: number;
  staleSnapshots: number;
  unavailableSnapshots: number;
}

export class RiskIntelligenceResponseDto {
  engine: RiskEngineSummaryResponseDto;
  policy: RiskPolicySummaryResponseDto;
  execution: RiskExecutionCapacityResponseDto;
  portfolio: PortfolioFreshnessSummaryResponseDto;
  recentViolations: RiskViolationSummaryResponseDto[];
}
