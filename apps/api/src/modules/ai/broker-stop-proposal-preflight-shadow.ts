/**
 * Non-executing candidate preflight for a future BROKER-HELD profit lock.
 *
 * This is NOT a strategy, signal, adapter, broker mutation, or authority grant.
 * It only checks whether a proposed absolute SL would be structurally
 * admissible for further DEMO review. Trading permission remains false.
 * Prices are compared with exact fixed-point BigInt, never binary floats.
 */
export const BROKER_STOP_PREFLIGHT_ARTIFACT = 'broker-held-profit-lock-preflight-shadow-v1';

type Direction = 'BUY' | 'SELL';

export interface BrokerStopProposal {
  userId: string;
  connectionId: string;
  brokerId: string;
  accountType: 'DEMO' | 'LIVE';
  expectedPositionId: string;
  expectedInstrument: string;
  expectedDirection: Direction;
  expectedVolumeLots: string;
  proposedStopLoss: string;
  proposedTakeProfit: string;
  quote: {
    connectionId: string;
    instrument: string;
    source: string;
    bid: string;
    ask: string;
    observedAt: string;
  };
  snapshot: {
    ownerUserId: string;
    connectionId: string;
    positionId: string;
    instrument: string;
    direction: Direction;
    volumeLots: string;
    status: 'OPEN' | 'PENDING' | 'CLOSED' | 'RECONCILING';
    entryPrice: string;
    stopLoss: string;
    takeProfit: string;
  };
  symbol: {
    /** Broker-confirmed exact symbol precision and tick size. */
    brokerMetadataVerified: boolean;
    digits: number;
    tickSize: string;
    /** Already normalized from cTrader distanceSetIn (points or percentage). */
    minStopDistance: string;
    minStopDistanceUnit: 'ABSOLUTE_PRICE' | 'RAW_POINTS' | 'RAW_PERCENT';
    minStopDistanceConversionVerified: boolean;
    /** Explicit conservative price distance covering costs and slippage. */
    verifiedCostBufferPrice: string;
  };
}

export type StopPreflightBlocker =
  | 'LIVE_OR_UNSUPPORTED_BROKER'
  | 'IDENTITY_OR_EXPOSURE_MISMATCH'
  | 'POSITION_NOT_OPEN'
  | 'BROKER_SYMBOL_METADATA_UNVERIFIED'
  | 'MALFORMED_PRICE_OR_VOLUME'
  | 'STOP_PRECISION_OR_TICK_INVALID'
  | 'STOP_NOT_IMPROVED'
  | 'STOP_DOES_NOT_SECURE_AFTER_COST_PROFIT'
  | 'STOP_TOO_CLOSE_TO_EXECUTABLE_QUOTE'
  | 'QUOTE_INVALID_OR_STALE'
  | 'TP_CHANGED_OR_POSITION_ALREADY_AT_TP'
  | 'BROKER_STOP_READBACK_REQUIRED';

export interface BrokerStopPreflight {
  artifact: typeof BROKER_STOP_PREFLIGHT_ARTIFACT;
  executionAuthority: 'NONE';
  brokerWriteAuthorized: false;
  autoPromotionEnabled: false;
  structurallyValid: boolean;
  blockers: StopPreflightBlocker[];
  /** Candidate only: NEVER a statement that the broker has this stop. */
  candidate: { newStopLoss: string; newTakeProfit: string } | null;
  brokerStopConfirmed: false;
  brokerPositionReference: { connectionId: string; positionId: string } | null;
}

function scaled(value: string, digits: number): bigint | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) return null;
  const [whole, frac = ''] = value.split('.');
  if (frac.length > digits) return null;
  try {
    return BigInt(whole!) * 10n ** BigInt(digits) + BigInt(frac.padEnd(digits, '0') || '0');
  } catch {
    return null;
  }
}
function time(iso: string): number {
  if (typeof iso !== 'string' || !iso.endsWith('Z')) return Number.NaN;
  return new Date(iso).getTime();
}

