/**
 * cTrader Open API message model (Sprint 56 / Task 47-C2; re-integrated onto
 * the Sprint 50/51 broker contracts as Task 48-B).
 *
 * PROTOCOL FACTS (verified against the official .proto set — see
 * /home/z/ctrader-research-47B1/ + worklog 47-B1):
 * - JSON-over-WebSocket framing on port 5036 ONLY:
 *     { "clientMsgId": "<uuid>", "payloadType": <int>, "payload": { ... } }
 *   `clientMsgId` is ECHOED in the response to a request — request↔response
 *   matching is done on that echo. There is no length-prefix framing.
 * - camelCase JSON field names mirror the .proto field names exactly.
 * - Heartbeat: payloadType 51 (ProtoHeartbeatEvent) at least every 10 s.
 * - Rate limits: 50 req/s/connection general, 5 req/s historical
 *   (DealList/OrderList/Trendbars/TickData).
 * - Volume is in CENTS (0.01 units): 1 000 000 cents = 10 000 units;
 *   1 standard FX lot (100 000 units) = 10 000 000 cents.
 * - Spot prices (bid/ask) and relative SL/TP are in 1/100 000 of a price unit.
 * - Monetary int64 fields (balance, commission, margin, PnL…) carry an
 *   exponent via `moneyDigits`: real value = field / 10^moneyDigits.
 *
 * DESIGN RULES for this module:
 * - PURE functions and constants only (unit-testable, no I/O, no DI).
 * - ALL money/price/volume conversions use BigInt/string math — NEVER floats.
 * - int64 ids arriving as JSON numbers are guarded with Number.isSafeInteger;
 *   an unsafe id throws a typed BROKER_SERVER_ERROR (never silent corruption).
 * - The cTrader → BrokerErrorCode mapper lives HERE (single place, tested);
 *   every raw provider text is sanitized through redactString before it can
 *   enter a BrokerAdapterError field.
 */
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import { redactString } from '../../../../common/utils/redact-sensitive.util';

// ─── Payload types (ProtoOAPayloadType / ProtoPayloadType values) ─────────────

export const CTRADER_PAYLOAD_TYPE = {
  // common
  PROTO_ERROR_RES: 50,
  HEARTBEAT_EVENT: 51,
  // auth
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  // orders
  NEW_ORDER_REQ: 2106,
  CANCEL_ORDER_REQ: 2108,
  AMEND_ORDER_REQ: 2109,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ: 2111,
  // symbols
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  ASSET_LIST_REQ: 2112,
  ASSET_LIST_RES: 2113,
  // account
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  // spots
  SUBSCRIBE_SPOTS_REQ: 2127,
  SUBSCRIBE_SPOTS_RES: 2128,
  UNSUBSCRIBE_SPOTS_REQ: 2129,
  UNSUBSCRIBE_SPOTS_RES: 2130,
  SPOT_EVENT: 2131,
  // errors / history
  ORDER_ERROR_EVENT: 2132,
  DEAL_LIST_REQ: 2133,
  DEAL_LIST_RES: 2134,
  GET_TRENDBARS_REQ: 2137,
  GET_TRENDBARS_RES: 2138,
  EXPECTED_MARGIN_REQ: 2139,
  EXPECTED_MARGIN_RES: 2140,
  OA_ERROR_RES: 2142,
  // token / discovery
  GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: 2150,
  // order-state reconciliation surface (Sprint 50 PR-4 port, Task 48-B):
  // ProtoOAOrderListReq/Res (timestamp-filtered order history) and
  // ProtoOAOrderDetailsReq/Res (single order + its deals, INCLUDING completed
  // orders — the getOrderById surface).
  ORDER_LIST_REQ: 2175,
  ORDER_LIST_RES: 2176,
  ORDER_DETAILS_REQ: 2181,
  ORDER_DETAILS_RES: 2182,
  GET_POSITION_UNREALIZED_PNL_REQ: 2187,
  GET_POSITION_UNREALIZED_PNL_RES: 2188,
  // ticks (historical rate-limit class)
  GET_TICKDATA_REQ: 2145,
} as const;

/**
 * Historical payload types — cTrader enforces 5 req/s for these (vs 50 req/s
 * general) per connection.
 */
export const CTRADER_HISTORICAL_PAYLOAD_TYPES: ReadonlySet<number> = new Set<number>([
  CTRADER_PAYLOAD_TYPE.DEAL_LIST_REQ,
  CTRADER_PAYLOAD_TYPE.GET_TRENDBARS_REQ,
  CTRADER_PAYLOAD_TYPE.GET_TICKDATA_REQ,
  CTRADER_PAYLOAD_TYPE.ORDER_LIST_REQ,
]);

