import { BrokerCapability } from './broker-capability.enum';
import {
  BrokerConnectionRoute,
  BrokerDefinition,
  BrokerAvailabilityStatus,
} from './broker-definition';

/**
 * BROKER_CATALOG — static, versioned broker definitions.
 *
 * This is the SINGLE server-side source of truth for the broker catalog
 * (Directive §AU: web, Android and iOS must all render this same registry —
 * no client-side broker lists).
 *
 * STATUS HONESTY (Directive §AB): every entry's status MUST match actual
 * implementation evidence in this repository:
 * - metatrader5  → SUPPORTED (full IBrokerAdapter via MetaApi, tested;
 *   production-LIVE VERIFIED — live-proven in production via the MetaApi
 *   bridge)
 * - paper-broker → SUPPORTED (deterministic simulation adapter, tested; cannot go LIVE)
 * - OANDA        → BETA (Sprint 51 PR-7: full v20 REST adapter implemented +
 *   shared §AN contract suite + unit specs; NOT yet live-verified against a
 *   real OANDA practice account — see docs/brokers/oanda-v20-adapter.md)
 * - cTrader → BETA (Task 48-B / Sprint 56: full Open API JSON-WebSocket adapter
 *   implemented + contract-tested — MARKET/LIMIT/STOP/STOP_LIMIT orders,
 *   order-state reconciliation surface, margin, history. CANNOT reach real
 *   accounts until the operator registers a cTrader Open API application
 *   (openapi.ctrader.com — Spotware partner approval) and supplies
 *   CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET; without them connections fail
 *   closed. Production-LIVE UNVERIFIED.)
 * - pepperstone-ctrader / icmarkets-ctrader → BETA aliases of the same
 *   universal cTrader engine (Task 48-B): they run through the shared
 *   'ctrader' adapter; each broker additionally requires its own broker-side
 *   cTrader Open API approval for real accounts. UNVERIFIED.
 *
 * PRODUCTION-LIVE VERIFICATION (architect Phase H): `status` describes
 * implementation evidence only — it is NOT production-LIVE approval. The
 * separate `productionLiveVerification` field records operator-attested
 * LIVE evidence; absent/UNVERIFIED fails closed (LIVE connections and
 * enable-live are rejected — BETA is DEMO-only). Only metatrader5 carries
 * VERIFIED evidence today.
 */

/**
 * cTrader-family broker ids — every catalog entry backed by the shared
 * universal 'ctrader' adapter (the Open API engine). Single definition
 * point for OAuth token-lifecycle and OAuth-connection-flow gating.
 */
export const CTRADER_FAMILY_BROKER_IDS: readonly string[] = [
  'ctrader',
  'pepperstone-ctrader',
  'icmarkets-ctrader',
];

