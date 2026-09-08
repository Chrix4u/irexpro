import { Injectable } from '@nestjs/common';
import { BROKER_CATALOG, BROKER_CATALOG_VERSION } from './broker-catalog';
import {
  BrokerAvailabilityStatus,
  BrokerConnectionRoute,
  BrokerDefinition,
} from './broker-definition';
import { BrokerCapability } from './broker-capability.enum';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';

/** Frontend-safe registry view (no adapter instances, no secrets). */
export interface BrokerRegistryEntry {
  id: string;
  name: string;
  description: string;
  status: BrokerAvailabilityStatus;
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
 */
@Injectable()
export class BrokerProviderRegistryService {
  constructor(private readonly adapterRegistry: BrokerAdapterRegistry) {}

  /** Full catalog with runtime adapter availability overlay. */
  getCatalog(): BrokerRegistryEntry[] {
    return BROKER_CATALOG.map((entry) => {
      const adapterAvailable =
        entry.adapterId !== null && this.adapterRegistry.isSupported(entry.adapterId);

      // Honesty rule: a definition can only be SUPPORTED when its adapter is
      // actually registered at runtime. Otherwise downgrade to NOT_STARTED.
      const effectiveStatus =
        entry.status === BrokerAvailabilityStatus.SUPPORTED && !adapterAvailable
          ? BrokerAvailabilityStatus.NOT_STARTED
          : entry.status;

      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        status: effectiveStatus,
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
   */
  isConnectable(brokerId: string): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.adapterAvailable;
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