// ─── Environments / hosts (DEMO and LIVE are FULLY separated) ─────────────────

export type CtraderEnvironment = 'DEMO' | 'LIVE';

/**
 * JSON-WebSocket endpoints (port 5036 — JSON ONLY; 5035 is protobuf).
 * DEMO/LIVE isolation is a HARD invariant: the environment decides the host
 * and the two environments never share a connection.
 */
export const CTRADER_ENVIRONMENT_URLS: Readonly<Record<CtraderEnvironment, string>> = {
  DEMO: 'wss://demo.ctraderapi.com:5036',
  LIVE: 'wss://live.ctraderapi.com:5036',
};

// ─── Protocol enums (numeric values from the official .proto files) ──────────

/** ProtoOAOrderType */
export const CtraderOrderType = {
  MARKET: 1,
  LIMIT: 2,
  STOP: 3,
  STOP_LOSS_TAKE_PROFIT: 4,
  MARKET_RANGE: 5,
  STOP_LIMIT: 6,
} as const;

/** ProtoOATradeSide */
export const CtraderTradeSide = {
  BUY: 1,
  SELL: 2,
} as const;

/** ProtoOATimeInForce */
export const CtraderTimeInForce = {
  GOOD_TILL_DATE: 1,
  GOOD_TILL_CANCEL: 2,
  IMMEDIATE_OR_CANCEL: 3,
  FILL_OR_KILL: 4,
  MARKET_ON_OPEN: 5,
} as const;

/** ProtoOAExecutionType */
export const CtraderExecutionType = {
  ORDER_ACCEPTED: 2,
  ORDER_FILLED: 3,
  ORDER_REPLACED: 4,
  ORDER_CANCELLED: 5,
  ORDER_EXPIRED: 6,
  ORDER_REJECTED: 7,
  ORDER_CANCEL_REJECTED: 8,
  SWAP: 9,
  DEPOSIT_WITHDRAW: 10,
  ORDER_PARTIAL_FILL: 11,
} as const;

/** ProtoOAOrderStatus */
export const CtraderOrderStatus = {
  ORDER_STATUS_ACCEPTED: 1,
  ORDER_STATUS_FILLED: 2,
  ORDER_STATUS_REJECTED: 3,
  ORDER_STATUS_EXPIRED: 4,
  ORDER_STATUS_CANCELLED: 5,
} as const;

/** ProtoOAPositionStatus */
export const CtraderPositionStatus = {
  POSITION_STATUS_OPEN: 1,
  POSITION_STATUS_CLOSED: 2,
  POSITION_STATUS_CREATED: 3,
  POSITION_STATUS_ERROR: 4,
} as const;

/** ProtoOADealStatus */
export const CtraderDealStatus = {
  FILLED: 2,
  PARTIALLY_FILLED: 3,
  REJECTED: 4,
  INTERNALLY_REJECTED: 5,
  ERROR: 6,
  MISSED: 7,
} as const;

/** ProtoOATrendbarPeriod (M1=1 … MN1=14) */
export const CTRADER_TRENDBAR_PERIODS: Readonly<Record<string, number>> = {
  M1: 1,
  M2: 2,
  M3: 3,
  M4: 4,
  M5: 5,
  M10: 6,
  M15: 7,
  M30: 8,
  H1: 9,
  H4: 10,
  H12: 11,
  D1: 12,
  W1: 13,
  MN1: 14,
};

// ─── Wire message shapes (camelCase JSON, exactly the .proto field names) ─────

/** JSON envelope used in BOTH directions on port 5036. */
export interface CtraderMessageEnvelope {
  clientMsgId?: string;
  payloadType: number;
  payload?: Record<string, unknown> | null;
}

export interface CtraderApplicationAuthReqPayload {
  clientId: string;
  clientSecret: string;
}

export interface CtraderAccountAuthReqPayload {
  ctidTraderAccountId: number;
  accessToken: string;
}

/** ProtoOACtidTraderAccount (account discovery, 2150). */
export interface CtraderCtidTraderAccount {
  ctidTraderAccountId: number;
  isLive?: boolean;
  traderLogin?: number;
  brokerTitleShort?: string;
}

export interface CtraderDiscoveredAccount {
  ctidTraderAccountId: number;
  isLive: boolean;
  traderLogin?: number;
  brokerTitleShort?: string;
}

