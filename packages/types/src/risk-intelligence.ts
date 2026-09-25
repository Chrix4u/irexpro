export type RiskTradingMode = 'PAPER_ONLY' | 'SEMI_AUTO' | 'FULL_AUTO';

export type RiskRejectionCodeView =
  | 'KILL_SWITCH_ACTIVE'
  | 'SESSION_NOT_ACTIVE'
  | 'BROKER_DISCONNECTED'
  | 'DAILY_LOSS_LIMIT_REACHED'
  | 'MAX_DRAWDOWN_REACHED'
  | 'INSUFFICIENT_MARGIN'
  | 'MAX_CONCURRENT_TRADES'
  | 'MAX_DAILY_TRADES'
  | 'POSITION_SIZE_EXCEEDED'
  | 'MISSING_STOP_LOSS'
  | 'MISSING_TAKE_PROFIT'
  | 'INVALID_SL_DISTANCE'
  | 'INVALID_TP_DIRECTION'
  | 'LEVERAGE_EXCEEDED'
  | 'INSTRUMENT_NOT_ALLOWED'
  | 'HIGH_VOLATILITY'
  | 'LOW_LIQUIDITY_REGIME'
  | 'DUPLICATE_SIGNAL'
  | 'RISK_ENGINE_ERROR';

export interface RiskViolationSummaryView {
  id: string;
  rejectionCode: RiskRejectionCodeView;
  rejectionReason: string;
  evaluatedAt: string;
}

export interface RiskPolicyLimitsView {
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

export interface RiskIntelligenceView {
  engine: {
    killSwitchActive: boolean;
    brokerConnected: boolean;
  };
  policy: {
    riskAcknowledgementAccepted: boolean;
    allowedTradingMode: RiskTradingMode;
    limits: RiskPolicyLimitsView;
  };
  execution: {
    openPositions: number;
    maxOpenPositions: number;
    openPositionSlotsRemaining: number;
    todayTrades: number;
    dailyTradeCountPolicy: 'UNBOUNDED';
  };
  portfolio: {
    totalAccounts: number;
    connectedAccounts: number;
    freshSnapshots: number;
    staleSnapshots: number;
    unavailableSnapshots: number;
  };
  recentViolations: RiskViolationSummaryView[];
}
