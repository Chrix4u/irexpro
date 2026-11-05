/**
 * Exact-session, same-currency DEMO FULL_AUTO portfolio safety brake.
 * It never closes a position or promotes a model candidate. All entry paths
 * still have to pass the existing broker-native risk/financial authority.
 */
export const M1_PORTFOLIO_NET_LOSS_BRAKE_ARTIFACT = 'm1-portfolio-net-loss-brake-v1' as const;
export const M1_PORTFOLIO_NET_LOSS_BRAKE_REQUIRED_LOSSES = 3;
export const M1_PORTFOLIO_NET_LOSS_BRAKE_COOLDOWN_MINUTES = 120;
export const M1_PORTFOLIO_NET_LOSS_BRAKE_LOOKBACK_HOURS = 6;

export interface M1PortfolioClosedTradeCost {
  realisedPnl: string | number | null;
  commission: string | number | null;
  swap: string | number | null;
  accountCurrency: string | null;
  sessionCurrency: string | null;
  closedAt: Date;
}

export interface M1PortfolioNetLossBrakeDecision {
  artifact: typeof M1_PORTFOLIO_NET_LOSS_BRAKE_ARTIFACT;
  active: boolean;
  reason:
    | 'CLEAR'
    | 'RECENT_PORTFOLIO_NET_LOSS_STREAK'
    | 'COST_OR_CURRENCY_UNVERIFIED'
    | 'EVIDENCE_UNAVAILABLE';
  recentClosedTrades: number;
  consecutiveNetLosses: number;
  latestClosedAt: Date | null;
  cooldownMinutes: number;
  cooldownRemainingSeconds: number;
}

export function evaluateM1PortfolioNetLossBrake(input: {
  evaluatedAt: Date;
  rows: readonly M1PortfolioClosedTradeCost[];
}): M1PortfolioNetLossBrakeDecision {
  const now = input.evaluatedAt.getTime();
  const rows = input.rows.slice(0, M1_PORTFOLIO_NET_LOSS_BRAKE_REQUIRED_LOSSES);
  const latestClosedAt = rows[0]?.closedAt ?? null;
  let consecutiveNetLosses = 0;
  let unverifiable = false;
  for (const row of rows) {
    const closed = row.closedAt.getTime();
    const currency = row.accountCurrency?.trim().toUpperCase();
    const sessionCurrency = row.sessionCurrency?.trim().toUpperCase();
    const hasNumbers = row.realisedPnl !== null && row.commission !== null && row.swap !== null;
    const pnl = Number(row.realisedPnl);
    const fee = Number(row.commission);
    const swap = Number(row.swap);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(closed) ||
      closed > now ||
      now - closed > M1_PORTFOLIO_NET_LOSS_BRAKE_LOOKBACK_HOURS * 3_600_000 ||
      !currency ||
      !sessionCurrency ||
      currency !== sessionCurrency ||
      !hasNumbers ||
      !Number.isFinite(pnl) ||
      !Number.isFinite(fee) ||
      !Number.isFinite(swap)
    ) {
      unverifiable = true;
      break;
    }
    if (pnl - Math.abs(fee) + swap >= 0) break;
    consecutiveNetLosses++;
  }
  const cooldownRemainingSeconds =
    latestClosedAt && Number.isFinite(now)
      ? Math.max(
          0,
          Math.ceil(
            (latestClosedAt.getTime() +
              M1_PORTFOLIO_NET_LOSS_BRAKE_COOLDOWN_MINUTES * 60_000 -
              now) /
              1000,
          ),
        )
      : 0;
  const lossStreakActive =
    consecutiveNetLosses >= M1_PORTFOLIO_NET_LOSS_BRAKE_REQUIRED_LOSSES &&
    cooldownRemainingSeconds > 0;
  return {
    artifact: M1_PORTFOLIO_NET_LOSS_BRAKE_ARTIFACT,
    active: unverifiable || lossStreakActive,
    reason: unverifiable
      ? 'COST_OR_CURRENCY_UNVERIFIED'
      : lossStreakActive
        ? 'RECENT_PORTFOLIO_NET_LOSS_STREAK'
        : 'CLEAR',
    recentClosedTrades: rows.length,
    consecutiveNetLosses,
    latestClosedAt,
    cooldownMinutes: M1_PORTFOLIO_NET_LOSS_BRAKE_COOLDOWN_MINUTES,
    cooldownRemainingSeconds,
  };
}