/** ProtoOATradeData */
export interface CtraderTradeData {
  symbolId: number;
  volume: number;
  tradeSide: number;
  openTimestamp?: number;
  label?: string;
  comment?: string;
  closeTimestamp?: number;
}

/** ProtoOAPosition */
export interface CtraderPosition {
  positionId: number;
  tradeData: CtraderTradeData;
  positionStatus: number;
  swap: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  commission?: number;
  usedMargin?: number;
  moneyDigits?: number;
  guaranteedStopLoss?: boolean;
  trailingStopLoss?: boolean;
}

/** ProtoOAOrder */
export interface CtraderOrder {
  orderId: number;
  tradeData: CtraderTradeData;
  orderType: number;
  orderStatus: number;
  expirationTimestamp?: number;
  executionPrice?: number;
  executedVolume?: number;
  /** Unix ms of the last order update (proto field 9). */
  utcLastUpdateTimestamp?: number;
  limitPrice?: number;
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  clientOrderId?: string;
  positionId?: number;
  timeInForce?: number;
}

/** ProtoOAClosePositionDetail */
export interface CtraderClosePositionDetail {
  entryPrice: number;
  grossProfit: number;
  swap: number;
  commission: number;
  balance: number;
  closedVolume?: number;
  moneyDigits?: number;
}

/** ProtoOADeal */
export interface CtraderDeal {
  dealId: number;
  orderId: number;
  positionId: number;
  volume: number;
  filledVolume: number;
  symbolId: number;
  createTimestamp: number;
  executionTimestamp: number;
  executionPrice?: number;
  tradeSide: number;
  dealStatus: number;
  commission?: number;
  closePositionDetail?: CtraderClosePositionDetail;
  moneyDigits?: number;
}

/** ProtoOAExecutionEvent (2126) — the ASYNC response to order requests. */
export interface CtraderExecutionEventPayload {
  ctidTraderAccountId: number;
  executionType: number;
  position?: CtraderPosition;
  order?: CtraderOrder;
  deal?: CtraderDeal;
  errorCode?: string;
  isServerEvent?: boolean;
}

/** ProtoOATrader (2122). */
export interface CtraderTrader {
  ctidTraderAccountId: number;
  balance: number;
  depositAssetId: number;
  leverageInCents?: number;
  accountType?: number;
  brokerName?: string;
  moneyDigits?: number;
  traderLogin?: number;
}

/** ProtoOALightSymbol (2115). */
export interface CtraderLightSymbol {
  symbolId: number;
  symbolName?: string;
  enabled?: boolean;
  description?: string;
}

/** ProtoOASymbol (2117) — volume fields are in CENTS; lotSize in CENTS. */
export interface CtraderSymbol {
  symbolId: number;
  digits?: number;
  pipPosition?: number;
  maxVolume?: number;
  minVolume?: number;
  stepVolume?: number;
  lotSize?: number;
  tradingMode?: number;
}

/** ProtoOAAsset (2113). */
export interface CtraderAsset {
  assetId: number;
  name: string;
  displayName?: string;
  digits?: number;
}

/** ProtoOATrendbar (2138) — prices in 1/100 000, timestamp in MINUTES. */
export interface CtraderTrendbar {
  volume: number;
  low?: number;
  deltaOpen?: number;
  deltaClose?: number;
  deltaHigh?: number;
  utcTimestampInMinutes?: number;
}

/** ProtoOASpotEvent (2131) — bid/ask in 1/100 000 of a price unit. */
export interface CtraderSpotEventPayload {
  ctidTraderAccountId: number;
  symbolId: number;
  bid?: number;
  ask?: number;
  timestamp?: number;
}

/** ProtoOAPositionUnrealizedPnL (2188). */
export interface CtraderPositionUnrealizedPnl {
  positionId: number;
  grossUnrealizedPnL: number;
  netUnrealizedPnL: number;
}

// ─── Pure conversion helpers (string/BigInt math ONLY — never floats) ─────────

const SAFE_BIGINT_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_BIGINT_MAX = BigInt(Number.MAX_SAFE_INTEGER);

function toBigInt(value: number | bigint, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new BrokerAdapterError(
    BrokerErrorCode.BROKER_SERVER_ERROR,
    `cTrader field "${field}" is not a safe integer (${String(value)}) — refusing to corrupt the value.`,
  );
}

function assertSafeIntegerRange(value: bigint, field: string): number {
  if (value < SAFE_BIGINT_MIN || value > SAFE_BIGINT_MAX) {
    throw new BrokerAdapterError(
      BrokerErrorCode.BROKER_SERVER_ERROR,
      `cTrader field "${field}" exceeds the safe integer range — refusing to corrupt the value.`,
    );
  }
  return Number(value);
}