export function validateBrokerStopProposal(
  input: BrokerStopProposal,
  now = new Date(),
): BrokerStopPreflight {
  const blockers = new Set<StopPreflightBlocker>();
  const { quote, snapshot, symbol } = input;
  if (
    input.accountType !== 'DEMO' ||
    !['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader'].includes(input.brokerId)
  )
    blockers.add('LIVE_OR_UNSUPPORTED_BROKER');
  if (
    !input.userId ||
    !input.connectionId ||
    !input.expectedPositionId ||
    !/^[A-Z]{6}$/.test(input.expectedInstrument) ||
    quote.connectionId !== input.connectionId ||
    quote.instrument !== input.expectedInstrument ||
    snapshot.ownerUserId !== input.userId ||
    snapshot.connectionId !== input.connectionId ||
    snapshot.positionId !== input.expectedPositionId ||
    snapshot.instrument !== input.expectedInstrument ||
    snapshot.direction !== input.expectedDirection ||
    scaled(snapshot.volumeLots, 8) === null ||
    scaled(input.expectedVolumeLots, 8) === null ||
    scaled(input.expectedVolumeLots, 8) === 0n ||
    scaled(snapshot.volumeLots, 8) !== scaled(input.expectedVolumeLots, 8)
  )
    blockers.add('IDENTITY_OR_EXPOSURE_MISMATCH');
  if (snapshot.status !== 'OPEN') blockers.add('POSITION_NOT_OPEN');
  if (
    symbol.brokerMetadataVerified !== true ||
    symbol.minStopDistanceUnit !== 'ABSOLUTE_PRICE' ||
    symbol.minStopDistanceConversionVerified !== true ||
    !Number.isInteger(symbol.digits) ||
    symbol.digits < 0 ||
    symbol.digits > 10
  )
    blockers.add('BROKER_SYMBOL_METADATA_UNVERIFIED');
  const digits = symbol.digits;
  const entry = scaled(snapshot.entryPrice, digits);
  const oldStop = scaled(snapshot.stopLoss, digits);
  const newStop = scaled(input.proposedStopLoss, digits);
  const oldTp = scaled(snapshot.takeProfit, digits);
  const newTp = scaled(input.proposedTakeProfit, digits);
  const bid = scaled(quote.bid, digits);
  const ask = scaled(quote.ask, digits);
  const tick = scaled(symbol.tickSize, digits);
  const minDistance = scaled(symbol.minStopDistance, digits);
  const costBuffer = scaled(symbol.verifiedCostBufferPrice, digits);
  if (
    [entry, oldStop, newStop, oldTp, newTp, bid, ask, tick, minDistance, costBuffer].some(
      (value) => value === null,
    ) ||
    !entry ||
    !oldStop ||
    !newStop ||
    !oldTp ||
    !newTp ||
    !bid ||
    !ask
  )
    blockers.add('MALFORMED_PRICE_OR_VOLUME');

  const qt = time(quote.observedAt);
  const current = now.getTime();
  if (
    quote.source !== 'ctrader-broker-native' ||
    !Number.isFinite(qt) ||
    !Number.isFinite(current) ||
    current - qt < 0 ||
    current - qt > 3000 ||
    (bid !== null && ask !== null && bid > ask)
  )
    blockers.add('QUOTE_INVALID_OR_STALE');

  if (
    tick === null ||
    tick <= 0n ||
    minDistance === null ||
    minDistance <= 0n ||
    costBuffer === null ||
    costBuffer <= 0n ||
    (tick !== null &&
      tick > 0n &&
      [entry, oldStop, newStop, oldTp, newTp].some((v) => v !== null && v % tick !== 0n))
  )
    blockers.add('STOP_PRECISION_OR_TICK_INVALID');
  if (oldTp !== null && newTp !== null && oldTp !== newTp) {
    blockers.add('TP_CHANGED_OR_POSITION_ALREADY_AT_TP');
  }
  if (
    entry !== null &&
    oldStop !== null &&
    newStop !== null &&
    oldTp !== null &&
    bid !== null &&
    ask !== null
  ) {
    if (input.expectedDirection === 'BUY') {
      if (oldStop >= bid || newStop <= oldStop) blockers.add('STOP_NOT_IMPROVED');
      if (costBuffer === null || newStop <= entry + costBuffer) {
        blockers.add('STOP_DOES_NOT_SECURE_AFTER_COST_PROFIT');
      }
      if (minDistance === null || newStop >= bid - minDistance) {
        blockers.add('STOP_TOO_CLOSE_TO_EXECUTABLE_QUOTE');
      }
      if (oldTp <= entry || bid >= oldTp) {
        blockers.add('TP_CHANGED_OR_POSITION_ALREADY_AT_TP');
      }
    } else if (input.expectedDirection === 'SELL') {
      if (oldStop <= ask || newStop >= oldStop) blockers.add('STOP_NOT_IMPROVED');
      if (costBuffer === null || newStop >= entry - costBuffer) {
        blockers.add('STOP_DOES_NOT_SECURE_AFTER_COST_PROFIT');
      }
      if (minDistance === null || newStop <= ask + minDistance) {
        blockers.add('STOP_TOO_CLOSE_TO_EXECUTABLE_QUOTE');
      }
      if (oldTp >= entry || ask <= oldTp) {
        blockers.add('TP_CHANGED_OR_POSITION_ALREADY_AT_TP');
      }
    } else blockers.add('IDENTITY_OR_EXPOSURE_MISMATCH');
  }
  return {
    artifact: BROKER_STOP_PREFLIGHT_ARTIFACT,
    executionAuthority: 'NONE',
    brokerWriteAuthorized: false,
    autoPromotionEnabled: false,
    structurallyValid: blockers.size === 0,
    blockers: [...blockers],
    candidate:
      blockers.size === 0
        ? { newStopLoss: input.proposedStopLoss, newTakeProfit: snapshot.takeProfit }
        : null,
    brokerStopConfirmed: false,
    brokerPositionReference:
      blockers.size === 0
        ? { connectionId: input.connectionId, positionId: input.expectedPositionId }
        : null,
  };
}

