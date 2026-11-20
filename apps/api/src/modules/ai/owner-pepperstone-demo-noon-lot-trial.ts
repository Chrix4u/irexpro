/**
 * Explicit owner-only short-lived Pepperstone USD DEMO sizing experiment.
 *
 * This is permission to REQUEST up to six lots from already-admitted signals,
 * never a four-lot fill guarantee or authorization to defeat a stricter stop,
 * drawdown, leverage, fresh quote, available margin or broker instrument limit.
 *
 * Expiration is checked against the actual server clock at each use, not a
 * cached startup flag. Automatically reverts at 12:00 GMT / Ghana time.
 */
export const OWNER_DEMO_NOON_LOT_TRIAL_ARTIFACT =
  'owner-pepperstone-demo-four-plus-until-20261120t1200z-v1' as const;
export const OWNER_DEMO_NOON_LOT_TRIAL_START = '2026-11-20T03:57:00.000Z';
export const OWNER_DEMO_NOON_LOT_TRIAL_END = '2026-11-20T12:00:00.000Z';
export const OWNER_DEMO_NOON_LOT_TRIAL_REQUESTED_MAX_LOTS = 6;
export const OWNER_DEMO_NOON_LOT_TRIAL_STOP_RISK_SCREEN_PERCENT = 0.75;

export function ownerPepperstoneDemoNoonLotTrial(input: {
  enabled: boolean;
  userId: string;
  configuredOwnerId: string | null | undefined;
  brokerConnectionId: string;
  configuredBrokerConnectionId: string | null | undefined;
  brokerId: string | null;
  accountType: string | null;
  accountCurrency: string | null;
  now: Date;
}): {
  eligible: boolean;
  endsAt: typeof OWNER_DEMO_NOON_LOT_TRIAL_END;
  maxRequestedLots: number;
  maximumPrescreenRiskPercent: number;
  requiresActualBrokerRiskApproval: true;
  noLiveAuthority: true;
} {
  const time = input.now instanceof Date ? input.now.getTime() : NaN;
  const allowed = input.enabled === true &&
    !!input.userId &&
    !!input.brokerConnectionId &&
    !!input.configuredOwnerId &&
    !!input.configuredBrokerConnectionId &&
    input.userId === input.configuredOwnerId &&
    input.brokerConnectionId === input.configuredBrokerConnectionId &&
    input.brokerId === 'pepperstone-ctrader' &&
    input.accountType === 'DEMO' &&
    input.accountCurrency === 'USD' &&
    Number.isFinite(time) &&
    time >= Date.parse(OWNER_DEMO_NOON_LOT_TRIAL_START) &&
    time < Date.parse(OWNER_DEMO_NOON_LOT_TRIAL_END);
  return {
    eligible: allowed,
    endsAt: OWNER_DEMO_NOON_LOT_TRIAL_END,
    maxRequestedLots: allowed ? OWNER_DEMO_NOON_LOT_TRIAL_REQUESTED_MAX_LOTS : 4,
    maximumPrescreenRiskPercent:
      allowed ? OWNER_DEMO_NOON_LOT_TRIAL_STOP_RISK_SCREEN_PERCENT : 0.25,
    requiresActualBrokerRiskApproval: true,
    noLiveAuthority: true,
  };
}
