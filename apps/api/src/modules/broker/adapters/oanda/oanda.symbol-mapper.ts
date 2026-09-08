/**
 * OANDA v20 symbol mapping (Directive §AH).
 *
 * Canonical iRexPro symbols are underscore-free ("EURUSD"); OANDA v20
 * instrument names use an underscore separator ("EUR_USD"). FX pairs and
 * metals split 3/3 (EUR/USD, XAU/USD); shorter/odd symbols pass through
 * unchanged rather than being guessed at.
 *
 * Suffix handling: some broker feeds append a suffix to instrument names
 * (e.g. "EURUSD.i" on certain MetaTrader servers). The suffix is carried
 * through the provider-form symbol and can be configured per provider via
 * the optional `suffix` parameter:
 *
 *   toProviderSymbol('EURUSD')            → 'EUR_USD'
 *   toProviderSymbol('EURUSD', '.i')      → 'EUR_USD.i'
 *   toProviderSymbol('EURUSD.i')          → 'EUR_USD.i'  (input's own suffix kept)
 *   toCanonicalSymbol('EUR_USD')          → 'EURUSD'
 *   toCanonicalSymbol('EUR_USD.i')        → 'EURUSD.i'
 *   toCanonicalSymbol('EUR_USD.i', '.i')  → 'EURUSD'     (configured suffix stripped)
 *
 * The OANDA adapter itself uses no suffix (OANDA instrument names are
 * suffix-free); the parameter exists so the same mapper serves future
 * per-provider configurations.
 */

const TRAILING_SUFFIX_PATTERN = /^(.*?)(\..+)$/;

function splitSuffix(symbol: string): { core: string; suffix: string } {
  const match = symbol.trim().match(TRAILING_SUFFIX_PATTERN);
  if (!match) return { core: symbol.trim(), suffix: '' };
  return { core: match[1], suffix: match[2] };
}

/**
 * Canonical (iRexPro) symbol → provider (OANDA v20) instrument name.
 * The explicit `suffix` parameter, when given, takes precedence over a
 * suffix already embedded in the canonical input.
 */
export function toProviderSymbol(canonical: string, suffix?: string): string {
  const trimmed = canonical.trim();
  if (trimmed === '') return trimmed;
  const { core, suffix: ownSuffix } = splitSuffix(trimmed);
  const normalizedCore = core.toUpperCase().replace(/_/g, '');
  const provider =
    normalizedCore.length >= 6
      ? `${normalizedCore.slice(0, 3)}_${normalizedCore.slice(3)}`
      : normalizedCore;
  const effectiveSuffix = suffix ?? ownSuffix;
  return effectiveSuffix.length > 0 ? `${provider}${effectiveSuffix}` : provider;
}

/**
 * Provider (OANDA v20) instrument name → canonical (iRexPro) symbol.
 * A configured `suffix` is stripped when the provider symbol carries it;
 * an unexpected suffix is preserved (round-trip safety — never silently
 * drops what the provider actually reported).
 */
export function toCanonicalSymbol(provider: string, suffix?: string): string {
  const trimmed = provider.trim();
  if (trimmed === '') return trimmed;
  const { core, suffix: ownSuffix } = splitSuffix(trimmed);
  const canonical = core.replace(/_/g, '').toUpperCase();
  if (suffix !== undefined && ownSuffix === suffix) return canonical;
  return ownSuffix.length > 0 ? `${canonical}${ownSuffix}` : canonical;
}
