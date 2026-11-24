import type { CandleAwareExitShadowDecision } from './candle-aware-profit-patience-shadow';
import {
  isDurablyReconciledProfitStopEvidence,
  type DemoProfitStopIntentState,
} from './demo-profit-stop-amendment-state';

/**
 * Fail-closed decision for a DEMO EXISTING position only. It can only say a
 * profit lock MAY be temporarily deferred if provider, authoritative trade,
 * durable stop-intent and causal M1/M5 all agree. It NEVER amends a stop,
 * creates an order, authorizes LIVE, or treats a quote as broker ACK.
 * External orchestration must execute the immediate close on every rejection.
 */
export type ProtectedRunnerDecision = {
  decision: 'HOLD_PROTECTED' | 'CLOSE_NOW';
  reason:
    | 'SCOPE_OR_POSITION_MISMATCH'
    | 'BROKER_STOP_NOT_POSITIVE_OR_MISMATCHED'
    | 'BROKER_STOP_READBACK_STALE'
    | 'BROKER_ACK_AND_DURABLE_AUTHORITY_UNPROVEN'
    | 'CANDLE_CONTINUATION_UNPROVEN'
    | 'PROFIT_FLOOR_INSUFFICIENT'
    | 'FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE'
    | 'INDEPENDENT_EXPERT_CONFIRMED_REVERSAL'
    | 'GRACE_EXPIRED_OR_UNPROVABLE'
    | 'BROKER_VERIFIED_CONTINUATION_WINDOW';
  maxHoldSeconds: 180;
  mustRecheckWithinSeconds: 5;
  noBrokerOrderActions: true;
  liveExecutionAuthorized: false;
};

export interface VerifiedProfitRunnerInput {
  brokerId: string;
  accountType: string;
  accountCurrency: string;
  userId: string;
  ownerUserId: string | null;
  tradeBrokerConnectionId: string;
  ledgerBrokerConnectionId: string;
  tradeProviderPositionId: string;
  ledgerProviderPositionId: string;
  brokerProviderPositionId: string;
  direction: 'BUY' | 'SELL';
  brokerDirection: 'BUY' | 'SELL';
  tradeLots: number;
  brokerLots: number;
  now: Date;
  holdStartedAt: Date;
  brokerReadbackAt: Date;
  entryPrice: number;
  currentBrokerMark: number;
  originalStop: number;
  ledgerProposedStop: number;
  authoritativeStop: number;
  brokerReadbackStop: number;
  takeProfit: number;
  brokerReadbackTakeProfit: number;
  brokerNetPnl: number;
  netFloorAfterCosts: number;
  initialRiskPnl: number;
  estimatedExitCostsUsd: number;
  adverseSlippageReserveUsd: number;
  independentExpertConfirmedOpposite: boolean;
  ledgerState: DemoProfitStopIntentState;
  brokerAcceptedAt: Date | null;
  brokerVerifiedAt: Date | null;
  authorityCommittedAt: Date | null;
  ledgerExpiresAt: Date;
  candle: CandleAwareExitShadowDecision | null;
}

