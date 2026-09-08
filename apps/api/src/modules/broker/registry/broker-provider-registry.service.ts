import { Injectable } from '@nestjs/common';
import { BROKER_CATALOG, BROKER_CATALOG_VERSION } from './broker-catalog';
import {
  BrokerAvailabilityStatus,
  BrokerConnectionRoute,
  BrokerDefinition,
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
   * Production-LIVE verification evidence (architect Phase H) — always
   * materialized. BETA ≠ production-LIVE: implementation status describes
   * adapter evidence only; VERIFIED here is what gates LIVE execution.
   */
  productionLiveVerification: {
    status: BrokerProductionLiveVerificationStatus;
    verifiedAt: string | null;
    evidenceRef: string | null;
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
 * Merges the static BROKER_CATALOG with live adapter availability:
 * an entry without a registered adapter can NEVER be reported as SUPPORTED
 * (status honesty — Directive §AB). Clients (web/admin/mobile) must render
 * this catalog instead of maintaining their own broker lists.
 *
 * Fail-closed: `isConnectable(id)` returns false for anything without a
 * registered adapter, regardless of catalog status.
 *
 * Production-LIVE truth (architect Phase H): implementation status and
 * adapter availability say NOTHING about production-LIVE approval.
 * `isProductionLiveEligible(id)` is the fail-closed LIVE gate — true only
 * with VERIFIED operator evidence AND a registered adapter. BETA/UNVERIFIED
 * providers remain connectable for DEMO use but can never open or enable
 * LIVE execution.
 */
@Injectable()
export class BrokerProviderRegistryService {
  constructor(private readonly adapterRegistry: BrokerAdapterRegistry) {}

  /** Full catalog with runtime adapter availability overlay. */
  getCatalog(): BrokerRegistryEntry[] {
    return BROKER_CATALOG.map((entry) => {
      const adapterAvailable =
        entry.adapterId !== null && this.adapterRegistry.isSupported(entry.adapterId);

      // Honesty rule: a definition can only be SUPPORTED or BETA when its
      // adapter is actually registered at runtime. Otherwise downgrade to
      // NOT_STARTED (Sprint 51 PR-7: BETA also requires a real registered
      // adapter — a catalog entry alone can never claim BETA).
      const effectiveStatus =
        (entry.status === BrokerAvailabilityStatus.SUPPORTED ||
          entry.status === BrokerAvailabilityStatus.BETA) &&
        !adapterAvailable
          ? BrokerAvailabilityStatus.NOT_STARTED
          : entry.status;

      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        status: effectiveStatus,
        // Phase H: production-LIVE evidence always materialized (default
        // UNVERIFIED when the definition carries none) so UI consumers can
        // render implementation status and LIVE verification distinctly.
        productionLiveVerification: {
          status: entry.productionLiveVerification?.status ?? 'UNVERIFIED',
          verifiedAt: entry.productionLiveVerification?.verifiedAt ?? null,
          evidenceRef: entry.productionLiveVerification?.evidenceRef ?? null,
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
   * definition and a registered adapter are connectable.
   *
   * Connectability = adapter presence only — a BETA/DEMO connection is
   * still connectable for DEMO use (unchanged semantics, Phase H keeps
   * this orthogonal to production-LIVE eligibility below).
   */
  isConnectable(brokerId: string): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.adapterAvailable;
  }

  /**
   * Production-LIVE eligibility: TRUE only with VERIFIED evidence.
   * BETA/UNVERIFIED fails closed (architect Phase H) — no LIVE connections,
   * no enable-live, regardless of adapter availability or catalog status.
   * Unknown brokers and entries whose adapter is not currently registered
   * are also ineligible.
   */
  isProductionLiveEligible(brokerId: string): boolean {
    const entry = this.getEntry(brokerId);
    return (
      entry !== null &&
      entry.adapterAvailable &&
      entry.productionLiveVerification.status === 'VERIFIED'
    );
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
