/**
 * Owner-authorized ongoing higher-size observation on ONE Pepperstone USD DEMO.
 * This only raises the MAXIMUM REQUESTED volume to 7.00 lots for admitted
 * continuous CR/ET signals. It NEVER forces 4 / 4.5 / 6 / 7 fills.
 * Actual broker min/max/step, model filters, initial stop risk, drawdown,
 * exposure, leverage, fees, spread, fresh quotes and margin remain binding.
 *
 * Unlike the retired noon trial, this permission is enabled by a separate
 * explicit environment flag and remains DEMO-only until disabled by owner.
 * No LIVE account can inherit the flag from broker ID alone.
 */
export const OWNER_DEMO_ONGOING_SEVEN_LOT_ARTIFACT =
  'owner-pepperstone-usd-demo-ongoing-seven-lot-20261120-v1' as const;
export const OWNER_DEMO_ONGOING_SEVEN_LOT_START = '2026-11-20T12:50:00.000Z';
export const OWNER_DEMO_ONGOING_SEVEN_LOT_REQUESTED_MAX_LOTS = 7;
export const OWNER_DEMO_ONGOING_SEVEN_LOT_STOP_RISK_SCREEN_PERCENT = 0.75;

export type OwnerDemoOngoingSevenLotInput = {
  enabled: boolean;
  userId: string;
  configuredOwnerId: string | null | undefined;
  brokerConnectionId: string;
  configuredBrokerConnectionId: string | null | undefined;
  brokerId: string | null;
  accountType: string | null;
  accountCurrency: string | null;
  now: Date;
};

export function ownerPepperstoneDemoOngoingSevenLot(input: OwnerDemoOngoingSevenLotInput) {
  const time = input.now instanceof Date ? input.now.getTime() : NaN;
  const eligible =
    input.enabled === true &&
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
    time >= Date.parse(OWNER_DEMO_ONGOING_SEVEN_LOT_START);
  return {
    eligible,
    artifact: eligible ? OWNER_DEMO_ONGOING_SEVEN_LOT_ARTIFACT : null,
    endsAt: null,
    maxRequestedLots: eligible ? OWNER_DEMO_ONGOING_SEVEN_LOT_REQUESTED_MAX_LOTS : 4,
    maximumPrescreenRiskPercent: eligible
      ? OWNER_DEMO_ONGOING_SEVEN_LOT_STOP_RISK_SCREEN_PERCENT
      : 0.25,
    requiresActualBrokerRiskApproval: true as const,
    noLiveAuthority: true as const,
  };
}
