import { Injectable } from '@nestjs/common';
import { BROKER_CATALOG, BROKER_CATALOG_VERSION } from './broker-catalog';
import {
  BrokerAvailabilityStatus,
  BrokerConnectionRoute,
  BrokerDefinition,
  deriveProviderCertificationState,
  LiveReadinessBlockedReason,
  ProviderCertificationState,
} from './broker-definition';
import { BrokerCapability } from './broker-capability.enum';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';

/** Materialized (always-present) production-LIVE verification status. */
export type BrokerProductionLiveVerificationStatus = 'UNVERIFIED' | 'VERIFIED';

/** Frontend-safe registry view (no adapter instances, no secrets). */
export interface BrokerRegistryEntry {
  id: string;
  name: string;
  description: string;
  status: BrokerAvailabilityStatus;
  /**
   * Production-LIVE verification evidence — always materialized. Historical
   * VERIFIED evidence is retained for truth, but runtime production-LIVE
   * eligibility is derived separately and requires current certification.
   */
  productionLiveVerification: {
    status: BrokerProductionLiveVerificationStatus;
    verifiedAt: string | null;
    evidenceRef: string | null;
    /** Round 7.1 (P0-3): provenance — legacy attestation vs protocol certification. */
    certifiedVia: 'LEGACY_ATTESTATION' | 'HARNESS_CERTIFIED' | null;
    /** Harness run reference for HARNESS_CERTIFIED entries (null otherwise). */
    certificationRunRef: string | null;
    /**
     * Truthful derived state. CERTIFIED requires complete current harness
     * evidence; legacy verification is exposed as LEGACY_VERIFIED and does
     * not authorize production LIVE.
     */
    certificationState: ProviderCertificationState;
  };
  /** Top-level derived certification state for web/admin/mobile consumers. */
  certificationState: ProviderCertificationState;
  /**
   * Production-LIVE completion round (Phase 15): always-materialized
   * live-readiness summary — `eligible` mirrors the runtime gate and
   * `blockedReasons` explains WHY LIVE is unavailable while it is
   * unavailable (never a bare false; a user never discovers impossibility
   * only on click).
   */
  liveReadiness: {
    eligible: boolean;
    blockedReasons: LiveReadinessBlockedReason[];
    partnerApprovalRequired: boolean;
    liveUnavailableRegions: string[];
  };
  connectionRoutes: BrokerConnectionRoute[];
  capabilities: BrokerCapability[];
  authenticationType: BrokerDefinition['authenticationType'];
  environments: BrokerDefinition['environments'];
  regions: string[];
  /** True when a live adapter is registered for this entry right now. */
  adapterAvailable: boolean;
}

/**
 * BrokerProviderRegistryService — the single server-authoritative broker
 * catalog (Directive §N, §AU).
 *
 * Merges the static BROKER_CATALOG with live adapter availability. An entry
 * without a registered adapter can NEVER be reported as SUPPORTED/BETA.
 *
 * Production-LIVE truth: implementation status and adapter availability say
 * NOTHING about approval. `isProductionLiveEligible(id)` is the fail-closed
 * LIVE gate and returns true only when a registered adapter exists AND the
 * provider's derived state is CERTIFIED from complete current harness
 * evidence. LEGACY_VERIFIED is informational and remains LIVE-ineligible.
 */
@Injectable()
export class BrokerProviderRegistryService {
  constructor(private readonly adapterRegistry: BrokerAdapterRegistry) {}