/**
 * Parses an int64 id that arrives as a JSON number (cTrader JSON) or as a
 * digit-string (defensive). Unsafe ids throw a typed BROKER_SERVER_ERROR —
 * ids are NEVER silently truncated.
 */
export function parseCtraderId(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new BrokerAdapterError(
        BrokerErrorCode.BROKER_SERVER_ERROR,
        `cTrader id field "${field}" is not a safe integer (${value}).`,
      );
    }
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return assertSafeIntegerRange(BigInt(value), field);
  }
  throw new BrokerAdapterError(
    BrokerErrorCode.BROKER_SERVER_ERROR,
    `cTrader id field "${field}" has an unusable shape (${typeof value}).`,
  );
}

interface ScaledDecimal {
  digits: bigint;
  scale: number;
  negative: boolean;
}

function parseDecimalString(value: string, field: string): ScaledDecimal {
  if (typeof value !== 'string') {
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_LOT_SIZE,
      `Field "${field}" must be a decimal string (received ${typeof value}).`,
    );
  }
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_LOT_SIZE,
      `Field "${field}" is not a decimal string: "${value}".`,
    );
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const digits = BigInt(intPart + fracPart);
  return { digits, scale: fracPart.length, negative };
}

/**
 * Converts a lot size (decimal string, e.g. "0.10") into cTrader volume CENTS
 * using the SYMBOL's lotSize (in cents, e.g. 10 000 000 for a 100 000-unit FX
 * lot). Exact BigInt math; non-representable or out-of-range volumes throw
 * INVALID_LOT_SIZE (fail-closed, never rounded).
 *
 *   unitsToVolumeCents('1.5', 10_000_000) → 15 000 000
 */
export function unitsToVolumeCents(lotSize: string, symbolLotSizeCents: number | bigint): number {
  const lot = toBigInt(symbolLotSizeCents, 'symbolLotSizeCents');
  if (lot <= 0n) {
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_INSTRUMENT,
      'Symbol lot size must be positive to convert volume.',
    );
  }
  const { digits, scale, negative } = parseDecimalString(lotSize, 'lotSize');
  const scaled = digits * lot;
  const divisor = 10n ** BigInt(scale);
  if (scaled % divisor !== 0n) {
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_LOT_SIZE,
      `Lot size "${lotSize}" is not representable in whole volume cents for this symbol.`,
    );
  }
  const cents = negative ? -(scaled / divisor) : scaled / divisor;
  return assertSafeIntegerRange(cents, 'volume');
}

/** Fractional digit budget for lot-string conversion (see volumeCentsToLotString). */
const LOT_STRING_SCALE_DIGITS = 12;

/**
 * Converts volume CENTS into a lot-size decimal string using the SYMBOL's
 * lotSize (in cents). Exact BigInt long-division for every terminating
 * decimal; non-terminating denominators are rounded half-up at the 12th
 * fractional digit (documented — real cTrader lot sizes are powers of ten
 * times 1/2/5, which always terminate).
 *
 *   volumeCentsToLotString(15_000_000, 10_000_000) → "1.5"
 *   volumeCentsToLotString(1_000_000, 10_000_000) → "0.1"
 */
export function volumeCentsToLotString(
  volumeCents: number | bigint,
  symbolLotSizeCents: number | bigint,
): string {
  const volume = toBigInt(volumeCents, 'volumeCents');
  const lot = toBigInt(symbolLotSizeCents, 'symbolLotSizeCents');
  if (lot <= 0n) {
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_INSTRUMENT,
      'Symbol lot size must be positive to convert volume.',
    );
  }
  const negative = volume < 0n;
  const abs = negative ? -volume : volume;
  // Half-up rounding at LOT_STRING_SCALE_DIGITS fractional digits:
  // q = round(abs * 10^12 / lot)
  const scale = 10n ** BigInt(LOT_STRING_SCALE_DIGITS);
  const q = (abs * scale * 2n + lot) / (2n * lot);
  const digits = q.toString().padStart(LOT_STRING_SCALE_DIGITS + 1, '0');
  const whole = digits.slice(0, -LOT_STRING_SCALE_DIGITS);
  const frac = digits.slice(-LOT_STRING_SCALE_DIGITS).replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (frac ? `.${frac}` : '');
}

/**
 * Converts a spot value (bid/ask/relative distance, in 1/100 000 of a price
 * unit) into an exact decimal string with 5 fractional digits (exact for
 * every integer ÷ 10^5).
 *
 *   spotToPrice(108650) → "1.08650"
 */
