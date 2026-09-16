import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IBrokerAdapter } from '../interfaces/broker-adapter.interface';

export interface BrokerSummary {
  brokerId: string;
  brokerName: string;
  supportsDemo: boolean;
}

/**
 * Isolation factory for a broker provider (#291 / Sprint 56 correction round 3).
 *
 * Receives the REQUESTED broker id — including a catalog alias such as
 * 'pepperstone-ctrader' or 'icmarkets-ctrader' — so an alias-aware provider
 * can preserve the requested identity for broker-specific verification. The
 * returned adapter's `brokerId` MUST stay the canonical provider id (e.g.
 * 'ctrader'); the requested identity is carried separately by the adapter.
 */
export type BrokerAdapterFactory = (requestedBrokerId: string) => IBrokerAdapter;

interface BrokerAdapterRegistration {
  adapter: IBrokerAdapter;
  factory?: BrokerAdapterFactory;
}

interface BrokerAdapterSession {
  brokerId: string;
  adapter: IBrokerAdapter;
}

/**
 * BrokerAdapterRegistry — provider metadata + connection-scoped adapter sessions.
 *
 * SECURITY BOUNDARY (#291 / Sprint 56 correction round 3, architect findings 1,
 * 2 and 7): adapter implementations carry mutable environment/account/session
 * state (setMode, current account, per-account caches). The registered root
 * instance is therefore metadata-only. Persisted BrokerConnection operations
 * MUST use getAdapterForConnection(), which gives one mutable adapter context
 * per BrokerConnection.id. Pre-persistence credential checks use an ephemeral
 * factory instance (createEphemeralAdapter). This prevents one
 * tenant/account/connection from overwriting another's setMode/current-account
 * state while an async provider call is in flight.
 *
 * Broker aliases never store adapter instances. They resolve to a canonical
 * provider registration and therefore share only its factory/provider
 * infrastructure (the lower-level provider client may remain shared where it
 * is stateless with respect to adapter context — e.g. the cTrader
 * environment-connection pool); each persisted connection still receives its
 * own mutable adapter context. The requested broker id is passed into the
 * factory so an alias-aware provider can validate provider identity instead
 * of treating every account on the shared infrastructure as interchangeable.
 */
@Injectable()
export class BrokerAdapterRegistry {
  private readonly logger = new Logger(BrokerAdapterRegistry.name);
  private readonly registrations = new Map<string, BrokerAdapterRegistration>();
  private readonly aliases = new Map<string, string>();
  private readonly connectionSessions = new Map<string, BrokerAdapterSession>();
  /**
   * A factory is an isolation boundary, not merely a constructor callback. Track
   * every object it has produced so a cached/singleton factory cannot silently
   * hand the same mutable adapter to two independent operations.
   */
  private readonly isolatedAdapterInstances = new WeakSet<IBrokerAdapter>();

  register(adapter: IBrokerAdapter, factory?: BrokerAdapterFactory): void {
    this.registrations.set(adapter.brokerId, { adapter, factory });
    this.aliases.delete(adapter.brokerId);
    this.logger.log(
      `Registered broker adapter: ${adapter.brokerId} (${adapter.brokerName})` +
        (factory ? ' [connection-isolated]' : ' metadata-only; account operations blocked]'),
    );
  }

  /**
   * Register a catalog broker id against an existing canonical provider.
   *
   * Compatibility: callers may pass either the canonical broker id or its
   * registered root adapter. The adapter object is used for identity validation
   * only; it is NEVER stored under the alias.
   */
  registerBrokerAlias(aliasBrokerId: string, target: string | IBrokerAdapter): void {
    const targetBrokerId = typeof target === 'string' ? target : target.brokerId;
    const canonicalBrokerId = this.resolveCanonicalBrokerId(targetBrokerId);
    const registration = this.registrations.get(canonicalBrokerId);
    if (!registration) {
      throw new NotFoundException(
        `Cannot register broker alias ${aliasBrokerId}: canonical provider ` +
          `${targetBrokerId} is not registered`,
      );
    }
    if (typeof target !== 'string' && registration.adapter !== target) {
      throw new ConflictException(
        `Cannot register broker alias ${aliasBrokerId}: adapter identity does not match ` +
          `canonical provider ${canonicalBrokerId}`,
      );
    }
    if (!aliasBrokerId) {
      throw new ConflictException('Broker alias requires a non-empty broker id');
    }
    if (aliasBrokerId === canonicalBrokerId) return;
    if (this.registrations.has(aliasBrokerId)) {
      throw new ConflictException(
        `Cannot register broker alias ${aliasBrokerId}: a primary adapter already uses that id`,
      );
    }

    const existing = this.aliases.get(aliasBrokerId);
    if (existing && existing !== canonicalBrokerId) {
      throw new ConflictException(
        `Broker alias ${aliasBrokerId} is already bound to canonical provider ${existing}`,
      );
    }

    this.aliases.set(aliasBrokerId, canonicalBrokerId);
    this.logger.log(`Registered broker alias: ${aliasBrokerId} → ${canonicalBrokerId}`);
  }

