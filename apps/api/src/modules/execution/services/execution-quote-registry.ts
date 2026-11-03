import type { BrokerPrice } from '../../broker/interfaces/broker-adapter.interface';

/**
 * Short-lived in-process handoff for the exact quote proven by the final
 * market-safety gate. The quote is telemetry-only and never participates in
 * risk, admission, sizing, SL/TP, exit authority, or provider dispatch.
 *
 * The lifecycle is intentionally bounded. A provider rejection/terminal trade
 * transition clears the entry when possible; the TTL is the final leak guard
 * for failures/crashes between the gate and the Trade CAS transition.
 */
const QUOTE_HANDOFF_TTL_MS = 5 * 60_000;

type QuoteHandoff = {
  quote: BrokerPrice;
  expiresAt: number;
};

const quoteByTradeId = new Map<string, QuoteHandoff>();

function purgeExpired(now = Date.now()): void {
  for (const [tradeId, handoff] of quoteByTradeId.entries()) {
    if (handoff.expiresAt <= now) quoteByTradeId.delete(tradeId);
  }
}

export function rememberProvenExecutionQuote(
  tradeId: string | null | undefined,
  quote: BrokerPrice,
): void {
  if (!tradeId) return;
  const now = Date.now();
  purgeExpired(now);
  quoteByTradeId.set(tradeId, {
    quote: { ...quote },
    expiresAt: now + QUOTE_HANDOFF_TTL_MS,
  });
}

export function peekProvenExecutionQuote(tradeId: string): BrokerPrice | null {
  const now = Date.now();
  purgeExpired(now);
  const handoff = quoteByTradeId.get(tradeId);
  return handoff && handoff.expiresAt > now ? { ...handoff.quote } : null;
}

export function discardProvenExecutionQuote(tradeId: string): void {
  quoteByTradeId.delete(tradeId);
}

/** Test-only reset seam; production code should never need global clearing. */
export function clearProvenExecutionQuoteRegistryForTests(): void {
  quoteByTradeId.clear();
}
