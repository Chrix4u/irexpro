import { isForexPreRolloverHour } from '../../ai/forex-session-clock';

/**
 * Risk telemetry only. A historically observed 12.7-pip spread at NY
 * rollover (vs. 0.3 pip shortly before it) breached a tiny AUDUSD SELL
 * protective stop. There is only ONE confirmed same-account exposure
 * example, so this policy cannot authorize preemptive broker liquidation.
 */
export const PEPPERSTONE_DEMO_ROLLOVER_EXPOSURE_ARTIFACT =
  'pepperstone-demo-rollover-stop-exposure-shadow-v1';

export type PepperstoneRolloverExposureReason =
  | 'OUTSIDE_RISK_WINDOW'
  | 'NOT_VERIFIED_PEPPERSTONE_DEMO'
  | 'STALE_OR_INVALID_BROKER_QUOTE'
  | 'BROKER_STOP_NOT_VERIFIED'
  | 'MISSING_BROKER_RISK'
  | 'STOP_ALREADY_CROSSED'
  | 'NEAR_STOP_AND_ADVERSE'
  | 'SPREAD_THREATENS_STOP'
  | 'NOT_NEAR_STOP';

export interface PepperstoneRolloverExposureInput {
  brokerId: string;
  accountType: string;
  observedAt: Date;
  direction: 'BUY' | 'SELL';
  instrument: string;
  positionSizeLots: number;
  initialRiskPnl: number | null;
  currentBrokerNetPnl: number | null;
  entryPrice: number | null;
  authoritativeStop: number | null;
  brokerStop: number | null;
  bid: number | null;
  ask: number | null;
  quoteObservedAt: Date | null;
}

export interface PepperstoneRolloverExposureDecision {
  artifact: typeof PEPPERSTONE_DEMO_ROLLOVER_EXPOSURE_ARTIFACT;
  mode: 'SHADOW_ONLY';
  wouldConsiderPreRolloverClose: boolean;
  reason: PepperstoneRolloverExposureReason;
  minutesUntilRollover: number | null;
  stopDistancePips: number | null;
  observedSpreadPips: number | null;
  initialStopPips: number | null;
  currentR: number | null;
  noBrokerTradeAuthority: true;
  modifiesOpenPositions: false;
}

/** 16:50–16:59 New York; auto-adjusts for US daylight saving time. */
export function isForexFinalTenMinutesBeforeRollover(at: Date): boolean {
  return isForexPreRolloverHour(at) && at.getUTCMinutes() >= 50;
}

export function evaluatePepperstoneDemoRolloverExposure(
  input: PepperstoneRolloverExposureInput,
): PepperstoneRolloverExposureDecision {
  const hold = (
    reason: PepperstoneRolloverExposureReason,
    partial: Partial<Pick<PepperstoneRolloverExposureDecision,
      'minutesUntilRollover' | 'stopDistancePips' | 'observedSpreadPips'
      | 'initialStopPips' | 'currentR'>> = {},
  ): PepperstoneRolloverExposureDecision => ({
    artifact: PEPPERSTONE_DEMO_ROLLOVER_EXPOSURE_ARTIFACT,
    mode: 'SHADOW_ONLY',
    wouldConsiderPreRolloverClose: reason === 'NEAR_STOP_AND_ADVERSE' ||
      reason === 'SPREAD_THREATENS_STOP',
    reason,
    minutesUntilRollover: partial.minutesUntilRollover ?? null,
    stopDistancePips: partial.stopDistancePips ?? null,
    observedSpreadPips: partial.observedSpreadPips ?? null,
    initialStopPips: partial.initialStopPips ?? null,
    currentR: partial.currentR ?? null,
    noBrokerTradeAuthority: true,
    modifiesOpenPositions: false,
  });
  if (input.brokerId !== 'pepperstone-ctrader' ||
      input.accountType.toUpperCase() !== 'DEMO')
    return hold('NOT_VERIFIED_PEPPERSTONE_DEMO');
  if (!isForexFinalTenMinutesBeforeRollover(input.observedAt))
    return hold('OUTSIDE_RISK_WINDOW');
  const minutesUntilRollover =
    (60 - input.observedAt.getUTCMinutes()) -
    input.observedAt.getUTCSeconds() / 60 -
    input.observedAt.getUTCMilliseconds() / 60_000;
  const partial = { minutesUntilRollover };
  const { bid, ask, quoteObservedAt } = input;
  const quoteAgeSeconds = quoteObservedAt
    ? (input.observedAt.getTime() - quoteObservedAt.getTime()) / 1000
    : Number.NaN;
  if (
    bid === null || ask === null || !Number.isFinite(bid) ||
    !Number.isFinite(ask) || bid <= 0 || ask <= bid ||
    !Number.isFinite(quoteAgeSeconds) || quoteAgeSeconds < 0 ||
    quoteAgeSeconds > 45
  ) return hold('STALE_OR_INVALID_BROKER_QUOTE', partial);

  const pip = input.instrument.endsWith('JPY') ? 0.01 : 0.0001;
  const spreadPips = (ask - bid) / pip;
  const stop = input.authoritativeStop;
  const brokerStop = input.brokerStop;
  if (
    stop === null || brokerStop === null ||
    !Number.isFinite(stop) || !Number.isFinite(brokerStop) ||
    stop <= 0 || brokerStop <= 0 ||
    Math.abs(stop - brokerStop) > pip * 0.15
  ) return hold('BROKER_STOP_NOT_VERIFIED', {
    ...partial, observedSpreadPips: spreadPips,
  });
  const { entryPrice, initialRiskPnl, currentBrokerNetPnl } = input;
  if (
    entryPrice === null || !Number.isFinite(entryPrice) ||
    entryPrice <= 0 || !Number.isFinite(input.positionSizeLots) ||
    input.positionSizeLots <= 0 || initialRiskPnl === null ||
    !Number.isFinite(initialRiskPnl) || initialRiskPnl <= 0 ||
    currentBrokerNetPnl === null || !Number.isFinite(currentBrokerNetPnl)
  ) return hold('MISSING_BROKER_RISK', {
    ...partial, observedSpreadPips: spreadPips,
  });
  const initialStopPips =
    (input.direction === 'BUY' ? entryPrice - stop : stop - entryPrice) / pip;
  if (!Number.isFinite(initialStopPips) || initialStopPips <= 0)
    return hold('MISSING_BROKER_RISK', {
      ...partial, observedSpreadPips: spreadPips,
    });
  const executableClosePrice = input.direction === 'BUY' ? bid : ask;
  const stopDistancePips =
    (input.direction === 'BUY' ? executableClosePrice - stop
      : stop - executableClosePrice) / pip;
  const currentR = currentBrokerNetPnl / initialRiskPnl;
  const details = {
    ...partial, stopDistancePips, observedSpreadPips: spreadPips,
    initialStopPips, currentR,
  };
  if (stopDistancePips <= 0) return hold('STOP_ALREADY_CROSSED', details);

  // Do not classify a position as near-stop based on a mid price. For a
  // SELL, only the actual ASK quote can determine stop-loss exposure.
  if (spreadPips >= stopDistancePips && currentR < 0)
    return hold('SPREAD_THREATENS_STOP', details);
  // A narrow buffer plus a materially adverse position is a research
  // de-risk candidate; it is NOT a proved profitable market close.
  if (currentR <= -0.25 &&
      stopDistancePips <= Math.max(2, initialStopPips * 0.35))
    return hold('NEAR_STOP_AND_ADVERSE', details);
  return hold('NOT_NEAR_STOP', details);
}
