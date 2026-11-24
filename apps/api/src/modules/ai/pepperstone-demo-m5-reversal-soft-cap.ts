/**
 * Owner-scoped Pepperstone USD DEMO exposure mitigation. The prospectively
 * frozen M5-against-side cohort has lost net after commission. Reducing the
 * requested lot ceiling is NOT evidence that any model has positive edge.
 *
 * This never rejects an order, flips direction, widens a stop, increases
 * volume, changes LIVE/PAPER/other tenants, or overrides broker risk checks.
 * Inputs must already have passed owner/broker verification in the scheduler.
 */
export const PEPPERSTONE_DEMO_M5_REVERSAL_SOFT_CAP_ARTIFACT =
  'pepperstone-owner-demo-confirmed-reversal-m5-soft-cap-v1' as const;
export const PEPPERSTONE_DEMO_M5_REVERSAL_MAX_FRACTION = 0.7;
export const PEPPERSTONE_DEMO_M5_REVERSAL_MIN_UNCHANGED_CAP = 1.0;

export interface PepperstoneDemoM5ReversalSoftCapInput {
  enabled: boolean;
  ownerVerifiedUsdDemo: boolean;
  route: string | null;
  alignedM5: number | null;
  brokerM5Direction: string | null;
  requestedLotCap: number;
}

export type PepperstoneDemoM5ReversalSoftCapDecision = {
  artifact: typeof PEPPERSTONE_DEMO_M5_REVERSAL_SOFT_CAP_ARTIFACT;
  applied: boolean;
  reason: string;
  originalLotCap: number;
  requestedLotCap: number;
  alignedM5: number | null;
  brokerM5Direction: string | null;
  authority: 'SOFT_LOT_CEILING_ONLY';
  blocksTrades: false;
  changesStops: false;
  changesLive: false;
};

export function evaluatePepperstoneDemoM5ReversalSoftCap(
  input: PepperstoneDemoM5ReversalSoftCapInput,
): PepperstoneDemoM5ReversalSoftCapDecision {
  const result = (reason: string, cap: number) => ({
    artifact: PEPPERSTONE_DEMO_M5_REVERSAL_SOFT_CAP_ARTIFACT,
    applied: cap < input.requestedLotCap,
    reason,
    originalLotCap: input.requestedLotCap,
    requestedLotCap: cap,
    alignedM5: Number.isFinite(input.alignedM5) ? input.alignedM5 : null,
    brokerM5Direction: input.brokerM5Direction,
    authority: 'SOFT_LOT_CEILING_ONLY' as const,
    blocksTrades: false as const,
    changesStops: false as const,
    changesLive: false as const,
  });
  if (!Number.isFinite(input.requestedLotCap) || input.requestedLotCap <= 0)
    return result('INVALID_BASE_CAP_UNCHANGED', input.requestedLotCap);
  if (!input.enabled || !input.ownerVerifiedUsdDemo || input.route !== 'CONFIRMED_REVERSAL')
    return result('NOT_SCOPED_UNCHANGED', input.requestedLotCap);
  if (!Number.isFinite(input.alignedM5) || input.alignedM5 === null || input.alignedM5 > -0.2)
    return result('NO_FROZEN_M5_CONFLICT_UNCHANGED', input.requestedLotCap);
  // Require separately completed, fresh broker-native M5 bars. A missing
  // as-of independent observation never fabricates a loss signal.
  if (!['NEUTRAL', 'WITH', 'AGAINST'].includes(input.brokerM5Direction ?? ''))
    return result('BROKER_M5_UNVERIFIED_UNCHANGED', input.requestedLotCap);
  // Do not turn an already-small requested ceiling into a micro-lot order.
  if (input.requestedLotCap <= PEPPERSTONE_DEMO_M5_REVERSAL_MIN_UNCHANGED_CAP)
    return result('ALREADY_SMALL_CAP_UNCHANGED', input.requestedLotCap);
  const reduced = Math.max(
    PEPPERSTONE_DEMO_M5_REVERSAL_MIN_UNCHANGED_CAP,
    input.requestedLotCap * PEPPERSTONE_DEMO_M5_REVERSAL_MAX_FRACTION,
  );
  const cap = Math.min(input.requestedLotCap, Number(reduced.toFixed(4)));
  return result('M5_CONFLICT_SOFT_EXPOSURE_REDUCTION', cap);
}