  /** Metadata/root lookup only. Production account operations must use a session. */
  getAdapter(brokerId: string): IBrokerAdapter {
    return this.getRegistration(brokerId).adapter;
  }

  /**
   * Fresh adapter for operations that are not yet tied to a persisted connection,
   * such as credential testing. Never cached.
   */
  createEphemeralAdapter(brokerId: string): IBrokerAdapter {
    return this.instantiate(brokerId);
  }

  /**
   * One mutable adapter context per persisted BrokerConnection.id. Concurrent calls
   * for the same connection share its session; different connection ids never do.
   * The requested broker id (including an alias) remains part of the binding so a
   * persisted connection cannot silently switch brands/routes after session creation.
   */
  getAdapterForConnection(connectionId: string, brokerId: string): IBrokerAdapter {
    if (!connectionId) {
      throw new ConflictException('Broker adapter session requires a connection id');
    }

    const existing = this.connectionSessions.get(connectionId);
    if (existing) {
      if (existing.brokerId !== brokerId) {
        throw new ConflictException(
          `Broker connection ${connectionId} is already bound to provider ` +
            `${existing.brokerId}; refusing cross-provider session reuse`,
        );
      }
      return existing.adapter;
    }

    const adapter = this.instantiate(brokerId);
    this.connectionSessions.set(connectionId, { brokerId, adapter });
    return adapter;
  }

  /** Drop mutable adapter context after disconnect/delete. Safe to call repeatedly. */
  releaseAdapterForConnection(connectionId: string): void {
    this.connectionSessions.delete(connectionId);
  }

  /** Primary provider summaries only; aliases remain catalog identities, not adapters. */
  getSupportedBrokers(): BrokerSummary[] {
    return Array.from(this.registrations.values()).map(({ adapter }) => ({
      brokerId: adapter.brokerId,
      brokerName: adapter.brokerName,
      supportsDemo: adapter.supportsDemo,
    }));
  }

  /** Runtime-connectable ids include both primary providers and registered aliases. */
  getSupportedBrokerIds(): string[] {
    return [...this.registrations.keys(), ...this.aliases.keys()];
  }

  isSupported(brokerId: string): boolean {
    return this.registrations.has(brokerId) || this.aliases.has(brokerId);
  }

  /** Visible for deterministic security tests/observability; never contains secrets. */
  getActiveConnectionSessionCount(): number {
    return this.connectionSessions.size;
  }

  private instantiate(brokerId: string): IBrokerAdapter {
    const registration = this.getRegistration(brokerId);
    if (!registration.factory) {
      throw new ConflictException(
        `Broker adapter ${brokerId} has no connection-isolation factory; ` +
          'refusing account-scoped provider operation',
      );
    }

    const adapter = registration.factory(brokerId);
    if (adapter === registration.adapter) {
      throw new ConflictException(
        `Broker adapter ${brokerId} isolation factory returned its metadata/root singleton; ` +
          'refusing shared mutable provider context',
      );
    }
    if (adapter.brokerId !== registration.adapter.brokerId) {
      throw new ConflictException(
        `Broker adapter ${brokerId} isolation factory returned provider ${adapter.brokerId}; ` +
          `expected ${registration.adapter.brokerId}`,
      );
    }
    if (this.isolatedAdapterInstances.has(adapter)) {
      throw new ConflictException(
        `Broker adapter ${brokerId} isolation factory reused a previously-created adapter instance; ` +
          'refusing shared mutable provider context',
      );
    }

    this.isolatedAdapterInstances.add(adapter);
    return adapter;
  }

  private getRegistration(brokerId: string): BrokerAdapterRegistration {
    const canonicalBrokerId = this.resolveCanonicalBrokerId(brokerId);
    const registration = this.registrations.get(canonicalBrokerId);
    if (!registration) {
      throw new NotFoundException(
        `No broker adapter registered for brokerId: "${brokerId}". ` +
          `Supported brokers: [${this.getSupportedBrokerIds().join(', ')}]`,
      );
    }
    return registration;
  }

  private resolveCanonicalBrokerId(brokerId: string): string {
    return this.aliases.get(brokerId) ?? brokerId;
  }
}
