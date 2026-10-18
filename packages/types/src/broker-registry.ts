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

export interface BrokerProductionLiveVerification {
  status: 'UNVERIFIED' | 'VERIFIED';
  verifiedAt: string | null;
  evidenceRef: string | null;
  certifiedVia?: 'LEGACY_ATTESTATION' | 'HARNESS_CERTIFIED' | null;
  certificationRunRef?: string | null;
}

export type ProviderCertificationState = 'NOT_CERTIFIED' | 'LEGACY_VERIFIED' | 'CERTIFIED';

export function deriveProviderCertificationState(
  verification: BrokerProductionLiveVerification | undefined | null,
): ProviderCertificationState {
  if (!verification || verification.status !== 'VERIFIED') {
    return 'NOT_CERTIFIED';
  }
  if (verification.certifiedVia !== 'HARNESS_CERTIFIED') {
    return 'LEGACY_VERIFIED';
  }

  const verifiedAt = verification.verifiedAt?.trim() ?? '';
  const evidenceRef = verification.evidenceRef?.trim() ?? '';
  const certificationRunRef = verification.certificationRunRef?.trim() ?? '';
  const runRefPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@sha256:[0-9a-f]{64}$/i;

  if (
    !verifiedAt ||
    Number.isNaN(Date.parse(verifiedAt)) ||
    !evidenceRef ||
    !runRefPattern.test(certificationRunRef)
  ) {
    return 'NOT_CERTIFIED';
  }

  return 'CERTIFIED';
}

export type BrokerConnectionReadinessCode =
  | 'READY'
  | 'ADAPTER_UNAVAILABLE'
  | 'PLATFORM_CREDENTIALS_REQUIRED'
  | 'PROVIDER_APP_APPROVAL_REQUIRED'
  | 'OAUTH_REDIRECT_REQUIRED'
  | 'MOBILE_OAUTH_CALLBACK_REQUIRED';

export interface BrokerConnectionChannelReadiness {
  ready: boolean;
  code: BrokerConnectionReadinessCode;
  message: string | null;
}

export interface BrokerConnectionReadiness extends BrokerConnectionChannelReadiness {
  channels?: Partial<Record<'web' | 'mobile', BrokerConnectionChannelReadiness>>;
}

export interface BrokerRegistryEntry {
  id: string;
  name: string;
  description: string;
  status: BrokerAvailabilityStatus;
  productionLiveVerification?: BrokerProductionLiveVerification;
  certificationState?: ProviderCertificationState;
  connectionRoutes: BrokerConnectionRoute[];
  capabilities: BrokerCapability[];
  authenticationType: BrokerAuthenticationType;
  environments: ('DEMO' | 'LIVE')[];
  regions: string[];
  adapterAvailable: boolean;
  connectionReadiness?: BrokerConnectionReadiness;
}

export interface BrokerRegistryCatalog {
  catalogVersion: string;
  brokers: BrokerRegistryEntry[];
}

export function isBrokerConnectionRuntimeReady(
  entry:
    | Pick<BrokerRegistryEntry, 'connectionReadiness'>
    | null
    | undefined,
): boolean {
  if (!entry) return false;
  return entry.connectionReadiness?.ready !== false;
}
