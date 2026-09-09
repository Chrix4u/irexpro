/**
 * Broker OAuth flow shared client state (Sprint 56 correction round 1 /
 * audit point 6).
 *
 * cTrader's OAuth supports no state parameter — the server-side flowId is
 * the correlation token. The web keeps its copy in sessionStorage across
 * the external consent round trip (Next.js pages cannot export arbitrary
 * constants, hence this module).
 */
export const IREXPRO_BROKER_OAUTH_FLOW_KEY = 'irexpro.broker.oauth.flowId';
