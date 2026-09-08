/**
 * BrokerCapability — normalized capability model (Directive §M).
 *
 * Providers do NOT support identical functions. The UI/API must query
 * capabilities rather than guessing from the broker name.
 *
 * Grouped by concern:
 * - Data reads:     ACCOUNT_READ, BALANCE_READ, POSITION_READ, ORDER_READ, HISTORY_READ
 * - Market data:    MARKET_DATA, MARKET_DATA_STREAMING
 * - Auth models:    OAUTH, API_TOKEN, SESSION_AUTH
 * - Environments:   DEMO, LIVE
 * - Connectivity:   REST, WEBSOCKET, METATRADER, CTRADER, FIX, SDK
 * - Events:         WEBHOOKS, EVENT_STREAM
 * - Execution:      ORDER_PLACEMENT, ORDER_MODIFICATION, CLOSE_ALL, MARGIN_CALCULATION
 */

export enum BrokerCapability {
  // Read capabilities
  ACCOUNT_READ = 'ACCOUNT_READ',
  BALANCE_READ = 'BALANCE_READ',
  POSITION_READ = 'POSITION_READ',
  ORDER_READ = 'ORDER_READ',
  HISTORY_READ = 'HISTORY_READ',

  // Market data
  MARKET_DATA = 'MARKET_DATA',
  MARKET_DATA_STREAMING = 'MARKET_DATA_STREAMING',

  // Authentication models
  OAUTH = 'OAUTH',
  API_TOKEN = 'API_TOKEN',
  SESSION_AUTH = 'SESSION_AUTH',

  // Environments
  DEMO = 'DEMO',
  LIVE = 'LIVE',

  // Connectivity mechanisms (Directive §K — never assume MetaTrader-only)
  REST = 'REST',
  WEBSOCKET = 'WEBSOCKET',
  METATRADER = 'METATRADER',
  CTRADER = 'CTRADER',
  FIX = 'FIX',
  SDK = 'SDK',

  // Events
  WEBHOOKS = 'WEBHOOKS',
  EVENT_STREAM = 'EVENT_STREAM',

  // Execution
  ORDER_PLACEMENT = 'ORDER_PLACEMENT',
  ORDER_MODIFICATION = 'ORDER_MODIFICATION',
  CLOSE_ALL = 'CLOSE_ALL',
  MARGIN_CALCULATION = 'MARGIN_CALCULATION',
}

export const BROKER_CAPABILITIES: readonly BrokerCapability[] = Object.values(BrokerCapability);
