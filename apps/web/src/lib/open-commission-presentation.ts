import type { LivePositionRowView } from "@irexpro/types/live-account";

type OpenCommissionFields = Pick<
  LivePositionRowView,
  "brokerName" | "environment" | "accountCurrency" | "commission" | "lotSize"
>;

/**
 * A broker-facing OPEN commission is the fee reported so far, not necessarily
 * the full lifecycle fee. This optional presentation hint is deliberately
 * Pepperstone USD DEMO only and is never used for P&L, margin, or trading.
 *
 * The owner's settled Pepperstone DEMO FX rows historically cost about USD 3
 * per standard lot per side. Show a hypothetical matching exit fee ONLY if
 * the actual opening charge is consistent with that observed one-sided rate.
 * An upfront round-trip charge of ~USD 6/lot, missing data, or another
 * broker/account MUST NOT be doubled.
 */
export function estimatePepperstoneDemoRoundTripCommission(
  position: OpenCommissionFields,
): {
  estimatedClosingCommission: string;
  estimatedTotalCommission: string;
} | null {
  const name = (position.brokerName ?? "").trim().toLowerCase();
  if (!name.includes("pepperstone") ||
      position.environment !== "DEMO" ||
      position.accountCurrency !== "USD") return null;

  if (position.commission == null || position.commission.trim() === "")
    return null;
  const booked = Number(position.commission);
  const lots = Number(position.lotSize);
  if (!Number.isFinite(booked) || !Number.isFinite(lots) ||
      lots <= 0 || booked >= 0) return null;
  const perLot = Math.abs(booked) / lots;
  // A narrow observed-price check: never assume all brokers charge half up
  // front, never "estimate" a second leg for already round-trip booked fees.
  if (perLot < 2.75 || perLot > 3.25) return null;
  return {
    estimatedClosingCommission: (-Math.abs(booked)).toFixed(2),
    estimatedTotalCommission: (-2 * Math.abs(booked)).toFixed(2),
  };
}
