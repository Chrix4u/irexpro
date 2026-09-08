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

export interface BrokerRegistryEntry {
  id: string;
  name: string;
  description: string;
  status: BrokerAvailabilityStatus;
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
