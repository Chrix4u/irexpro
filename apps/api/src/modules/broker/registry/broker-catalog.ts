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
 * - metatrader5  → SUPPORTED (full IBrokerAdapter via MetaApi, tested)
 * - paper-broker → SUPPORTED (deterministic simulation adapter, tested; cannot go LIVE)
 * - OANDA / cTrader → NOT_STARTED (no adapter exists — registry comments in
 *   broker.module.ts are the only trace; do not fabricate support)
 * - Pepperstone / IC Markets / FP Markets via cTrader → PARTNER_APPROVAL_REQUIRED
 *   (requires operator research + partner approval before any build — see
 *   docs/brokers/provider-matrix.md)
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
    name: 'OANDA',
    description: 'Native REST + streaming v20 API. Research complete; adapter NOT implemented yet.',
    adapterId: null,
    status: BrokerAvailabilityStatus.NOT_STARTED,
    connectionRoutes: [BrokerConnectionRoute.NATIVE_API],
    capabilities: [
      BrokerCapability.REST,
      BrokerCapability.WEBSOCKET,
      BrokerCapability.API_TOKEN,
      BrokerCapability.DEMO,
      BrokerCapability.LIVE,
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