export function spotToPrice(value: number | bigint): string {
  const v = toBigInt(value, 'spotPrice');
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / 100000n;
  const frac = (abs % 100000n).toString().padStart(5, '0');
  return (negative ? '-' : '') + whole.toString() + '.' + frac;
}

/**
 * Mid price of two spot values — exact: (bid + ask) / 2 needs at most one
 * extra fractional digit, so the result carries up to 6 fractional digits.
 */
export function spotMidPrice(bid: number | bigint, ask: number | bigint): string {
  const b = toBigInt(bid, 'bid');
  const a = toBigInt(ask, 'ask');
  // (b + a) / 2 in 1/100000 == (b + a) * 5 in 1/1 000 000
  const scaled = (b + a) * 5n;
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / 1000000n;
  const frac = (abs % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toString() + (frac ? `.${frac}` : '');
}

/**
 * Converts a monetary int64 (balance, commission, margin, PnL…) into a decimal
 * string using the field's moneyDigits exponent: value / 10^moneyDigits.
 * Exact for every int64 + exponent — string math only, never floats.
 *
 *   moneyToDecimalString(10_053_099_944, 8) → "100.53099944"
 */
export function moneyToDecimalString(value: number | bigint, moneyDigits: number): string {
  const v = toBigInt(value, 'money');
  const digits = Number.isInteger(moneyDigits) && moneyDigits >= 0 ? moneyDigits : 0;
  const divisor = 10n ** BigInt(digits);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / divisor;
  if (digits === 0) {
    return (negative ? '-' : '') + whole.toString();
  }
  const frac = (abs % divisor).toString().padStart(digits, '0');
  return (negative ? '-' : '') + whole.toString() + '.' + frac;
}

/**
 * Converts a price that arrived as a protocol DOUBLE (order executionPrice,
 * position VWAP price, limitPrice…) into a decimal string. Doubles are the
 * wire representation for those fields; the conversion only formats the
 * already-parsed number and fails closed on non-finite values.
 */
export function wirePriceToDecimalString(value: number | undefined | null): string {
  if (value === undefined || value === null) return '0';
  if (!Number.isFinite(value)) {
    throw new BrokerAdapterError(
      BrokerErrorCode.BROKER_SERVER_ERROR,
      'cTrader returned a non-finite price value — refusing to normalize it.',
    );
  }
  return String(value);
}

/**
 * Idempotency propagation: the idempotencyKey is embedded in ALL THREE
 * cTrader free-text fields (clientOrderId ≤50, label ≤100, comment ≤512 —
 * proto limits), truncated safely so a long key can never reject the order.
 */
export function buildIdempotencyFields(idempotencyKey: string): {
  clientOrderId: string;
  label: string;
  comment: string;
} {
  const key = idempotencyKey ?? '';
  return {
    clientOrderId: key.slice(0, 50),
    label: key.slice(0, 100),
    comment: key.slice(0, 512),
  };
}

/** Converts a decimal-string price into the protocol double for the wire. */
export function decimalStringToWirePrice(value: string, field: string): number {
  const { digits, scale, negative } = parseDecimalString(value, field);
  const scaled = Number(digits) / 10 ** scale;
  const price = negative ? -scaled : scaled;
  if (!Number.isFinite(price) || price <= 0) {
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_PRICE,
      `Field "${field}" is not a positive price: "${value}".`,
    );
  }
  return price;
}

// ─── Time-in-force mapping (normalized union ⇄ ProtoOATimeInForce) ───────────

/** Normalized timeInForce union from the IBrokerAdapter contract. */
export type CtraderContractTimeInForce = 'GTC' | 'DAY' | 'IOC' | 'FOK';

/**
 * Maps the contract's timeInForce union onto ProtoOATimeInForce values:
 * GTC → GOOD_TILL_CANCEL(2); DAY → GOOD_TILL_DATE(1) (the adapter supplies
 * the end-of-day expirationTimestamp); IOC → IMMEDIATE_OR_CANCEL(3);
 * FOK → FILL_OR_KILL(4). Unknown values fail closed with INVALID_ORDER_TYPE
 * (never silently coerced).
 */
export function contractTimeInForceToProto(timeInForce: CtraderContractTimeInForce): number {
  switch (timeInForce) {
    case 'GTC':
      return CtraderTimeInForce.GOOD_TILL_CANCEL;
    case 'DAY':
      return CtraderTimeInForce.GOOD_TILL_DATE;
    case 'IOC':
      return CtraderTimeInForce.IMMEDIATE_OR_CANCEL;
    case 'FOK':
      return CtraderTimeInForce.FILL_OR_KILL;
    default:
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_ORDER_TYPE,
        `Unsupported timeInForce "${String(timeInForce)}" for a cTrader order.`,
      );
  }
}

