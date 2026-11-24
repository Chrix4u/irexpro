import type { BrokerInstrument } from '../../broker/interfaces/broker-adapter.interface';

/**
 * Broker-native cTrader min-stop-distance preflight, SHADOW ONLY.
 * The cTrader ProtoOASymbol unit can be points or percentage. Only POINTS
 * are normalized here; percentage is explicitly unsupported until its exact
 * broker representation has been verified against an actual symbol response.
 *
 * A passing preflight is NOT a broker acknowledgement, order permission,
 * profitable stop guarantee, or reason to delay the five-second profit lock.
 */
export interface CtraderStopDistanceProofInput {
  ownerDemoVerified: boolean;
  brokerId: string;
  accountType: string;
  currency: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  originalStop: number;
  originalTakeProfit: number;
  proposedStop: number;
  lastBid: number | null;
  lastAsk: number | null;
  quoteObservedAt: Date | null;
  observedAt: Date;
  symbol: BrokerInstrument | null;
}
export type CtraderStopDistanceProof = {
  mode: 'SHADOW_ONLY';
  candidateMeetsAdvertisedMinDistance: boolean;
  reason:
    | 'NOT_OWNER_PEPPERSTONE_USD_DEMO'
    | 'SYMBOL_METADATA_MISSING_OR_UNMATCHED'
    | 'MIN_STOP_DISTANCE_UNAVAILABLE'
    | 'PERCENTAGE_DISTANCE_NOT_NORMALIZED'
    | 'STALE_OR_INVALID_BROKER_QUOTE'
    | 'INVALID_PRICE_OR_RISK_GEOMETRY'
    | 'STOP_TOO_CLOSE_TO_BROKER_MARKET'
    | 'BROKER_MIN_STOP_POINTS_PASSED_REQUIRES_PROVIDER_ACK_AND_READBACK';
  minDistancePrice: number | null;
  quoteAgeSeconds: number | null;
  stopHeadroomPrice: number | null;
  brokerOrderActions: 0;
  changesExecution: false;
};

/**
 * Prepare a RESEARCH-ONLY candidate for the provider's actual tick grid.
 * BUY stop rounds DOWN; SELL stop rounds UP, so rounding never pretends
 * to guarantee MORE protection than the original indicative price.
 * The preflight must then re-check geometry, minimum stop distance and
 * net-profit floor using the rounded level; this function grants nothing.
 */
export function normalizeIndicativeCtraderStopToTick(
  stop: number,
  direction: 'BUY' | 'SELL',
  digits: number,
): number | null {
  if (!Number.isFinite(stop) || stop <= 0 || !Number.isInteger(digits) || digits < 1 || digits > 9)
    return null;
  const scale = 10 ** digits;
  const scaled = stop * scale;
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) return null;
  const tolerance = 1e-7;
  const units =
    direction === 'BUY' ? Math.floor(scaled + tolerance) : Math.ceil(scaled - tolerance);
  if (units <= 0) return null;
  return Number((units / scale).toFixed(digits));
}

