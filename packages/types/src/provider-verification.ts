/**
 * @irexpro/types — provider verification label taxonomy (Sprint 56
 * correction round 5, architect issues #292/#293/#298).
 *
 * EXACTLY these six labels may be rendered as a provider/connection
 * verification label across web, admin, and mobile:
 *
 *   'LIVE-capable' | 'Production LIVE Verified' | 'Production LIVE Unverified'
 *   | 'Ineligible' | 'DEMO only' | 'execution disabled'
 *
 * Why a single shared taxonomy: the API layer distinguishes protocol/
 * environment capability, implementation availability, adapter availability,
 * operator verification, identity-specific production-LIVE eligibility, and
 * current connection executability as SEPARATE facts. A UI that collapses
 * them into one "Live" badge lies by omission (an UNVERIFIED BETA provider
 * must never be labeled simply "Live"). This module is the one place that
 * maps those server-authoritative facts onto the fixed label vocabulary.
 *
 * This is presentation-only: it derives NOTHING security-relevant — the
 * fail-closed executable/authorization gates stay server-computed. Unknown
 * or absent inputs always degrade to the more conservative label (fail-closed).
 */

import type { BrokerAuthorizationStatus } from './index';
import type {
  BrokerAvailabilityStatus,
  BrokerProductionLiveVerification,
} from './broker-registry';
import { deriveProviderCertificationState } from './broker-registry';

/** The fixed provider verification label vocabulary (render verbatim). */
export type ProviderVerificationLabel =
  | 'LIVE-capable'
  | 'Production LIVE Verified'
  | 'Production LIVE Unverified'
  | 'Ineligible'
  | 'DEMO only'
  | 'execution disabled';

/**
 * Facts a renderer may know. Every field is optional so the assessment
 * degrades truthfully when only a subset is loaded (e.g. the registry is
 * unreachable): absent facts are treated FAIL-CLOSED, never guessed.
 */
export interface ProviderVerificationAssessmentInput {
  /** (a) Protocol/environment capability — provider-declared environments. */
  environments?: readonly ('DEMO' | 'LIVE')[] | null;
  /** (b) Implementation availability (registry `status`). */
  implementationStatus?: BrokerAvailabilityStatus | null;
  /** (c) Adapter availability — a live adapter registered right now. */
  adapterAvailable?: boolean | null;
  /** (d) Operator-attested production-LIVE verification evidence. */
  productionLiveVerification?: BrokerProductionLiveVerification | null;
  /** Connection identity: the account type of the connected identity. */
  accountType?: 'DEMO' | 'LIVE' | null;
  /** Connection identity: server-derived canonical logical account key. */
  logicalAccountKey?: string | null;
  /** Connection authorization status (ACTIVE is the only executing state). */
  authorizationStatus?: BrokerAuthorizationStatus | null;
  /** Server-computed fail-closed execution gate. */
  executable?: boolean | null;
  /**
   * Derived certification state (production-LIVE completion round). When the
   * server payload carries it, it is authoritative; when absent it is
   * derived fail-closed from the raw verification evidence via the same
   * rules the API applies. Legacy attestation evidence therefore NEVER
   * renders as a current protocol certification.
   */
  certificationState?: import('./broker-registry').ProviderCertificationState | null;
}

/** The six distinguished facts, each rendered from the fixed taxonomy. */
export interface ProviderVerificationAssessment {
  /** (a) Protocol/environment capability. */
  environmentCapability: 'LIVE-capable' | 'DEMO only';
  /** (b) Implementation availability. */
  implementationAvailability: 'LIVE-capable' | 'Ineligible';
  /** (c) Adapter availability. */
  adapterAvailability: 'LIVE-capable' | 'Ineligible';
  /** (d) Production-LIVE verification status. */
  verificationStatus:
    | 'Production LIVE Verified'
    | 'Production LIVE Unverified'
    | 'Ineligible';
  /** (e) Identity-specific production-LIVE eligibility. */
  identityProductionLiveEligibility: 'LIVE-capable' | 'Ineligible' | 'DEMO only';
  /** (f) Current BrokerConnection executability. */
  connectionExecutability: 'LIVE-capable' | 'DEMO only' | 'execution disabled';
  /**
   * Dominant single label for connection/provider cards — the verification
   * truth, NOT the executability state ('execution disabled' is surfaced
   * separately via `connectionExecutability` and the session authority UI).
   */
  label: ProviderVerificationLabel;
  /** True when a concrete connection identity was assessed. */
  hasConnectionIdentity: boolean;
  /**
   * The derived certification state used for this assessment
   * (production-LIVE completion round): 'NOT_CERTIFIED' | 'LEGACY_VERIFIED' |
   * 'CERTIFIED'. Renderers that need the three-state certification truth
   * (Directive Phase 2) consume THIS field, not the six-label vocabulary.
   */
  certificationState: import('./broker-registry').ProviderCertificationState;
}

/** Implementation statuses that count as implemented (adapter-backed). */
const IMPLEMENTED_STATUSES: readonly BrokerAvailabilityStatus[] = [
  'SUPPORTED',
  'BETA',
];

