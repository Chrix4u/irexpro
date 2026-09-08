/**
 * IBrokerAdapter — Core broker integration interface for iRexPro.
 *
 * Every broker integration (MetaTrader 5, OANDA, cTrader, etc.) must implement
 * this interface in full. The Risk Engine and Execution Engine interact exclusively
 * through this interface — never through broker-specific code.
 *
 * CRITICAL RULES:
 * - Decrypted credentials are passed in-memory only; never logged, never persisted
 * - All monetary values use decimal strings — never JavaScript floats
 * - Every adapter must support DEMO mode
 * - DEMO mode must be validated before LIVE mode is enabled
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */
export interface IBrokerAdapter {
  readonly brokerId: string;
  readonly brokerName: string;
  readonly supportsDemo: boolean;

  /** Set operating mode. Must be called after instantiation. */
  setMode(mode: BrokerMode): void;

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  /**
   * Establish a connection using decrypted credentials.
   * Credentials are in-memory only and must never be logged.
   */
  connect(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult>;

  /** Gracefully disconnect. */
  disconnect(): Promise<void>;

  /**
   * Test credentials without persisting a connection.
   * Used during the connect-wizard validation step.
   */
  testConnection(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionTestResult>;

  /** Returns true if currently connected and healthy. */
  isConnected(): boolean;

  // ─── Account state ────────────────────────────────────────────────────────

  getAccountInfo(): Promise<BrokerAccountInfo>;
  getAccountBalance(): Promise<BrokerBalance>;
  getOpenPositions(): Promise<BrokerPosition[]>;
  getPositionById(externalOrderId: string): Promise<BrokerPosition | null>;

  /**
   * Calculate the required margin for a proposed order.
   *
   * Sprint 32 Gate 2: returns the margin that would be consumed if the order
   * were placed, based on the broker's instrument-specific margin rules,
   * contract size, current price, and leverage. Returns null if the adapter
   * cannot safely calculate the required margin (e.g., instrument not found,
   * price unavailable, or the broker does not support margin calculation).
   *
   * The Risk Engine uses this to compare requiredMargin vs available freeMargin
   * for LIVE execution. If this returns null, the Risk Engine fails closed.
   */
  getRequiredMargin(params: RequiredMarginParams): Promise<string | null>;

  // ─── Market data ──────────────────────────────────────────────────────────

  getInstrumentList(): Promise<BrokerInstrument[]>;
  getCurrentPrice(instrument: string): Promise<BrokerPrice>;
  getOHLCV(instrument: string, timeframe: string, count: number): Promise<OHLCV[]>;

  // ─── Order management ─────────────────────────────────────────────────────

  /**
   * Place a new order. idempotencyKey MUST be included in the broker comment
   * field to allow deduplication on the broker side.
   */
  placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult>;

  /** Modify SL/TP/trailing stop of an existing open order. */
  modifyOrder(
    externalOrderId: string,
    modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult>;

  /** Close an open position (fully or partially by lot size). */
  closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult>;

  /** Emergency close of ALL open positions. Used by kill switch. */
  closeAllOrders(): Promise<BrokerCloseAllResult>;

  // ─── Trade history ────────────────────────────────────────────────────────

  getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]>;

  // ─── Provider order state (Sprint 50 PR-4 — reconciliation read surface) ──

  /**
   * List OPEN (working) orders known to the provider for the connected
   * account — pending LIMIT/STOP/STOP_LIMIT orders plus market orders in
   * transient states. Does NOT include history (completed) orders.
   *
   * Reconciliation compares this list against internal non-terminal orders
   * to detect missing/unknown/stale order state. Adapters that cannot list
   * orders must throw (fail-closed) — never return a fabricated empty list.
   */
  listOrders(): Promise<BrokerOrderState[]>;

  /**
   * Look up a single provider order by its stable identifier — including
   * COMPLETED (history) orders. Returns null when the provider knows no
   * such order. Used to resolve uncertain execution results by stable
   * identifier (Directive §26) without re-submitting anything.
   */
  getOrderById(providerOrderId: string): Promise<BrokerOrderState | null>;
}

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum BrokerMode {
  DEMO = 'DEMO',
  LIVE = 'LIVE',
}

export enum BrokerConnectionStatus {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
  SUSPENDED = 'SUSPENDED',
}

// ─── Credential types (in-memory only) ───────────────────────────────────────

/**
 * Decrypted broker credentials.
 * NEVER persisted, NEVER logged, NEVER returned in any API response.
 * Held in memory only for the duration of the adapter call.
 */
export interface DecryptedBrokerCredentials {
  apiKey?: string;
  apiSecret?: string;
  accountId: string;
  serverUrl?: string;
  additionalParams?: Record<string, string>;
}

// ─── Connection types ────────────────────────────────────────────────────────

export interface BrokerConnectionResult {
  success: boolean;
  accountId: string;
  accountType: BrokerMode;
  currency: string;
  serverTime: Date;
  error?: string;
}

export interface BrokerConnectionTestResult {
  success: boolean;
  accountId?: string;
  accountType?: BrokerMode;
  currency?: string;
  errorCode?: string;
  errorMessage?: string;
}

// ─── Account types ────────────────────────────────────────────────────────────

export interface BrokerAccountInfo {
  accountId: string;
  currency: string;
  leverage: number;
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  marginLevel: string;
}

export interface BrokerBalance {
  balance: string;
  equity: string;
  currency: string;
  timestamp: Date;
}

// ─── Order types ──────────────────────────────────────────────────────────────

/** Parameters for calculating required margin for a proposed order. */
export interface RequiredMarginParams {
  instrument: string;
  lotSize: string;
  /** Direction may affect margin in some broker models. */
  direction: 'BUY' | 'SELL';
  /** Opaque provider account reference; memory-only and never audited. */
  connectionReference?: string;
}

export interface BrokerOrderRequest {
  idempotencyKey: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;
  stopLoss: string;
  takeProfit: string;
  comment?: string;
  /** Opaque provider account reference; memory-only and never audited. */
  connectionReference?: string;

  // ─── Sprint 50 PR-3 — normalized order model passthrough ──────────────────
  // All OPTIONAL for backward compatibility with market-only call sites.
  // Adapters that only support market orders must REJECT other kinds loudly
  // (fail-closed) rather than silently downgrading them to market orders.
  /** Default 'MARKET' when omitted. */
  orderKind?: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  /** Default 'GTC' when omitted. */
  timeInForce?: 'GTC' | 'DAY' | 'IOC' | 'FOK';
  /** Required for LIMIT / STOP_LIMIT (decimal string). */
  limitPrice?: string;
  /** Required for STOP / STOP_LIMIT (decimal string). */
  stopPrice?: string;
  /** Caller-supplied stable identifier — the provider-side dedup surface. */
  clientOrderId?: string;
}

export interface BrokerOrderModification {
  newStopLoss?: string;
  newTakeProfit?: string;
  newTrailingStop?: string;
}

export interface BrokerOrderResult {
  success: boolean;
  externalOrderId?: string;
  filledPrice?: string;
  /** Sprint 50 PR-3: filled quantity when the provider reports partial fills
   * (decimal string). When omitted on a FILLED result, orchestrators may
   * conservatively assume the full requested quantity was filled. */
  filledQuantity?: string;
  filledAt?: Date;
  status: 'FILLED' | 'PENDING' | 'REJECTED' | 'FAILED';
  brokerMessage?: string;
  rawResponse?: unknown;
}

export interface BrokerCloseAllResult {
  closedCount: number;
  failedCount: number;
  errors: string[];
}

// ─── Position / trade types ───────────────────────────────────────────────────

// ─── Provider order state (Sprint 50 PR-4 — reconciliation) ────────────────

/**
 * Provider-side view of ONE order (working or completed), normalized for
 * reconciliation. All quantities/prices are decimal strings — never floats.
 * `raw` is the provider payload retained in-memory only — never persisted.
 */
export interface BrokerOrderState {
  /** Provider-assigned order identifier (ticket number). */
  providerOrderId: string;
  /** Caller-supplied stable identifier, when the provider echoes it. */
  clientOrderId?: string | null;
  /** Normalized provider order state. UNKNOWN = unrecognized provider value
   * (fail-closed: reconciliation must NOT guess an interpretation). */
  status:
    | 'WORKING'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'CANCELLED'
    | 'REJECTED'
    | 'EXPIRED'
    | 'UNKNOWN';
  instrument: string;
  direction: 'BUY' | 'SELL';
  /** Requested quantity (lots, decimal string). */
  requestedQuantity: string;
  /** Filled quantity so far (lots, decimal string). */
  filledQuantity: string;
  /** Volume-weighted average fill price, when any fill occurred. */
  avgFillPrice?: string | null;
  orderKind?: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | null;
  limitPrice?: string | null;
  stopPrice?: string | null;
  timeInForce?: string | null;
  placedAt?: Date | null;
  /** When the order reached a terminal provider state, if known. */
  updatedAt?: Date | null;
  /** In-memory only — never logged or persisted. */
  raw?: unknown;
}

export interface BrokerPosition {
  externalOrderId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;
  openPrice: string;
  currentPrice: string;
  stopLoss: string;
  takeProfit: string;
  unrealisedPnl: string;
  openedAt: Date;
  commission: string;
  swap: string;
}

export interface BrokerClosedTrade {
  externalOrderId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;
  openPrice: string;
  closePrice: string;
  stopLoss: string;
  takeProfit: string;
  realisedPnl: string;
  openedAt: Date;
  closedAt: Date;
  commission: string;
  swap: string;
  closeReason: 'TP' | 'SL' | 'MANUAL' | 'SYSTEM' | 'UNKNOWN';
}

// ─── Market data types ────────────────────────────────────────────────────────

export interface BrokerInstrument {
  symbol: string;
  description: string;
  digits: number;
  minLot: string;
  maxLot: string;
  lotStep: string;
  contractSize: string;
}

export interface BrokerPrice {
  instrument: string;
  bid: string;
  ask: string;
  spread: string;
  timestamp: Date;
}

export interface OHLCV {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
