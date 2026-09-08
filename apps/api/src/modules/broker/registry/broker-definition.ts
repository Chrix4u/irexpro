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