/**
 * Maps a ProtoOATimeInForce number onto the contract's timeInForce string.
 * MARKET_ON_OPEN has no normalized-union equivalent and is reported by its
 * protocol name (the read surface types timeInForce as string | null).
 */
export function protoTimeInForceToString(value: number | undefined): string | null {
  if (value === undefined || value === null) return null;
  switch (value) {
    case CtraderTimeInForce.GOOD_TILL_CANCEL:
      return 'GTC';
    case CtraderTimeInForce.GOOD_TILL_DATE:
      return 'DAY';
    case CtraderTimeInForce.IMMEDIATE_OR_CANCEL:
      return 'IOC';
    case CtraderTimeInForce.FILL_OR_KILL:
      return 'FOK';
    case CtraderTimeInForce.MARKET_ON_OPEN:
      return 'MARKET_ON_OPEN';
    default:
      // Unrecognized provider value — surfaced verbatim, never guessed.
      return String(value);
  }
}

// ─── cTrader error-code mapping (ONE place, shared by client + adapter) ───────

/** Name → BrokerErrorCode. Wire error codes are NAMES (string errorCode field). */
const CTRADER_ERROR_NAME_TO_BROKER: Readonly<Record<string, BrokerErrorCode>> = {
  // authentication / authorization
  OA_AUTH_TOKEN_EXPIRED: BrokerErrorCode.AUTHENTICATION_FAILED,
  ACCOUNT_NOT_AUTHORIZED: BrokerErrorCode.AUTHENTICATION_FAILED,
  RET_NO_SUCH_LOGIN: BrokerErrorCode.AUTHENTICATION_FAILED,
  RET_ACCOUNT_DISABLED: BrokerErrorCode.AUTHENTICATION_FAILED,
  CH_CLIENT_AUTH_FAILURE: BrokerErrorCode.AUTHENTICATION_FAILED,
  CH_CLIENT_NOT_AUTHENTICATED: BrokerErrorCode.AUTHENTICATION_FAILED,
  CH_CLIENT_ALREADY_AUTHENTICATED: BrokerErrorCode.AUTHENTICATION_FAILED,
  CH_ACCESS_TOKEN_INVALID: BrokerErrorCode.AUTHENTICATION_FAILED,
  CH_CTID_TRADER_ACCOUNT_NOT_FOUND: BrokerErrorCode.AUTHENTICATION_FAILED,
  CH_OA_CLIENT_NOT_FOUND: BrokerErrorCode.AUTHENTICATION_FAILED,
  CH_SERVER_NOT_REACHABLE: BrokerErrorCode.CONNECTION_LOST,
  // rate limits / maintenance / connection caps
  REQUEST_FREQUENCY_EXCEEDED: BrokerErrorCode.RATE_LIMITED,
  BLOCKED_PAYLOAD_TYPE: BrokerErrorCode.RATE_LIMITED,
  CONNECTIONS_LIMIT_EXCEEDED: BrokerErrorCode.RATE_LIMITED,
  SERVER_IS_UNDER_MAINTENANCE: BrokerErrorCode.BROKER_SERVER_ERROR,
  CANT_ROUTE_REQUEST: BrokerErrorCode.CONNECTION_LOST,
  TIMEOUT_ERROR: BrokerErrorCode.CONNECTION_TIMEOUT,
  // instruments
  SYMBOL_NOT_FOUND: BrokerErrorCode.INVALID_INSTRUMENT,
  UNKNOWN_SYMBOL: BrokerErrorCode.INVALID_INSTRUMENT,
  // volume / money
  TRADING_BAD_VOLUME: BrokerErrorCode.INVALID_LOT_SIZE,
  TRADING_BAD_STAKE: BrokerErrorCode.INVALID_LOT_SIZE,
  NOT_ENOUGH_MONEY: BrokerErrorCode.INSUFFICIENT_MARGIN,
  MAX_EXPOSURE_REACHED: BrokerErrorCode.INSUFFICIENT_MARGIN,
  // not found
  POSITION_NOT_FOUND: BrokerErrorCode.POSITION_NOT_FOUND,
  ORDER_NOT_FOUND: BrokerErrorCode.POSITION_NOT_FOUND,
  POSITION_NOT_OPEN: BrokerErrorCode.POSITION_NOT_FOUND,
  // market state
  MARKET_CLOSED: BrokerErrorCode.MARKET_CLOSED,
  TRADING_DISABLED: BrokerErrorCode.MARKET_CLOSED,
  SYMBOL_HAS_HOLIDAY: BrokerErrorCode.MARKET_CLOSED,
  NO_QUOTES: BrokerErrorCode.MARKET_CLOSED,
  // invalid order parameters (provider rejected the request payload itself)
  TRADING_BAD_STOPS: BrokerErrorCode.INVALID_REQUEST,
  TRADING_BAD_PRICES: BrokerErrorCode.INVALID_REQUEST,
  TRADING_BAD_EXPIRATION_DATE: BrokerErrorCode.INVALID_REQUEST,
  PROTECTION_IS_TOO_CLOSE_TO_MARKET: BrokerErrorCode.INVALID_REQUEST,
  WORSE_GSL_NOT_ALLOWED: BrokerErrorCode.INVALID_REQUEST,
  // transient broker-side conditions
  PENDING_EXECUTION: BrokerErrorCode.BROKER_SERVER_ERROR,
  CONCURRENT_MODIFICATION: BrokerErrorCode.BROKER_SERVER_ERROR,
};

