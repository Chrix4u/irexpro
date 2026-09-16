/**
 * Identity-scoped production-LIVE verification policy (Sprint 56 correction
 * round 4, architect finding 10).
 *
 * THE PROBLEM THIS MODULE CLOSES: the generic `brokerId = 'ctrader'` entry
 * is broker-agnostic — acceptable for BETA/demo discovery, but a future
 * `ctrader.productionLiveVerification = VERIFIED` must NOT become blanket
 * evidence that EVERY broker using cTrader infrastructure (Pepperstone, IC
 * Markets, an unknown broker) is production-LIVE verified. One broker's LIVE
 * verification must NEVER authorize another.
 *
 * THE MODEL: verification evidence is scoped by AT LEAST
 *   (canonical adapter/provider technology, actual provider/broker identity,
 *    environment, verification evidence reference, verified timestamp).
 *
 * LIVE eligibility for a CONNECTION additionally requires the connection's
 * SERVER-DERIVED provider identity (providerBrokerIdentity — persisted from
 * cTrader 2149 discovery, finding 9) to EXACTLY match VERIFIED evidence for
 * the same technology + environment:
 *   - branded aliases ('pepperstone-ctrader') only gain LIVE eligibility
 *     from matching identity evidence (their catalog family's identity);
 *   - a generic cTrader connection carrying identity X only gains LIVE
 *     eligibility from evidence for X — never from another broker's
 *     evidence, never from technology-level evidence alone;
 *   - an UNKNOWN identity (null — no discovery evidence) is LIVE
 *     FAIL-CLOSED for every alias;
 *   - technology-level (identity-less) evidence authorizes NOTHING by
 *     itself (it can never blanket-authorize the cTrader ecosystem).
 *
 * CURRENT STATE (unchanged by this round): 'ctrader',
 * 'pepperstone-ctrader', and 'icmarkets-ctrader' all remain
 * productionLiveVerification = UNVERIFIED — no VERIFIED evidence exists, so
 * every cTrader-family LIVE gate fails closed exactly as before. The model
 * exists so that the FUTURE flip of any entry can never leak authorization
 * across identities.
 *
 * NON-cTrader providers: one broker per technology (MT5, OANDA, paper) — the
 * catalog-level verification IS the identity-scoped evidence (no equivalent
 * multi-broker sharing exists; nothing is fabricated).
 */
import { providerIdentityFamilyForAlias } from '../adapters/ctrader/ctrader-broker-identity';

/** Versioned identity-scoped LIVE verification model. */
export const LIVE_VERIFICATION_MODEL_VERSION = 1;

/** Canonical adapter/provider technology keys. */
export const PROVIDER_TECHNOLOGY = {
  CTRADER: 'ctrader',
} as const;

/** Environment keys (mirrors BrokerMode without importing the adapter enum). */
export type LiveVerificationEnvironment = 'DEMO' | 'LIVE';

/** One unit of operator-maintained production-LIVE verification evidence. */
export interface ProviderLiveVerificationEvidence {
  /** Canonical adapter/provider technology (e.g. 'ctrader'). */
  readonly providerTechnology: string;
  /**
   * The provider/broker identity this evidence authorizes (normalized —
   * e.g. 'pepperstone'), or null for TECHNOLOGY-LEVEL evidence (which
   * authorizes NO connection by itself — it can never blanket-authorize the
   * shared technology).
   */
  readonly providerIdentity: string | null;
  readonly environment: LiveVerificationEnvironment;
  readonly status: 'UNVERIFIED' | 'VERIFIED';
  readonly verifiedAt: string | null;
  readonly evidenceRef: string | null;
  /**
   * Round 7.1 (P0-3): provenance discriminator — LEGACY_ATTESTATION
   * (historical operator attestation) vs HARNESS_CERTIFIED (documented
   * certification protocol with a durable artifact). Optional so existing
   * UNVERIFIED evidence units stay valid; a future VERIFIED unit records
   * which path produced it (rendered distinctly, never conflated).
   */
  readonly certifiedVia?: 'LEGACY_ATTESTATION' | 'HARNESS_CERTIFIED';
  /** Harness run reference for HARNESS_CERTIFIED evidence (null otherwise). */
  readonly certificationRunRef?: string | null;
}

