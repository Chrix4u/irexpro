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
 * - cTrader → NOT_STARTED / PARTNER_APPROVAL_REQUIRED (no adapter — OAuth app +
 *   partner approval required before any build; do not fabricate support)
 * - Pepperstone / IC Markets / FP Markets via cTrader → PARTNER_APPROVAL_REQUIRED
 *   (requires operator research + partner approval before any build — see
 *   docs/brokers/provider-matrix.md)
 *
 * PRODUCTION-LIVE VERIFICATION (architect Phase H): `status` describes
 * implementation evidence only — it is NOT production-LIVE approval. The
 * separate `productionLiveVerification` field records operator-attested
 * LIVE evidence; absent/UNVERIFIED fails closed (LIVE connections and
 * enable-live are rejected — BETA is DEMO-only). Only metatrader5 carries
 * VERIFIED evidence today.
 */

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
    name: 'cTrader Open API',
    description:
      'Multi-broker connector (Pepperstone, IC Markets, FP Markets and other ' +
      'cTrader-affiliated brokers). Requires OAuth app approval per broker. ' +
      'Adapter NOT implemented yet.',
    adapterId: null,
    status: BrokerAvailabilityStatus.PARTNER_APPROVAL_REQUIRED,
    connectionRoutes: [BrokerConnectionRoute.CTRADER],
    capabilities: [
      BrokerCapability.WEBSOCKET,
      BrokerCapability.OAUTH,
      BrokerCapability.DEMO,
      BrokerCapability.LIVE,
    ],
    authenticationType: 'OAUTH',
    environments: ['DEMO', 'LIVE'],
    regions: [],
  },
];

/** Catalog fingerprint inputs — used by tests to detect silent catalog drift. */
export const BROKER_CATALOG_VERSION = 'v1';