export function evaluateCtraderStopDistanceProof(
  i: CtraderStopDistanceProofInput,
): CtraderStopDistanceProof {
  const fail = (
    reason: CtraderStopDistanceProof['reason'],
    minDistancePrice: number | null = null,
    quoteAgeSeconds: number | null = null,
    stopHeadroomPrice: number | null = null,
  ): CtraderStopDistanceProof => ({
    mode: 'SHADOW_ONLY',
    candidateMeetsAdvertisedMinDistance:
      reason === 'BROKER_MIN_STOP_POINTS_PASSED_REQUIRES_PROVIDER_ACK_AND_READBACK',
    reason,
    minDistancePrice,
    quoteAgeSeconds,
    stopHeadroomPrice,
    brokerOrderActions: 0,
    changesExecution: false,
  });

  if (
    !i.ownerDemoVerified ||
    i.brokerId !== 'pepperstone-ctrader' ||
    i.accountType !== 'DEMO' ||
    i.currency !== 'USD'
  ) {
    return fail('NOT_OWNER_PEPPERSTONE_USD_DEMO');
  }
  const norm = (x: string) => x.replace(/[^A-Z]/gi, '').toUpperCase();
  if (
    !i.symbol ||
    norm(i.instrument) !== norm(i.symbol.symbol) ||
    !Number.isInteger(i.symbol.digits) ||
    i.symbol.digits < 1 ||
    i.symbol.digits > 9
  ) {
    return fail('SYMBOL_METADATA_MISSING_OR_UNMATCHED');
  }
  const raw = i.symbol.minStopLossDistance;
  const points = raw == null ? NaN : Number(raw);
  // cTrader declares slDistance as an OPTIONAL unsigned integer; a
  // PRESENT 0 means zero published minimum, while an ABSENT field stays
  // UNKNOWN. Spread/tick headroom remains mandatory even for published 0.
  if (
    raw === null ||
    raw === undefined ||
    raw === '' ||
    !Number.isInteger(points) ||
    points < 0 ||
    !i.symbol.minStopLossDistanceUnit
  ) {
    return fail('MIN_STOP_DISTANCE_UNAVAILABLE');
  }
  if (i.symbol.minStopLossDistanceUnit !== 'POINTS') {
    return fail('PERCENTAGE_DISTANCE_NOT_NORMALIZED');
  }
  const tick = Math.pow(10, -i.symbol.digits);
  const minPrice = Number((points * tick).toFixed(Math.min(12, i.symbol.digits + 3)));
  const when = i.quoteObservedAt?.getTime() ?? NaN;
  const at = i.observedAt.getTime();
  const ageSeconds = (at - when) / 1000;
  const bid = i.lastBid ?? NaN,
    ask = i.lastAsk ?? NaN;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > 5 ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    // A published zero minimum does NOT imply a zero allowable spread.
    // Keep a conservative independent spread cap of twelve ticks.
    bid <= 0 ||
    ask <= bid ||
    ask - bid > Math.max(minPrice * 3, tick * 12)
  ) {
    return fail(
      'STALE_OR_INVALID_BROKER_QUOTE',
      minPrice,
      Number.isFinite(ageSeconds) ? ageSeconds : null,
    );
  }
  const vals = [i.entryPrice, i.originalStop, i.originalTakeProfit, i.proposedStop];
  if (
    vals.some((x) => !Number.isFinite(x) || x <= 0) ||
    Math.abs(i.proposedStop / tick - Math.round(i.proposedStop / tick)) > 0.00001
  ) {
    return fail('INVALID_PRICE_OR_RISK_GEOMETRY', minPrice, ageSeconds);
  }
  const buy = i.direction === 'BUY';
  const geometry = buy
    ? i.originalStop < i.entryPrice &&
      i.entryPrice < i.proposedStop &&
      i.proposedStop < i.originalTakeProfit &&
      i.originalTakeProfit > bid
    : i.originalStop > i.entryPrice &&
      i.entryPrice > i.proposedStop &&
      i.proposedStop > i.originalTakeProfit &&
      i.originalTakeProfit < ask;
  if (!geometry) return fail('INVALID_PRICE_OR_RISK_GEOMETRY', minPrice, ageSeconds);
  const stopDistance = buy ? bid - i.proposedStop : i.proposedStop - ask;
  const buffer = Math.max((ask - bid) * 2, tick * 2);
  const headroom = stopDistance - (minPrice + buffer);
  if (!Number.isFinite(stopDistance) || headroom <= 0) {
    return fail(
      'STOP_TOO_CLOSE_TO_BROKER_MARKET',
      minPrice,
      ageSeconds,
      Number.isFinite(headroom) ? headroom : null,
    );
  }
  return fail(
    'BROKER_MIN_STOP_POINTS_PASSED_REQUIRES_PROVIDER_ACK_AND_READBACK',
    minPrice,
    ageSeconds,
    headroom,
  );
}