  /** Full catalog with runtime adapter availability overlay. */
  getCatalog(): BrokerRegistryEntry[] {
    return BROKER_CATALOG.map((entry) => {
      const adapterAvailable =
        entry.adapterId !== null && this.adapterRegistry.isSupported(entry.adapterId);

      const effectiveStatus =
        (entry.status === BrokerAvailabilityStatus.SUPPORTED ||
          entry.status === BrokerAvailabilityStatus.BETA) &&
        !adapterAvailable
          ? BrokerAvailabilityStatus.NOT_STARTED
          : entry.status;

      const certificationState = deriveProviderCertificationState(entry.productionLiveVerification);

      const liveEnvironmentSupported = entry.environments.includes('LIVE');
      const blockedReasons: LiveReadinessBlockedReason[] = [];
      if (!liveEnvironmentSupported) {
        blockedReasons.push('LIVE_UNSUPPORTED');
      } else {
        if (!adapterAvailable) {
          blockedReasons.push('ADAPTER_UNAVAILABLE');
        }
        if (entry.liveReadiness?.partnerApprovalRequired === true) {
          blockedReasons.push('PARTNER_APPROVAL_REQUIRED');
        }
        if (certificationState !== 'CERTIFIED') {
          blockedReasons.push('CERTIFICATION_REQUIRED');
        }
      }
      const liveEligible =
        liveEnvironmentSupported && adapterAvailable && certificationState === 'CERTIFIED';

      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        status: effectiveStatus,
        productionLiveVerification: {
          status: entry.productionLiveVerification?.status ?? 'UNVERIFIED',
          verifiedAt: entry.productionLiveVerification?.verifiedAt ?? null,
          evidenceRef: entry.productionLiveVerification?.evidenceRef ?? null,
          certifiedVia: entry.productionLiveVerification?.certifiedVia ?? null,
          certificationRunRef: entry.productionLiveVerification?.certificationRunRef ?? null,
          certificationState,
        },
        certificationState,
        liveReadiness: {
          eligible: liveEligible,
          blockedReasons,
          partnerApprovalRequired: entry.liveReadiness?.partnerApprovalRequired === true,
          liveUnavailableRegions: [...(entry.liveReadiness?.liveUnavailableRegions ?? [])],
        },
        connectionRoutes: [...entry.connectionRoutes],
        capabilities: [...entry.capabilities],
        authenticationType: entry.authenticationType,
        environments: [...entry.environments],
        regions: [...entry.regions],
        adapterAvailable,
      };
    });
  }

  /** Single entry by id (null when unknown). */
  getEntry(brokerId: string): BrokerRegistryEntry | null {
    return this.getCatalog().find((e) => e.id === brokerId) ?? null;
  }

  /**
   * FAIL-CLOSED connectability gate: only entries with BOTH a catalog
   * definition and a registered adapter are connectable. Connectability is
   * intentionally orthogonal to production-LIVE eligibility so DEMO/BETA
   * providers can still be used where permitted.
   */
  isConnectable(brokerId: string): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.adapterAvailable;
  }

  /**
   * Production-LIVE eligibility: TRUE only for a current CERTIFIED provider
   * with a registered adapter. Historical LEGACY_VERIFIED evidence, missing
   * durable evidence, malformed run references, BETA/UNVERIFIED providers,
   * unknown brokers, and unavailable adapters all fail closed.
   */
  isProductionLiveEligible(brokerId: string): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.adapterAvailable && entry.certificationState === 'CERTIFIED';
  }

  /**
   * Production-LIVE completion round (Phase 5/9): region availability for a
   * SPECIFIC user. Fails closed for a blocked country; a null/unknown country
   * cannot be evaluated here and is left to the profile-completeness gates
   * that always precede LIVE exposure (a user without a country cannot
   * complete onboarding). Unknown brokers fail closed (no LIVE region claim).
   */
  isLiveRegionAvailable(brokerId: string, countryCode: string | null): boolean {
    const entry = this.getEntry(brokerId);
    if (entry === null) return false;
    if (!countryCode) return true;
    const normalized = countryCode.trim().toUpperCase();
    if (!normalized) return true;
    return !entry.liveReadiness.liveUnavailableRegions.includes(normalized);
  }

  /** Capability query (Directive §M) — never guess from broker name. */
  hasCapability(brokerId: string, capability: BrokerCapability): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.capabilities.includes(capability);
  }

  /** Environment support query (Directive §11 — explicit, never inferred). */
  supportsEnvironment(brokerId: string, environment: 'DEMO' | 'LIVE'): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.environments.includes(environment);
  }

  get catalogVersion(): string {
    return BROKER_CATALOG_VERSION;
  }
}