/**
 * Numeric fallback for callers that only have an int (the enum VALUES in the
 * .proto files). Only UNAMBIGUOUS numbers across the ProtoOAErrorCode /
 * ProtoErrorCode namespaces are listed — colliding numbers are resolved by
 * name only (the wire carries names).
 */
const CTRADER_ERROR_NUMBER_TO_NAME: Readonly<Record<number, string>> = {
  9: 'MARKET_CLOSED', // ProtoErrorCode
  11: 'BLOCKED_PAYLOAD_TYPE', // ProtoErrorCode
  14: 'ALREADY_LOGGED_IN',
  64: 'RET_ACCOUNT_DISABLED',
  67: 'CONNECTIONS_LIMIT_EXCEEDED',
  101: 'CH_CLIENT_AUTH_FAILURE',
  102: 'CH_CLIENT_NOT_AUTHENTICATED',
  104: 'CH_ACCESS_TOKEN_INVALID',
  106: 'CH_CTID_TRADER_ACCOUNT_NOT_FOUND',
  108: 'REQUEST_FREQUENCY_EXCEEDED',
  109: 'SERVER_IS_UNDER_MAINTENANCE',
  114: 'SYMBOL_NOT_FOUND',
  115: 'UNKNOWN_SYMBOL',
  117: 'NO_QUOTES',
  118: 'NOT_ENOUGH_MONEY',
  119: 'MAX_EXPOSURE_REACHED',
  120: 'POSITION_NOT_FOUND',
  121: 'ORDER_NOT_FOUND',
  122: 'POSITION_NOT_OPEN',
  123: 'POSITION_LOCKED',
  124: 'TOO_MANY_POSITIONS',
  125: 'TRADING_BAD_VOLUME',
  126: 'TRADING_BAD_STOPS',
  127: 'TRADING_BAD_PRICES',
  129: 'PROTECTION_IS_TOO_CLOSE_TO_MARKET',
  131: 'PENDING_EXECUTION',
  132: 'TRADING_DISABLED',
  133: 'TRADING_NOT_ALLOWED',
  134: 'UNABLE_TO_CANCEL_ORDER',
  135: 'UNABLE_TO_AMEND_ORDER',
};

/**
 * Maps a cTrader error code (name string per the wire, or the enum number as
 * a defensive fallback) + description into a typed BrokerAdapterError.
 * Provider text is REDACTED before entering any error field.
 */
export function mapCtraderError(
  errorCode: string | number | undefined | null,
  description?: string | null,
): BrokerAdapterError {
  const name =
    typeof errorCode === 'number'
      ? CTRADER_ERROR_NUMBER_TO_NAME[errorCode]
      : typeof errorCode === 'string' && errorCode.trim() !== ''
        ? errorCode.trim().toUpperCase()
        : undefined;

  const mappedCode = name ? CTRADER_ERROR_NAME_TO_BROKER[name] : undefined;
  const brokerCode = mappedCode ?? BrokerErrorCode.UNKNOWN;
  const sanitizedDescription =
    typeof description === 'string' && description.trim() !== ''
      ? redactString(description.trim())
      : undefined;
  const message = sanitizedDescription ?? `cTrader error: ${name ?? 'UNKNOWN'}`;
  const retryable =
    brokerCode === BrokerErrorCode.RATE_LIMITED ||
    brokerCode === BrokerErrorCode.CONNECTION_TIMEOUT ||
    brokerCode === BrokerErrorCode.BROKER_SERVER_ERROR ||
    brokerCode === BrokerErrorCode.CONNECTION_LOST;
  return new BrokerAdapterError(brokerCode, message, message, retryable);
}

