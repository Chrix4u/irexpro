/**
 * Strip binary floating-point arithmetic residue near a five-decimal
 * cTrader protocol price. This is not tick rounding: genuinely fractional
 * points remain unchanged and still require normal risk/broker validation.
 * Apply before signal persistence, sizing and the immutable risk grant.
 */
export function canonicalSignalPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return value;
  const canonical = Number(value.toFixed(5));
  const tolerance = Number.EPSILON * Math.max(Math.abs(value), Math.abs(canonical)) * 2;
  return canonical > 0 && Math.abs(value - canonical) <= tolerance ? canonical : value;
}
