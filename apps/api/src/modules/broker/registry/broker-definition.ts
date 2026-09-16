import { BrokerCapability } from './broker-capability.enum';

/**
 * BrokerDefinition — server-authoritative broker catalog entry
 * (Directive §N: central broker registry).
 *
 * HONESTY RULE (Directive §AB / §AQ):
 * A broker must never appear as fully SUPPORTED unless the integration
 * actually exists. `BrokerProviderRegistryService` overlays the static
 * catalog with live adapter availability at runtime: entries whose
 * `adapterId` has no registered adapter can never be reported as SUPPORTED.
 */

/** Connectivity route for a broker that supports multiple integration paths (Directive §AF). */
export enum BrokerConnectionRoute {
  NATIVE_API = 'NATIVE_API',
  CTRADER = 'CTRADER',
  METATRADER = 'METATRADER',
  FIX = 'FIX',
  SDK = 'SDK',
  PAPER = 'PAPER',
}

/** Implementation status of a catalog entry — evidence-based only (Directive §AQ). */
export enum BrokerAvailabilityStatus {
  /** Adapter fully implemented + tested; capabilities verified. */
  SUPPORTED = 'SUPPORTED',
  /** Adapter implemented; limited capability coverage or pending hardening. */
  BETA = 'BETA',
  /** Catalog entry exists; adapter NOT implemented (fail closed at runtime). */
  NOT_STARTED = 'NOT_STARTED',
  /** Integration planned; requires operator/partner approval before build. */
  PARTNER_APPROVAL_REQUIRED = 'PARTNER_APPROVAL_REQUIRED',
  /** Regionally restricted or currently unavailable. */
  UNAVAILABLE = 'UNAVAILABLE',
}

/**
 * Production-LIVE verification evidence (architect Phase H).
 *
 * SEPARATE from implementation status: `status: BETA` means the adapter is
 * implemented + contract-tested; it does NOT mean production-LIVE execution
 * was ever verified. Absent / UNVERIFIED ⇒ LIVE execution fails closed
 * (BETA providers are DEMO-only until operator-attested evidence exists).
 */
export interface BrokerProductionLiveVerification {
  status: 'UNVERIFIED' | 'VERIFIED';
  /** When verification happened (operator-attested evidence, e.g. practice-account validation records). */
  verifiedAt?: string | null;
  /** Short evidence reference (doc/ticket id — never secrets). */
  evidenceRef?: string | null;
  /**
   * Round 7.1 (P0-3): HOW the VERIFIED state came to be — the provenance
   * discriminator that separates historical operator attestation from the
   * documented production-LIVE certification protocol.
   *
   * - LEGACY_ATTESTATION: verified before the certification protocol
   *   existed (Round 7). Honest record — no dated artifact, no harness run
   *   reference. Rendered as LEGACY_VERIFIED; NEVER presented as a fresh
   *   protocol certification.
   * - HARNESS_CERTIFIED: verified through the documented operator-only
   *   LIVE certification harness with a durable, read-back-verified
   *   evidence artifact (certificationRunRef records it).
   *
   * Absent on UNVERIFIED entries.
   */
  certifiedVia?: 'LEGACY_ATTESTATION' | 'HARNESS_CERTIFIED';
  /**
   * Round 7.1 (P0-3): the certification-run reference for
   * HARNESS_CERTIFIED entries — `<runId>@sha256:<evidenceSha256>` from the
   * durable evidence artifact. Null for legacy attestations (none exists —
   * recorded truthfully, never fabricated).
   */
  certificationRunRef?: string | null;
}

/**
 * Round 7.1 (P0-3): the TRUTHFUL, derived certification state for
 * UI/API display — distinguishes historical/legacy verification from
 * current production certification.
 *
 * - NOT_CERTIFIED: no production-LIVE evidence at all (UNVERIFIED).
 * - LEGACY_VERIFIED: VERIFIED via legacy operator attestation — real
 *   historical evidence, but NOT a Round-7-protocol certification run
 *   (verifiedAt may legitimately be null; no dated artifact exists).
 * - CERTIFIED: VERIFIED via the documented certification protocol
 *   (HARNESS_CERTIFIED with a durable evidence artifact + runRef).
 *
 * CERTIFICATION_PENDING and EVIDENCE_PERSISTENCE_FAILED are deliberately
 * NOT catalog states — they are RUN-level outcomes carried by
 * LiveCertificationEvidence.certificationResult (the catalog records only
 * completed certifications; a pending or persistence-failed run flips
 * nothing).
 */
export type ProviderCertificationState =
  | 'NOT_CERTIFIED'
  | 'LEGACY_VERIFIED'
  | 'CERTIFIED';

/** Derive the truthful display state from catalog verification evidence. */
export function deriveProviderCertificationState(
  verification: BrokerProductionLiveVerification | undefined,
): ProviderCertificationState {
  if (!verification || verification.status !== 'VERIFIED') {
    return 'NOT_CERTIFIED';
  }
  return verification.certifiedVia === 'HARNESS_CERTIFIED' ? 'CERTIFIED' : 'LEGACY_VERIFIED';
}

export interface BrokerDefinition {
  /** Catalog id (stable, e.g. "metatrader5"). */
  id: string;
  /** Display name. */
  name: string;
  /** Short description for the broker-onboarding UI. */
  description: string;
  /** Adapter id registered in BrokerAdapterRegistry; null = no adapter yet. */
  adapterId: string | null;
  /** Implementation status — MUST reflect actual evidence. */
  status: BrokerAvailabilityStatus;
  /**
   * Production-LIVE verification evidence — absent/UNVERIFIED means LIVE
   * execution is fail-closed (BrokerProviderRegistryService.
   * isProductionLiveEligible returns false; BETA is DEMO-only).
   */
  productionLiveVerification?: BrokerProductionLiveVerification;
  /** Connectivity routes this broker can be reached through. */
  connectionRoutes: BrokerConnectionRoute[];
  /** Normalized capabilities (Directive §M). */
  capabilities: BrokerCapability[];
  /** Authentication mechanism the user will complete. */
  authenticationType: 'API_TOKEN' | 'OAUTH' | 'SESSION_AUTH';
  /** Supported execution environments (explicit, never inferred). */
  environments: ('DEMO' | 'LIVE')[];
  /** Regions with known eligibility; empty = global/unverified. */
  regions: string[];
}
