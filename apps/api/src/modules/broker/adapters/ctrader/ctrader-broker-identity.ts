/**
 * cTrader broker-identity policy (Sprint 56 correction round 3, architect
 * finding 6; Sprint 56 correction round 4, architect finding 8 — versioned
 * CANONICAL provider-identity model).
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
 * CANONICAL MODEL (correction round 4, finding 8): round 3 used UNRESTRICTED
 * SUBSTRING matching (`normalized.includes(expectedToken)`), which is too
 * permissive for a production-LIVE verification boundary — an unrelated
 * title containing the expected token must never count as verified identity.
 * The model is now a VERSIONED, EXPLICITLY-REVIEWED catalog:
 *
 *   'pepperstone-ctrader' → provider identity family PEPPERSTONE
 *     → acceptable normalized provider titles: ['pepperstone']
 *   'icmarkets-ctrader'   → provider identity family IC_MARKETS
 *     → acceptable normalized provider titles: ['icmarkets']
 *   'ctrader'             → generic (no brand constraint — BETA/demo discovery)
 *
 * NO identities are invented: every cataloged title variant is backed by
 * actual provider-discovery evidence in this repository (the 2149 account
 * discovery fixtures). Additional variants (e.g. regional suffix forms) may
 * only be added through an explicit model-version bump with reviewed
 * discovery evidence — unknown/unlisted identities FAIL CLOSED for branded
 * aliases.
 *
 * UNCATALOGED aliases (a future 'brand-ctrader' id not yet in the catalog):
 * the round-3 derivation still applies — the expected token is derived from
 * the alias id itself — but matching is now EXACT EQUALITY of the normalized
 * title (never a substring), preserving the "no fabricated provider
 * mappings" property while closing the containment loophole.
 */
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import type { CtraderDiscoveredAccount } from './ctrader-message-types';

/** Suffix that marks a cTrader catalog alias id. */
const CTRADER_ALIAS_SUFFIX = '-ctrader';

/** Versioned canonical provider-identity model (bump on every catalog change). */
export const PROVIDER_IDENTITY_MODEL_VERSION = 1;

/** A reviewed provider identity family with its acceptable normalized titles. */
export interface ProviderIdentityFamily {
  /** Canonical family key (e.g. 'PEPPERSTONE', 'IC_MARKETS'). */
  readonly family: string;
  /** Explicitly reviewed acceptable NORMALIZED provider titles. */
  readonly acceptableNormalizedTitles: readonly string[];
}

/**
 * The canonical provider-identity catalog — reviewed, versioned, and evidence
 * -backed ONLY. Every entry documents the identity family a branded alias
 * resolves to and the exact set of acceptable normalized discovery titles.
 */
const PROVIDER_IDENTITY_CATALOG: Readonly<Record<string, ProviderIdentityFamily>> = {
  'pepperstone-ctrader': {
    family: 'PEPPERSTONE',
    acceptableNormalizedTitles: ['pepperstone'],
  },
  'icmarkets-ctrader': {
    family: 'IC_MARKETS',
    acceptableNormalizedTitles: ['icmarkets'],
  },
};

/** The cataloged identity family for a requested alias id (null when uncataloged). */
export function providerIdentityFamilyForAlias(
  requestedBrokerId: string,
): ProviderIdentityFamily | null {
  return PROVIDER_IDENTITY_CATALOG[requestedBrokerId] ?? null;
}

/**
 * Normalizes a discovered brokerTitleShort for matching/persistence: lowercase,
 * only alphanumeric characters remain ("IC Markets" → "icmarkets",
 * "Pepperstone (UK)" → "pepperstoneuk"). The normalized form is also the
 * SANITIZED value persisted as server-derived connection identity metadata
 * (finding 9) — it carries no credential material.
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
 * broker id (correction round 4, finding 8 — EXACT canonical matching):
 * - generic 'ctrader' → agnostic (true);
 * - CATALOGED branded alias → the NORMALIZED discovered title must EQUAL one
 *   of the reviewed acceptable titles (never a substring; unknown/unlisted
 *   identities fail closed);
 * - UNCATALOGED alias → the normalized title must EXACTLY EQUAL the derived
 *   alias token (round-3 derivation, containment removed).
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
  // Degenerate bare-suffix id ('-ctrader', empty distinguishing token) never
  // verifies ANY identity (round-3 fail-closed edge, preserved).
  if (
    requestedBrokerId.endsWith(CTRADER_ALIAS_SUFFIX) &&
    requestedBrokerId.length === CTRADER_ALIAS_SUFFIX.length
  ) {
    return false;
  }

  const family = providerIdentityFamilyForAlias(requestedBrokerId);
  if (family) {
    // EXACT membership in the reviewed catalog — a title merely CONTAINING
    // the expected token is NOT a verified identity.
    return family.acceptableNormalizedTitles.includes(normalized);
  }
  // Uncataloged alias: exact equality against the derived token.
  return normalized === normalizeBrokerTitleShort(expectedToken);
}

/**
 * The SANITIZED normalized server-derived provider identity for persistence
 * (correction round 4, finding 9): the normalized discovered title (the
 * canonical identity a connection actually carries — e.g. 'pepperstone',
 * 'icmarkets', or any discovered brand under the generic id), or null when
 * discovery supplied no title (unknown identity — never fabricated).
 *
 * This value is SERVER-DERIVED (2149 discovery) — clients can never submit
 * or overwrite it — and carries no credential material.
 */
export function normalizeProviderBrokerIdentity(
  brokerTitleShort: string | null | undefined,
): string | null {
  if (!brokerTitleShort || brokerTitleShort.trim() === '') return null;
  const normalized = normalizeBrokerTitleShort(brokerTitleShort);
  return normalized === '' ? null : normalized;
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