export const BROKER_CATALOG: readonly BrokerDefinition[] = [
  {
    id: 'metatrader5',
    name: 'MetaTrader 5 (via MetaApi)',
    description:
      'MT4/MT5 accounts connected through the MetaApi cloud bridge. Full order, ' +
      'position, margin and history support with per-account RPC pooling.',
    adapterId: 'metatrader5',
    status: BrokerAvailabilityStatus.SUPPORTED,
    // Production-LIVE verified: MetaTrader via MetaApi is the live-proven
    // production route (docs/brokers/provider-matrix.md). No single
    // attestation date exists in the repo history, so verifiedAt is null —
    // evidenceRef describes the production-operation evidence instead.
    productionLiveVerification: {
      status: 'VERIFIED',
      verifiedAt: null,
      evidenceRef: 'production operation — MetaApi bridge, live in production',
    },
    connectionRoutes: [BrokerConnectionRoute.METATRADER],
    capabilities: [
      BrokerCapability.ACCOUNT_READ,
      BrokerCapability.BALANCE_READ,
      BrokerCapability.POSITION_READ,
      BrokerCapability.ORDER_READ,
      BrokerCapability.HISTORY_READ,
      BrokerCapability.MARKET_DATA,
      BrokerCapability.MARKET_DATA_STREAMING,
      BrokerCapability.API_TOKEN,
      BrokerCapability.DEMO,
      BrokerCapability.LIVE,
      BrokerCapability.METATRADER,
      BrokerCapability.SDK,
      BrokerCapability.WEBHOOKS,
      BrokerCapability.ORDER_PLACEMENT,
      BrokerCapability.ORDER_MODIFICATION,
      BrokerCapability.CLOSE_ALL,
      BrokerCapability.MARGIN_CALCULATION,
    ],
    authenticationType: 'API_TOKEN',
    environments: ['DEMO', 'LIVE'],
    regions: [],
  },
  {
    id: 'paper-broker',
    name: 'iRexPro Paper Broker',
    description:
      'Deterministic in-platform simulation broker for PAPER execution. ' +
      'Cannot reach LIVE infrastructure by design — environment isolation is enforced.',
    adapterId: 'paper-broker',
    status: BrokerAvailabilityStatus.SUPPORTED,
    connectionRoutes: [BrokerConnectionRoute.PAPER],
    capabilities: [
      BrokerCapability.ACCOUNT_READ,
      BrokerCapability.BALANCE_READ,
      BrokerCapability.POSITION_READ,
      BrokerCapability.ORDER_READ,
      BrokerCapability.HISTORY_READ,
      BrokerCapability.MARKET_DATA,
      BrokerCapability.SESSION_AUTH,
      BrokerCapability.DEMO,
      BrokerCapability.ORDER_PLACEMENT,
      BrokerCapability.ORDER_MODIFICATION,
      BrokerCapability.CLOSE_ALL,
      BrokerCapability.MARGIN_CALCULATION,
    ],
    authenticationType: 'SESSION_AUTH',
    environments: ['DEMO'],
    regions: [],
  },
  {
    id: 'oanda',
    name: 'OANDA (v20 REST — BETA)',
    description:
      'Native OANDA v20 REST adapter (Sprint 51 PR-7). Accounts, pricing, ' +
      'instruments, market/limit/stop orders, positions (trades), history, ' +
      'and error normalization are implemented and contract-tested. BETA: ' +
      'not yet live-verified against a real OANDA practice account; v20 ' +
      'streaming (SSE price streams) is not implemented — REST polling only.',
    adapterId: 'oanda',
    status: BrokerAvailabilityStatus.BETA,
    // Phase H: adapter implemented + contract-tested, but production-LIVE is
    // UNVERIFIED — no operator-attested practice-account validation records
    // exist yet. LIVE fails closed (isProductionLiveEligible === false);
    // required evidence is documented in docs/brokers/oanda-v20-adapter.md
    // ("Requirements before SUPPORTED").
    productionLiveVerification: { status: 'UNVERIFIED' },
    connectionRoutes: [BrokerConnectionRoute.NATIVE_API],
    capabilities: [
      BrokerCapability.ACCOUNT_READ,
      BrokerCapability.BALANCE_READ,
      BrokerCapability.POSITION_READ,
      BrokerCapability.ORDER_READ,
      BrokerCapability.HISTORY_READ,
      BrokerCapability.MARKET_DATA,
      BrokerCapability.REST,
      BrokerCapability.API_TOKEN,
      BrokerCapability.DEMO,
      BrokerCapability.LIVE,
      BrokerCapability.ORDER_PLACEMENT,
      BrokerCapability.ORDER_MODIFICATION,
      BrokerCapability.CLOSE_ALL,
      BrokerCapability.MARGIN_CALCULATION,
    ],
    authenticationType: 'API_TOKEN',
    environments: ['DEMO', 'LIVE'],
    regions: [],
  },
  {
    id: 'ctrader',
    name: 'cTrader (Open API — BETA)',
    description:
      'Universal cTrader Open API adapter (JSON over WebSocket, port 5036; ' +
      'Sprint 56 / Task 48-B). Accounts, pricing, instruments, MARKET/LIMIT/STOP/' +
      'STOP_LIMIT orders, positions, working-order state (reconciliation), ' +
      'deal history and native margin are implemented and contract-tested. ' +
      'BETA — honest blocker: connecting to real (or demo) cTrader accounts ' +
      'requires the platform cTrader Open API application credentials ' +
      '(CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET), which can only be obtained ' +
      'after Spotware partner approval of the platform application; without ' +
      'them every connection fails closed. Production-LIVE is UNVERIFIED.',
    adapterId: 'ctrader',
    status: BrokerAvailabilityStatus.BETA,
    // Task 48-B: adapter implemented + contract-tested; production-LIVE is
    // UNVERIFIED (no operator-attested evidence). LIVE fails closed
    // (isProductionLiveEligible === false) — BETA is DEMO-only until evidence.
    productionLiveVerification: { status: 'UNVERIFIED' },
    connectionRoutes: [BrokerConnectionRoute.CTRADER],
    capabilities: [
      BrokerCapability.ACCOUNT_READ,
      BrokerCapability.BALANCE_READ,
      BrokerCapability.POSITION_READ,
      BrokerCapability.ORDER_READ,
      BrokerCapability.HISTORY_READ,
      // Request/response pricing — NO MARKET_DATA_STREAMING (honest).
      BrokerCapability.MARKET_DATA,
      BrokerCapability.WEBSOCKET,
      BrokerCapability.OAUTH,
      BrokerCapability.CTRADER,
      BrokerCapability.DEMO,
      BrokerCapability.LIVE,
      BrokerCapability.ORDER_PLACEMENT,
      BrokerCapability.ORDER_MODIFICATION,
      BrokerCapability.CLOSE_ALL,
      BrokerCapability.MARGIN_CALCULATION,
    ],
    authenticationType: 'OAUTH',
    environments: ['DEMO', 'LIVE'],
    regions: [],
  },
  {
    id: 'pepperstone-ctrader',
    name: 'Pepperstone (via cTrader Open API — BETA)',
    description:
      'Pepperstone cTrader accounts reached through the shared universal ' +
      'cTrader Open API engine (adapterId ctrader — JSON over WebSocket). ' +
      'BETA: the adapter is implemented and contract-tested, but reaching ' +
      'real Pepperstone accounts additionally requires Pepperstone-side ' +
      'cTrader Open API approval for the platform application on top of the ' +
      'Spotware partner approval; production-LIVE is UNVERIFIED.',
    adapterId: 'ctrader',
    status: BrokerAvailabilityStatus.BETA,
    productionLiveVerification: { status: 'UNVERIFIED' },
    connectionRoutes: [BrokerConnectionRoute.CTRADER],
    capabilities: [
      BrokerCapability.ACCOUNT_READ,
      BrokerCapability.BALANCE_READ,
      BrokerCapability.POSITION_READ,
      BrokerCapability.ORDER_READ,
      BrokerCapability.HISTORY_READ,
      BrokerCapability.MARKET_DATA,
      BrokerCapability.WEBSOCKET,
      BrokerCapability.OAUTH,
      BrokerCapability.CTRADER,
      BrokerCapability.DEMO,
      BrokerCapability.LIVE,
      BrokerCapability.ORDER_PLACEMENT,
      BrokerCapability.ORDER_MODIFICATION,
      BrokerCapability.CLOSE_ALL,
      BrokerCapability.MARGIN_CALCULATION,
    ],
    authenticationType: 'OAUTH',
    environments: ['DEMO', 'LIVE'],
    regions: [],
  },
  {
    id: 'icmarkets-ctrader',
    name: 'IC Markets (via cTrader Open API — BETA)',
    description:
      'IC Markets cTrader accounts reached through the shared universal ' +
      'cTrader Open API engine (adapterId ctrader — JSON over WebSocket). ' +
      'BETA: the adapter is implemented and contract-tested, but reaching ' +
      'real IC Markets accounts additionally requires IC Markets-side ' +
      'cTrader Open API approval for the platform application on top of the ' +
      'Spotware partner approval; production-LIVE is UNVERIFIED.',
    adapterId: 'ctrader',
    status: BrokerAvailabilityStatus.BETA,
    productionLiveVerification: { status: 'UNVERIFIED' },
    connectionRoutes: [BrokerConnectionRoute.CTRADER],
    capabilities: [
      BrokerCapability.ACCOUNT_READ,
      BrokerCapability.BALANCE_READ,
      BrokerCapability.POSITION_READ,
      BrokerCapability.ORDER_READ,
      BrokerCapability.HISTORY_READ,
      BrokerCapability.MARKET_DATA,
      BrokerCapability.WEBSOCKET,
      BrokerCapability.OAUTH,
      BrokerCapability.CTRADER,
      BrokerCapability.DEMO,
      BrokerCapability.LIVE,
      BrokerCapability.ORDER_PLACEMENT,
      BrokerCapability.ORDER_MODIFICATION,
      BrokerCapability.CLOSE_ALL,
      BrokerCapability.MARGIN_CALCULATION,
    ],
    authenticationType: 'OAUTH',
    environments: ['DEMO', 'LIVE'],
    regions: [],
  },
];

/** Catalog fingerprint inputs — used by tests to detect silent catalog drift. */
export const BROKER_CATALOG_VERSION = 'v1';