export function evaluateVerifiedProfitRunnerHold(
  i: VerifiedProfitRunnerInput,
): ProtectedRunnerDecision {
  const close = (reason: ProtectedRunnerDecision['reason']): ProtectedRunnerDecision => ({
    decision: reason === 'BROKER_VERIFIED_CONTINUATION_WINDOW' ? 'HOLD_PROTECTED' : 'CLOSE_NOW',
    reason,
    maxHoldSeconds: 180,
    mustRecheckWithinSeconds: 5,
    noBrokerOrderActions: true,
    liveExecutionAuthorized: false,
  });
  if (
    !i.ownerUserId ||
    i.userId !== i.ownerUserId ||
    i.brokerId !== 'pepperstone-ctrader' ||
    i.accountType !== 'DEMO' ||
    i.accountCurrency !== 'USD' ||
    !i.tradeBrokerConnectionId ||
    i.tradeBrokerConnectionId !== i.ledgerBrokerConnectionId ||
    !i.tradeProviderPositionId ||
    i.tradeProviderPositionId !== i.ledgerProviderPositionId ||
    i.tradeProviderPositionId !== i.brokerProviderPositionId ||
    i.direction !== i.brokerDirection ||
    !Number.isFinite(i.tradeLots) ||
    i.tradeLots <= 0 ||
    !Number.isFinite(i.brokerLots) ||
    Math.abs(i.tradeLots - i.brokerLots) > 0.00005
  ) {
    return close('SCOPE_OR_POSITION_MISMATCH');
  }
  const nums = [
    i.entryPrice,
    i.currentBrokerMark,
    i.originalStop,
    i.ledgerProposedStop,
    i.authoritativeStop,
    i.brokerReadbackStop,
    i.takeProfit,
    i.brokerReadbackTakeProfit,
    i.brokerNetPnl,
    i.netFloorAfterCosts,
    i.initialRiskPnl,
  ];
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) {
    return close('BROKER_STOP_NOT_POSITIVE_OR_MISMATCHED');
  }
  const tick = i.takeProfit > 10 ? 0.001 : 0.00001;
  const eps = tick / 10;
  const equal = (a: number, b: number) => Math.abs(a - b) <= eps;
  const geometry =
    i.direction === 'BUY'
      ? i.originalStop < i.entryPrice &&
        i.entryPrice + tick < i.ledgerProposedStop &&
        i.ledgerProposedStop + 2 * tick < i.currentBrokerMark &&
        i.currentBrokerMark < i.takeProfit
      : i.originalStop > i.entryPrice &&
        i.entryPrice - tick > i.ledgerProposedStop &&
        i.ledgerProposedStop - 2 * tick > i.currentBrokerMark &&
        i.currentBrokerMark > i.takeProfit;
  if (
    !geometry ||
    !equal(i.ledgerProposedStop, i.authoritativeStop) ||
    !equal(i.ledgerProposedStop, i.brokerReadbackStop) ||
    !equal(i.takeProfit, i.brokerReadbackTakeProfit)
  ) {
    return close('BROKER_STOP_NOT_POSITIVE_OR_MISMATCHED');
  }
  const now = i.now.getTime();
  if (i.independentExpertConfirmedOpposite) {
    return close('INDEPENDENT_EXPERT_CONFIRMED_REVERSAL');
  }
  const brokerReadbackAge = (now - i.brokerReadbackAt.getTime()) / 1000;
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(brokerReadbackAge) ||
    brokerReadbackAge < 0 ||
    brokerReadbackAge > 5
  ) {
    return close('BROKER_STOP_READBACK_STALE');
  }
  const ackTime = i.brokerAcceptedAt?.getTime() ?? NaN;
  const verifyTime = i.brokerVerifiedAt?.getTime() ?? NaN;
  const commitTime = i.authorityCommittedAt?.getTime() ?? NaN;
  if (
    !Number.isFinite(ackTime) ||
    !Number.isFinite(verifyTime) ||
    !Number.isFinite(commitTime) ||
    ackTime > verifyTime ||
    verifyTime > commitTime ||
    commitTime > now ||
    i.brokerReadbackAt.getTime() < commitTime ||
    i.holdStartedAt.getTime() < commitTime
  ) {
    return close('BROKER_ACK_AND_DURABLE_AUTHORITY_UNPROVEN');
  }
  if (
    !isDurablyReconciledProfitStopEvidence({
      state: i.ledgerState,
      brokerAcceptedAt: i.brokerAcceptedAt,
      brokerVerifiedAt: i.brokerVerifiedAt,
      authoritativeCommittedAt: i.authorityCommittedAt,
      brokerStop: i.brokerReadbackStop,
      persistedStop: i.authoritativeStop,
      proposedStop: i.ledgerProposedStop,
      observedAt: i.now,
    }) ||
    !Number.isFinite(i.ledgerExpiresAt.getTime()) ||
    i.ledgerExpiresAt.getTime() <= now
  ) {
    return close('BROKER_ACK_AND_DURABLE_AUTHORITY_UNPROVEN');
  }
  const candle = i.candle;
  const candleAge = candle ? (now - new Date(candle.asOf).getTime()) / 1000 : NaN;
  if (
    !candle ||
    candle.mode !== 'SHADOW_ONLY' ||
    !candle.noTradeAuthority ||
    !candle.wouldResearchProtectedGrace ||
    candle.reason !== 'SAME_DIRECTION_PULLBACK_CANDIDATE' ||
    candle.changesLiveExit ||
    !Number.isFinite(candleAge) ||
    candleAge < 0 ||
    candleAge > 5 ||
    candle.m5Aligned !== true ||
    candle.m1CompletedBars !== 2
  ) {
    return close('CANDLE_CONTINUATION_UNPROVEN');
  }
  if (
    !Number.isFinite(i.initialRiskPnl) ||
    i.initialRiskPnl <= 0 ||
    !Number.isFinite(i.estimatedExitCostsUsd) ||
    i.estimatedExitCostsUsd <= 0 ||
    !Number.isFinite(i.adverseSlippageReserveUsd) ||
    i.adverseSlippageReserveUsd <= 0 ||
    !Number.isFinite(i.netFloorAfterCosts)
  ) {
    return close('FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE');
  }
  // Independent conservative cross-check: do not trust the ledger's claimed
  // net floor unless the amended STOP price itself implies enough gross
  // profit (from original R-distance), after fees and extra slippage reserve.
  // This is a screening estimate, NOT a guarantee against a market gap.
  const originalRiskDistance = Math.abs(i.entryPrice - i.originalStop);
  const lockedPriceGain = Math.abs(i.ledgerProposedStop - i.entryPrice);
  if (originalRiskDistance <= 0 || lockedPriceGain <= 0) {
    return close('FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE');
  }
  const independentFloorGross = (i.initialRiskPnl * lockedPriceGain) / originalRiskDistance;
  const independentFloorNet =
    independentFloorGross - i.estimatedExitCostsUsd - i.adverseSlippageReserveUsd;
  if (
    !Number.isFinite(independentFloorNet) ||
    independentFloorNet < Math.max(0.1 * i.initialRiskPnl, 1) ||
    i.netFloorAfterCosts > independentFloorNet + 0.01
  ) {
    return close('FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE');
  }
  if (
    i.netFloorAfterCosts < Math.max(0.1 * i.initialRiskPnl, 1) ||
    i.brokerNetPnl <= i.netFloorAfterCosts
  ) {
    return close('PROFIT_FLOOR_INSUFFICIENT');
  }
  const elapsed = (now - i.holdStartedAt.getTime()) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 180) {
    return close('GRACE_EXPIRED_OR_UNPROVABLE');
  }
  return close('BROKER_VERIFIED_CONTINUATION_WINDOW');
}
