/**
 * cTrader broker-identity policy (Sprint 56 correction round 3, architect
 * finding 6 — centralized alias identity validation).
 *
 * Account discovery (ProtoOAGetAccountListByAccessTokenRes, payload 2149)
 * supplies `brokerTitleShort` — the actual broker brand behind a cTrader
 * account (e.g. "Pepperstone", "IC Markets"). Broker-specific catalog aliases
 * ('pepperstone-ctrader', 'icmarkets-ctrader') MUST verify that the
 * discovered identity matches the selected alias and fail closed on mismatch
 * — a user must not be able to link, e.g., an IC-Markets-discovered account
 * under the Pepperstone alias (and vice versa). The generic 'ctrader' id
 * stays broker-agnostic by design.
 *
 * MATCHING POLICY (deliberately NOT a fabricated provider-title table):
 * The expected identity token is DERIVED from the requested alias id itself
 * (the distinguishing segment before the '-ctrader' suffix). Normalization
 * strips case/punctuation/whitespace from the discovered title, so
 * "Pepperstone", "PEPPERSTONE  " and "IC Markets" match 'pepperstone' and
 * 'icmarkets' respectively. A missing/empty discovered title under a
 * broker-specific alias is treated as an identity mismatch (fail-closed) —
 * absence of evidence is not evidence of a match.
 */
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import type { CtraderDiscoveredAccount } from './ctrader-message-types';

/** Suffix that marks a cTrader catalog alias id. */
const CTRADER_ALIAS_SUFFIX = '-ctrader';

/**
 * Normalizes a discovered brokerTitleShort for matching: lowercase, only
 * alphanumeric characters remain ("IC Markets" → "icmarkets",
 * "Pepperstone (UK)" → "pepperstoneuk").
 */
export function normalizeBrokerTitleShort(title: string): string {
  return title.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * The distinguishing identity token a requested broker id must be verified
 * against, or null when the request is broker-agnostic:
 *   'pepperstone-ctrader' → 'pepperstone'
 *   'icmarkets-ctrader'   → 'icmarkets'
 *   'ctrader'             → null (generic engine id — no brand constraint)
 *   unknown ids           → the id itself (fail-closed: never agnostic)
 */
export function expectedBrokerIdentityToken(requestedBrokerId: string): string | null {
  if (requestedBrokerId === 'ctrader') return null;
  if (requestedBrokerId.endsWith(CTRADER_ALIAS_SUFFIX)) {
    const token = requestedBrokerId.slice(0, -CTRADER_ALIAS_SUFFIX.length);
    return token.length > 0 ? token : requestedBrokerId;
  }
  return requestedBrokerId;
}

/**
 * Verifies a discovered account's broker identity against the requested
 * broker id. Returns true when the request is agnostic; for broker-specific
 * aliases the NORMALIZED discovered title must contain the expected token.
 * Missing/empty titles never match a broker-specific alias (fail-closed).
 */
export function brokerIdentityMatches(
  requestedBrokerId: string,
  brokerTitleShort: string | null | undefined,
): boolean {
  const expectedToken = expectedBrokerIdentityToken(requestedBrokerId);
  if (expectedToken === null) return true; // generic cTrader id — agnostic
  if (!brokerTitleShort || brokerTitleShort.trim() === '') return false;
  const normalized = normalizeBrokerTitleShort(brokerTitleShort);
  if (normalized === '') return false;
  return normalized.includes(expectedToken);
}

/**
 * Fail-closed assertion used on the adapter connect path: a discovered
 * account whose brand does not match the requested alias rejects the
 * connection as AUTHENTICATION_FAILED (the credentials are valid for cTrader
 * infrastructure, but not for the requested broker identity — the account
 * belongs to a different brand).
 */
export function assertDiscoveredBrokerIdentity(
  requestedBrokerId: string,
  account: Pick<CtraderDiscoveredAccount, 'brokerTitleShort' | 'ctidTraderAccountId'>,
): void {
  if (brokerIdentityMatches(requestedBrokerId, account.brokerTitleShort)) return;
  throw new BrokerAdapterError(
    BrokerErrorCode.AUTHENTICATION_FAILED,
    `The cTrader account ${account.ctidTraderAccountId} belongs to broker ` +
      `"${account.brokerTitleShort ?? 'unknown'}" — it cannot be connected as ` +
      `"${requestedBrokerId}". Select the matching broker entry.`,
  );
}
