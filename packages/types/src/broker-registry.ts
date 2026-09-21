/**
 * @irexpro/types — broker registry contract (Sprint 50).
 *
 * Server-authoritative broker catalog types shared by web, admin and mobile
 * (Directive §AU: one registry, no client-side broker lists). Matches
 * GET /api/v1/broker/registry.
 *
 * STATUS HONESTY (Directive §AB): a broker is only ever 'SUPPORTED' when the
 * backend has a live registered adapter for it. 'NOT_STARTED' entries are
 * research placeholders and must never be presented as connectable.
 *
 * PRODUCTION-LIVE VERIFICATION (architect Phase H): BETA ≠ production-LIVE.
 * `status` (implementation evidence) and `adapterAvailable` say nothing
 * about production-LIVE approval — `productionLiveVerification` records the
 * operator-attested LIVE evidence. Absent/UNVERIFIED means LIVE execution
 * fails closed server-side (BETA providers are DEMO-only).
 */

/** Normalized provider capabilities (Directive §M). */
export type BrokerCapability =
  | 'ACCOUNT_READ'
  | 'BALANCE_READ'
  | 'POSITION_READ'
  | 'ORDER_READ'
  | 'HISTORY_READ'
  | 'MARKET_DATA'
  | 'MARKET_DATA_STREAMING'
  | 'OAUTH'
  | 'API_TOKEN'
  | 'SESSION_AUTH'
  | 'DEMO'
  | 'LIVE'
  | 'REST'
  | 'WEBSOCKET'
  | 'METATRADER'
  | 'CTRADER'
  | 'FIX'
  | 'SDK'
  | 'WEBHOOKS'
  | 'EVENT_STREAM'
  | 'ORDER_PLACEMENT'
  | 'ORDER_MODIFICATION'
  | 'CLOSE_ALL'
  | 'MARGIN_CALCULATION';

/** Connectivity routes a single broker may expose (Directive §AF). */
export type BrokerConnectionRoute =
  | 'NATIVE_API'
  | 'CTRADER'
  | 'METATRADER'
  | 'FIX'
  | 'SDK'
  | 'PAPER';

/** Evidence-based implementation status (Directive §AQ). */
export type BrokerAvailabilityStatus =
  | 'SUPPORTED'
  | 'BETA'
  | 'NOT_STARTED'
  | 'PARTNER_APPROVAL_REQUIRED'
  | 'UNAVAILABLE';

export type BrokerAuthenticationType = 'API_TOKEN' | 'OAUTH' | 'SESSION_AUTH';

/**
 * Production-LIVE verification evidence (architect Phase H).
 *
 * BETA ≠ production-LIVE: a BETA status only means the adapter is
 * implemented + contract-tested. VERIFIED here is the separate
 * operator-attested evidence record; the runtime additionally requires a
 * complete current HARNESS_CERTIFIED record before production LIVE is
 * authorized. `evidenceRef` is a doc/ticket reference — never secrets.
 */
export interface BrokerProductionLiveVerification {
  status: 'UNVERIFIED' | 'VERIFIED';
  /** ISO timestamp of the operator-attested verification (null when unverified/unknown). */
  verifiedAt: string | null;
  /** Short evidence reference (doc/ticket id — never secrets; null when unverified). */
  evidenceRef: string | null;
  /**
   * Round 7.1 (P0-3): provenance — LEGACY_ATTESTATION (historical operator
   * attestation, no dated artifact) vs HARNESS_CERTIFIED (documented
   * certification protocol with a durable evidence artifact). Null when
   * UNVERIFIED or on older payloads.
   */
  certifiedVia?: 'LEGACY_ATTESTATION' | 'HARNESS_CERTIFIED' | null;
  /** Harness run reference (`runId@sha256:<hash>`) for HARNESS_CERTIFIED entries. */
  certificationRunRef?: string | null;
}

/**
 * Round 7.1 (P0-3): the truthful, derived certification state for UI and
 * runtime interpretation. CERTIFICATION_PENDING /
 * EVIDENCE_PERSISTENCE_FAILED are run-level outcomes (harness evidence), NOT
 * catalog states.
 */
export type ProviderCertificationState = 'NOT_CERTIFIED' | 'LEGACY_VERIFIED' | 'CERTIFIED';

