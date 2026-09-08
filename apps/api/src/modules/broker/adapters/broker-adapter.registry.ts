import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IBrokerAdapter } from '../interfaces/broker-adapter.interface';

export interface BrokerSummary {
  brokerId: string;
  brokerName: string;
  supportsDemo: boolean;
}

/**
 * BrokerAdapterRegistry — Factory registry for all IBrokerAdapter implementations.
 *
 * Each broker adapter registers itself at module init.
 * BrokerService calls getAdapter(brokerId) to retrieve the correct implementation.
 * No broker-specific logic ever leaks into BrokerService or above.
 *
 * Broker aliases (Task 48-B / Sprint 56): multiple catalog brokerIds (e.g.
 * 'pepperstone-ctrader', 'icmarkets-ctrader') can share ONE adapter instance
 * (the universal cTrader engine) via registerBrokerAlias(). Aliases resolve
 * through getAdapter/isSupported exactly like primary registrations;
 * getSupportedBrokers() stays deduplicated (one summary per adapter).
 *
 * See: docs/architecture/09-broker-integration-architecture.md §5
 */
@Injectable()
export class BrokerAdapterRegistry {
  private readonly logger = new Logger(BrokerAdapterRegistry.name);
  private readonly adapters = new Map<string, IBrokerAdapter>();

  register(adapter: IBrokerAdapter): void {
    this.adapters.set(adapter.brokerId, adapter);
    this.logger.log(`Registered broker adapter: ${adapter.brokerId} (${adapter.brokerName})`);
  }

  /**
   * Registers an additional catalog brokerId backed by an EXISTING adapter
   * (e.g. 'pepperstone-ctrader' → the universal cTrader engine). The alias
   * resolves to the SAME adapter instance; capabilities/status truth stays
   * in the broker catalog (Directive §M) — the registry never re-declares it.
   */
  registerBrokerAlias(aliasBrokerId: string, adapter: IBrokerAdapter): void {
    if (aliasBrokerId === adapter.brokerId) {
      this.register(adapter);
      return;
    }
    this.adapters.set(aliasBrokerId, adapter);
    this.logger.log(
      `Registered broker alias: ${aliasBrokerId} → adapter ${adapter.brokerId} (${adapter.brokerName})`,
    );
  }

  getAdapter(brokerId: string): IBrokerAdapter {
    const adapter = this.adapters.get(brokerId);
    if (!adapter) {
      throw new NotFoundException(
        `No broker adapter registered for brokerId: "${brokerId}". ` +
          `Supported brokers: [${this.getSupportedBrokerIds().join(', ')}]`,
      );
    }
    return adapter;
  }

  /**
   * Summaries of registered adapters — DEDUPLICATED by adapter brokerId so
   * alias registrations (which map extra keys onto one instance) never
   * duplicate entries.
   */
  getSupportedBrokers(): BrokerSummary[] {
    const seen = new Set<string>();
    const summaries: BrokerSummary[] = [];
    for (const adapter of this.adapters.values()) {
      if (seen.has(adapter.brokerId)) continue; // alias re-registration
      seen.add(adapter.brokerId);
      summaries.push({
        brokerId: adapter.brokerId,
        brokerName: adapter.brokerName,
        supportsDemo: adapter.supportsDemo,
      });
    }
    return summaries;
  }

  getSupportedBrokerIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  isSupported(brokerId: string): boolean {
    return this.adapters.has(brokerId);
  }
}
