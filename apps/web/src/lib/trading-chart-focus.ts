/**
 * DEMO chart focus follows the M1 execution universe, NOT the legacy
 * automation runtime's broader six-pair research universe. When the
 * authenticated M1 status cannot be read, show the operator-approved
 * EURUSD/AUDUSD focus rather than resurrecting paused chart tabs.
 * This is presentation only: it cannot authorize or prohibit an order.
 */
export const DEFAULT_DEMO_CHART_INSTRUMENTS = Object.freeze(["EURUSD", "AUDUSD"] as const);

const SUPPORTED_FX_PAIRS = new Set([
  "EURUSD", "AUDUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF",
]);

export function resolveDemoChartInstruments(
  status: {
    authorityMode?: string;
    demoEntryInstruments?: readonly string[];
  } | null | undefined,
): string[] {
  if (
    status?.authorityMode !== "DEMO_FULL_AUTO" ||
    !Array.isArray(status.demoEntryInstruments)
  ) {
    return [...DEFAULT_DEMO_CHART_INSTRUMENTS];
  }
  const active = [...new Set(status.demoEntryInstruments.filter(
    (symbol) => typeof symbol === "string" && SUPPORTED_FX_PAIRS.has(symbol),
  ))];
  // Empty/malformed server data must never fall back to the old six-pair list.
  return active.length ? active : [...DEFAULT_DEMO_CHART_INSTRUMENTS];
}