/**
 * Assess provider verification truthfulness from the known facts.
 *
 * Label semantics (fail-closed on every unknown):
 * - 'DEMO only'      — no LIVE environment/identity pathway exists.
 * - 'Ineligible'     — a LIVE pathway may exist in principle, but this
 *                      provider/implementation/adapter/identity is not
 *                      eligible for production-LIVE execution.
 * - 'LIVE-capable'   — capability ONLY: the protocol/environment (or, for
 *                      executability, the granted authority) supports LIVE;
 *                      it is NOT an approval or verification claim.
 * - 'Production LIVE Verified'   — CURRENT protocol certification (derived
 *                      certificationState === 'CERTIFIED'). Legacy
 *                      attestation (LEGACY_VERIFIED) NEVER renders as this
 *                      label — the runtime LIVE gate rejects it.
 * - 'Production LIVE Unverified' — verification absent/UNVERIFIED, or legacy
 *                      only: LIVE execution fails closed server-side
 *                      (BETA ≠ LIVE; legacy ≠ certified).
 * - 'execution disabled' — the current BrokerConnection cannot execute
 *                      (fail-closed gate or non-ACTIVE authorization).
 */
export function assessProviderVerification(
  input: ProviderVerificationAssessmentInput,
): ProviderVerificationAssessment {
  const environmentsLive =
    input.environments?.includes('LIVE') === true || input.accountType === 'LIVE';

  // Production-LIVE completion round: the certification TRUTH is the derived
  // state, never the raw `status === 'VERIFIED'` flag. Legacy attestation
  // evidence (LEGACY_VERIFIED) is real history but is NOT a current protocol
  // certification — the runtime LIVE gate rejects it, so the label must not
  // present it as verified/LIVE-capable. Absent state input derives
  // fail-closed from the raw evidence via the shared mirror derivation.
  const certificationState =
    input.certificationState ??
    deriveProviderCertificationState(input.productionLiveVerification ?? undefined);
  const protocolCertified = certificationState === 'CERTIFIED';

  const environmentCapability: ProviderVerificationAssessment['environmentCapability'] =
    environmentsLive ? 'LIVE-capable' : 'DEMO only';

  const implemented =
    input.implementationStatus != null &&
    IMPLEMENTED_STATUSES.includes(input.implementationStatus);
  const implementationAvailability: ProviderVerificationAssessment['implementationAvailability'] =
    implemented ? 'LIVE-capable' : 'Ineligible';

  const adapterAvailable = input.adapterAvailable === true;
  const adapterAvailability: ProviderVerificationAssessment['adapterAvailability'] =
    adapterAvailable ? 'LIVE-capable' : 'Ineligible';

  const verificationStatus: ProviderVerificationAssessment['verificationStatus'] =
    !environmentsLive
      ? 'Ineligible'
      : protocolCertified
        ? 'Production LIVE Verified'
        : 'Production LIVE Unverified';

  // (e) Identity-specific production-LIVE eligibility: only a LIVE-typed
  // identity on a currently CERTIFIED, LIVE-capable provider is eligible.
  // LEGACY_VERIFIED is NOT eligible (the runtime gate rejects it) and DEMO
  // identities can never be production-LIVE eligible; absent identity facts
  // fail closed to Ineligible.
  const hasConnectionIdentity =
    input.accountType != null || input.logicalAccountKey != null;
  const identityProductionLiveEligibility: ProviderVerificationAssessment['identityProductionLiveEligibility'] =
    !hasConnectionIdentity
      ? 'Ineligible'
      : input.accountType === 'DEMO'
        ? 'DEMO only'
        : environmentsLive && protocolCertified
          ? 'LIVE-capable'
          : 'Ineligible';

  // (f) Current connection executability — the server-computed gate plus the
  // authorization state machine (only ACTIVE may execute).
  const authorityGranted =
    input.executable === true && input.authorizationStatus === 'ACTIVE';
  const connectionExecutability: ProviderVerificationAssessment['connectionExecutability'] =
    !authorityGranted
      ? 'execution disabled'
      : input.accountType === 'DEMO'
        ? 'DEMO only'
        : 'LIVE-capable';

  // Dominant card label: the verification truth (never 'execution disabled').
  let label: ProviderVerificationLabel;
  if (input.accountType === 'DEMO') {
    label = 'DEMO only';
  } else if (input.environments != null && !environmentsLive) {
    label = 'DEMO only';
  } else if (input.implementationStatus != null && !implemented) {
    label = 'Ineligible';
  } else if (input.adapterAvailable === false) {
    label = 'Ineligible';
  } else if (protocolCertified) {
    label = 'Production LIVE Verified';
  } else {
    label = 'Production LIVE Unverified';
  }

  return {
    environmentCapability,
    implementationAvailability,
    adapterAvailability,
    verificationStatus,
    identityProductionLiveEligibility,
    connectionExecutability,
    label,
    hasConnectionIdentity,
    certificationState,
  };
}