/** True when the cTrader error name is the benign "already authorized" case. */
export function isAlreadyAuthorizedError(errorCode: string | number | undefined | null): boolean {
  const name =
    typeof errorCode === 'number'
      ? (CTRADER_ERROR_NUMBER_TO_NAME[errorCode] ?? '')
      : String(errorCode ?? '');
  return name.toUpperCase() === 'ALREADY_LOGGED_IN';
}

/**
 * Narrows a response envelope to the expected payload type; any other shape
 * fails closed with a typed BROKER_SERVER_ERROR (never a silent undefined).
 * The returned payload is the raw JSON object — required fields (ids, money)
 * must still be read through the guarded helpers (parseCtraderId / money…).
 */
export function expectCtraderPayload<T>(
  envelope: CtraderMessageEnvelope,
  expectedPayloadType: number,
): T {
  if (envelope.payloadType !== expectedPayloadType || envelope.payload == null) {
    throw new BrokerAdapterError(
      BrokerErrorCode.BROKER_SERVER_ERROR,
      `Unexpected cTrader response: expected payloadType ${expectedPayloadType}, ` +
        `received ${envelope.payloadType}.`,
    );
  }
  return envelope.payload as T;
}

// ─── Exact decimal-string arithmetic (money sums/differences — no floats) ─────

function formatScaledInteger(digits: bigint, scale: number): string {
  const negative = digits < 0n;
  const abs = negative ? -digits : digits;
  if (scale === 0) {
    return (negative ? '-' : '') + abs.toString();
  }
  const pow = 10n ** BigInt(scale);
  const whole = abs / pow;
  const frac = (abs % pow).toString().padStart(scale, '0');
  return (negative ? '-' : '') + whole.toString() + '.' + frac;
}

function alignScales(
  a: ScaledDecimal,
  b: ScaledDecimal,
): { digitsA: bigint; digitsB: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  const digitsA = a.digits * 10n ** BigInt(scale - a.scale);
  const digitsB = b.digits * 10n ** BigInt(scale - b.scale);
  return { digitsA, digitsB, scale };
}

function parseMoneyDecimal(value: string, field: string): ScaledDecimal {
  return parseDecimalString(value, field);
}

/** Exact addition of two decimal strings (money). */
export function addDecimalStrings(a: string, b: string): string {
  const sa = parseMoneyDecimal(a, 'a');
  const sb = parseMoneyDecimal(b, 'b');
  const { digitsA, digitsB, scale } = alignScales(sa, sb);
  const sum = (sa.negative ? -digitsA : digitsA) + (sb.negative ? -digitsB : digitsB);
  return formatScaledInteger(sum, scale);
}

/** Exact subtraction of two decimal strings (money). */
export function subtractDecimalStrings(a: string, b: string): string {
  const sa = parseMoneyDecimal(a, 'a');
  const sb = parseMoneyDecimal(b, 'b');
  const { digitsA, digitsB, scale } = alignScales(sa, sb);
  const diff = (sa.negative ? -digitsA : digitsA) - (sb.negative ? -digitsB : digitsB);
  return formatScaledInteger(diff, scale);
}

/**
 * (numerator / denominator) × 100 as a decimal string with 2 fractional
 * digits (half-up). Returns '0' when the denominator is zero — callers must
 * treat a zero denominator as "not computable" and surface it honestly.
 */
export function percentageRatioString(numerator: string, denominator: string): string {
  const sn = parseMoneyDecimal(numerator, 'numerator');
  const sd = parseMoneyDecimal(denominator, 'denominator');
  const { digitsA, digitsB } = alignScales(sn, sd);
  const num = sn.negative ? -digitsA : digitsA;
  const den = sd.negative ? -digitsB : digitsB;
  if (den === 0n) {
    return '0';
  }
  // ratio×100 rounded to 2 decimals: q = round(num * 10000 / den) / 100
  let scaledNumerator = num * 10000n;
  let absDen = den;
  if (absDen < 0n) {
    scaledNumerator = -scaledNumerator;
    absDen = -absDen;
  }
  const q = (scaledNumerator * 2n + absDen) / (2n * absDen);
  const sign = q < 0n ? '-' : '';
  const abs = q < 0n ? -q : q;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}
