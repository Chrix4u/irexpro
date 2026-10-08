export type AiBidirectionalDirection = 'BUY' | 'SELL';
export type AiBidirectionalStrategyRoute =
  | 'TREND_CONTINUATION'
  | 'CONFIRMED_REVERSAL'
  | 'EARLY_TRANSITION';
export type AiBidirectionalDriftState = 'NORMAL' | 'STRESSED' | 'OUT_OF_DISTRIBUTION';

export interface AiBidirectionalSideDto {
  direction: AiBidirectionalDirection;
  evaluatedAt: string;
  confidence: number;
  metaProbability: number;
  grossExpectedR: number;
  netExpectedR: number | null;
  regime: string;
  strategyRoute: AiBidirectionalStrategyRoute | null;
  consensusPassed: number;
  consensusRequired: number;
  paperAdmitted: boolean;
  paperExecutionEligible: boolean;
  driftState: AiBidirectionalDriftState | null;
  blockers: string[];
}

export interface AiBidirectionalComparisonDto {
  instrument: string;
  marketBarTime: string;
  decisionPolicyVersion: string;
  selectionStatus:
    | 'BUY_ELIGIBLE'
    | 'SELL_ELIGIBLE'
    | 'BOTH_ELIGIBLE'
    | 'NO_ELIGIBLE_DIRECTION';
  selectedDirection: AiBidirectionalDirection | null;
  buy: AiBidirectionalSideDto | null;
  sell: AiBidirectionalSideDto | null;
}

export interface AiBidirectionalDecisionResponseDto {
  generatedAt: string;
  policyVersion: string | null;
  comparisons: AiBidirectionalComparisonDto[];
}
