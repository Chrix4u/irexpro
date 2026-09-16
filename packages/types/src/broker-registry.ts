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
 * operator-attested evidence that gates LIVE execution (fail-closed
 * otherwise). `evidenceRef` is a doc/ticket reference — never secrets.
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
 * Round 7.1 (P0-3): the truthful, derived certification state for UI
 * display — distinguishes legacy verification from current protocol
 * certification. CERTIFICATION_PENDING / EVIDENCE_PERSISTENCE_FAILED are
 * run-level outcomes (harness evidence), NOT catalog states.
 */
export type ProviderCertificationState = 'NOT_CERTIFIED' | 'LEGACY_VERIFIED' | 'CERTIFIED';

/** Derive the display state (mirror of the API-side derivation). */
export function deriveProviderCertificationState(
  verification: BrokerProductionLiveVerification | undefined | null,
): ProviderCertificationState {
  if (!verification || verification.status !== 'VERIFIED') {
    return 'NOT_CERTIFIED';
  }
  return verification.certifiedVia === 'HARNESS_CERTIFIED' ? 'CERTIFIED' : 'LEGACY_VERIFIED';
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