/** Query: does THIS connection satisfy identity-scoped LIVE verification? */
export interface IdentityScopedLiveVerificationQuery {
  /** Requested broker id (alias) the connection is being created under. */
  readonly brokerId: string;
  /** Canonical adapter/provider technology of the connection. */
  readonly providerTechnology: string;
  /**
   * The connection's SERVER-DERIVED provider identity (normalized), or null
   * when discovery supplied none (unknown — fail-closed).
   */
  readonly connectionProviderIdentity: string | null;
  readonly environment: LiveVerificationEnvironment;
  /** The operator-maintained evidence set to evaluate against. */
  readonly evidence: readonly ProviderLiveVerificationEvidence[];
}

/**
 * Resolves a connection's identity-scoped LIVE verification status.
 * VERIFIED requires: VERIFIED evidence matching the technology AND the
 * environment AND the connection's EXACT identity (non-null). Everything
 * else — missing evidence, mismatched identity, unknown identity,
 * technology-level-only evidence — is UNVERIFIED (fail-closed).
 */
export function connectionLiveVerificationStatus(
  query: IdentityScopedLiveVerificationQuery,
): 'VERIFIED' | 'UNVERIFIED' {
  const candidates = query.evidence.filter(
    (e) =>
      e.providerTechnology === query.providerTechnology &&
      e.environment === query.environment &&
      e.status === 'VERIFIED',
  );
  if (candidates.length === 0) return 'UNVERIFIED';
  // Unknown identity NEVER inherits any verified alias (fail-closed).
  if (query.connectionProviderIdentity === null) return 'UNVERIFIED';
  // EXACT identity match — one broker's verification never authorizes
  // another, and technology-level (identity-less) evidence never applies.
  return candidates.some((e) => e.providerIdentity === query.connectionProviderIdentity)
    ? 'VERIFIED'
    : 'UNVERIFIED';
}

/**
 * Catalog-entry shape needed to derive identity-scoped evidence (a subset of
 * BrokerRegistryEntry — kept structural for testability).
 */
export interface CatalogVerificationSource {
  readonly id: string;
  readonly productionLiveVerification: {
    readonly status: 'UNVERIFIED' | 'VERIFIED';
    readonly verifiedAt: string | null;
    readonly evidenceRef: string | null;
  };
}

/**
 * Derives the identity-scoped evidence units contributed by ONE catalog
 * entry (the operator's current evidence carrier):
 * - a BRANDED cTrader-family alias ('pepperstone-ctrader') contributes
 *   evidence scoped to its catalog identity family ('pepperstone') in BOTH
 *   environments (the registry materializes the same status for both);
 * - the GENERIC 'ctrader' entry contributes TECHNOLOGY-LEVEL evidence
 *   (identity: null) — which authorizes NOTHING by itself: a generic
 *   connection still needs identity-matching evidence;
 * - non-cTrader-family entries are single-broker-per-technology: their
 *   catalog verification IS their identity-scoped evidence (technology
 *   equals brokerId; identity null is NOT used for them — the gate for
 *   non-shared technologies relies on the catalog level directly).
 */
export function catalogEntryToEvidence(
  entry: CatalogVerificationSource,
  environments: readonly LiveVerificationEnvironment[] = ['DEMO', 'LIVE'],
): ProviderLiveVerificationEvidence[] {
  const status = entry.productionLiveVerification.status;
  const verifiedAt = entry.productionLiveVerification.verifiedAt;
  const evidenceRef = entry.productionLiveVerification.evidenceRef;
  return environments.map((environment) => ({
    providerTechnology: entry.id,
    providerIdentity: catalogEntryIdentity(entry.id),
    environment,
    status,
    verifiedAt,
    evidenceRef,
  }));
}

/**
 * The identity a catalog entry's verification evidence is scoped to:
 * - branded cTrader alias → its family's canonical normalized identity
 *   (derived from the reviewed catalog, e.g. 'pepperstone');
 * - generic 'ctrader' → null (technology-level — never blanket);
 * - non-cTrader ids → null (single-broker technologies: the technology IS
 *   the broker; the catalog-level gate applies directly).
 */
export function catalogEntryIdentity(brokerId: string): string | null {
  if (brokerId === 'ctrader') return null; // technology-level — never blanket
  const family = providerIdentityFamilyForAlias(brokerId);
  if (family) {
    // The family's canonical identity: its primary reviewed normalized title.
    return family.acceptableNormalizedTitles[0] ?? null;
  }
  return null;
}