/**
 * Live-readiness blocker codes (production-LIVE completion round).
 *
 * WHY: a user must never discover a LIVE action is impossible only by
 * clicking it. These are the server-authoritative, user-relevant reasons a
 * provider is not production-LIVE ready, in resolution order (the first
 * blocker is the one to resolve first). REGION_UNAVAILABLE is deliberately
 * NOT in this list — it is user-scoped (the user's country vs the provider's
 * `liveUnavailableRegions`) and is enforced at the LIVE gates with the
 * user's profile in hand.
 */
export type LiveReadinessBlockedReason =
  | 'LIVE_UNSUPPORTED'
  | 'ADAPTER_UNAVAILABLE'
  | 'PARTNER_APPROVAL_REQUIRED'
  | 'CERTIFICATION_REQUIRED';

/**
 * Server-computed live-readiness summary (production-LIVE completion round).
 *
 * `eligible` mirrors the runtime gate (registered adapter AND derived
 * certificationState === 'CERTIFIED'). `blockedReasons` explains WHY LIVE is
 * unavailable while it is unavailable — never a bare false.
 */
export interface BrokerLiveReadiness {
  /** True only when the runtime production-LIVE gate would pass for this provider. */
  eligible: boolean;
  /** Ordered, user-relevant blockers (empty when eligible). */
  blockedReasons: LiveReadinessBlockedReason[];
  /** True when provider/partner approval is required before any real account can be reached. */
  partnerApprovalRequired: boolean;
  /** ISO-3166 alpha-2 codes where the provider's LIVE offering is known unavailable. */
  liveUnavailableRegions: string[];
}

/**
 * Derive the display/runtime state (mirror of the API-side derivation).
 * A HARNESS_CERTIFIED label by itself is insufficient: CERTIFIED requires a
 * parseable verification timestamp, non-empty evidence reference, and a
 * valid UUIDv4 + SHA-256 run reference.
 */
export function deriveProviderCertificationState(
  verification: BrokerProductionLiveVerification | undefined | null,
): ProviderCertificationState {
  if (!verification || verification.status !== 'VERIFIED') {
    return 'NOT_CERTIFIED';
  }
  if (verification.certifiedVia !== 'HARNESS_CERTIFIED') {
    return 'LEGACY_VERIFIED';
  }

  const verifiedAt = verification.verifiedAt?.trim() ?? '';
  const evidenceRef = verification.evidenceRef?.trim() ?? '';
  const certificationRunRef = verification.certificationRunRef?.trim() ?? '';
  const runRefPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@sha256:[0-9a-f]{64}$/i;

  if (
    !verifiedAt ||
    Number.isNaN(Date.parse(verifiedAt)) ||
    !evidenceRef ||
    !runRefPattern.test(certificationRunRef)
  ) {
    return 'NOT_CERTIFIED';
  }

  return 'CERTIFIED';
}

export interface BrokerRegistryEntry {
  id: string;
  name: string;
  description: string;
  status: BrokerAvailabilityStatus;
  /**
   * Production-LIVE verification evidence — BETA ≠ production-LIVE.
   * Present in current API payloads; optional so older cached payloads
   * remain valid for consumers.
   */
  productionLiveVerification?: BrokerProductionLiveVerification;
  /**
   * Round 7.1 (P0-3): always-materialized derived certification state
   * (present in current API payloads; absent on older cached payloads —
   * derive it client-side via deriveProviderCertificationState when missing).
   */
  certificationState?: ProviderCertificationState;
  /**
   * Production-LIVE completion round: always-materialized live-readiness
   * summary (present in current API payloads; absent on older cached
   * payloads — treat absent as fail-closed: not eligible, reason unknown).
   */
  liveReadiness?: BrokerLiveReadiness;
  connectionRoutes: BrokerConnectionRoute[];
  capabilities: BrokerCapability[];
  authenticationType: BrokerAuthenticationType;
  environments: ('DEMO' | 'LIVE')[];
  regions: string[];
  /** True when a live adapter is registered for this entry right now. */
  adapterAvailable: boolean;
}

export interface BrokerRegistryCatalog {
  catalogVersion: string;
  brokers: BrokerRegistryEntry[];
}