export interface BrokerStopReadback {
  acceptedByBroker: boolean;
  expectedPositionId: string;
  expectedConnectionId: string;
  requestedAt: string;
  ackAt: string;
  observedAt: string;
  observedConnectionId: string;
  observedPositionId: string;
  observedStatus: 'OPEN' | 'CLOSED' | 'RECONCILING';
  observedStopLoss: string;
  observedTakeProfit: string;
  /** Adapter must make a fresh authenticated broker request, not use DB cache. */
  freshAuthenticatedBrokerRead: boolean;
}

function normalizedPrice(value: string): string | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fractional = ''] = value.split('.');
  const normalizedFraction = fractional.replace(/0+$/, '');
  return BigInt(whole!).toString() + (normalizedFraction ? '.' + normalizedFraction : '');
}

/** Adapter acknowledgement alone cannot confirm an installed stop. */
export function verifyBrokerStopReadback(
  preflight: BrokerStopPreflight,
  observation: BrokerStopReadback,
  now = new Date(),
): { brokerStopConfirmed: boolean; reason: string } {
  if (!preflight.structurallyValid || !preflight.candidate || !preflight.brokerPositionReference) {
    return { brokerStopConfirmed: false, reason: 'PREFLIGHT_NOT_VALID' };
  }
  if (!observation.acceptedByBroker) {
    return { brokerStopConfirmed: false, reason: 'BROKER_REJECT_OR_TIMEOUT' };
  }
  if (
    !observation.freshAuthenticatedBrokerRead ||
    observation.expectedConnectionId !== preflight.brokerPositionReference.connectionId ||
    observation.expectedPositionId !== preflight.brokerPositionReference.positionId ||
    observation.observedConnectionId !== preflight.brokerPositionReference.connectionId ||
    observation.observedPositionId !== preflight.brokerPositionReference.positionId ||
    observation.observedStatus !== 'OPEN'
  )
    return { brokerStopConfirmed: false, reason: 'BROKER_IDENTITY_OR_READ_MISMATCH' };
  const requested = time(observation.requestedAt);
  const ack = time(observation.ackAt);
  const refreshed = time(observation.observedAt);
  if (
    ![requested, ack, refreshed, now.getTime()].every(Number.isFinite) ||
    ack < requested ||
    refreshed <= ack ||
    now.getTime() < refreshed ||
    now.getTime() - refreshed > 5000
  )
    return { brokerStopConfirmed: false, reason: 'READBACK_NOT_AFTER_ACK' };
  if (
    normalizedPrice(observation.observedStopLoss) === null ||
    normalizedPrice(observation.observedTakeProfit) === null ||
    normalizedPrice(observation.observedStopLoss) !==
      normalizedPrice(preflight.candidate.newStopLoss) ||
    normalizedPrice(observation.observedTakeProfit) !==
      normalizedPrice(preflight.candidate.newTakeProfit)
  )
    return { brokerStopConfirmed: false, reason: 'BROKER_STOP_OR_TP_NOT_CONFIRMED' };
  return { brokerStopConfirmed: true, reason: 'BROKER_READBACK_MATCHED' };
}
