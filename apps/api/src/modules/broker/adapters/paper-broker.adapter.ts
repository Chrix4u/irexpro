import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  BrokerAccountInfo,
  BrokerBalance,
  BrokerCloseAllResult,
  BrokerClosedTrade,
  BrokerConnectionResult,
  BrokerConnectionTestResult,
  BrokerInstrument,
  BrokerMode,
  BrokerOrderModification,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
  BrokerPosition,
  BrokerPrice,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
  OHLCV,
  RequiredMarginParams,
} from '../interfaces/broker-adapter.interface';
import type { OrderCapabilityDeclaration } from '../interfaces/order-capability';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import { ProviderDispatchCertainty } from '../interfaces/provider-dispatch-certainty';

/**
 * PaperBrokerAdapter — safe simulated broker for paper trading only.
 *
 * PAPER_ONLY:
 * - Never calls any external broker API.
 * - Never places real orders.
 * - Deterministic simulation (no Math.random, no Date.now — clock-injected).
 * - Cannot be enabled for live trading.
 * - liveTradingEnabled is always false.
 *
 * Sprint 50 PR-4 — HONEST PROVIDER STATE: the adapter tracks the orders and
 * positions it "fills" in-memory so its read surface (listOrders/
 * getOrderById/getOpenPositions/getPositionById/getClosedTrades/closeOrder)
 * reflects the simulated account truthfully. Reconciliation against a paper
 * connection therefore observes real (simulated) provider state.
 *
 * Sprint 51 PR-7 — CONTRACT-SUITE HARDENING: every data operation fails
 * closed with BrokerAdapterError(NOT_CONNECTED) before connect(), matching
 * the shared adapter contract suite (Directive §AN #1). The resting order
 * state carries the caller's clientOrderId (idempotencyKey fallback) so
 * idempotency passthrough is observable on the read surface.
 *
 * Sprint 56 paper-lifecycle (merged onto the new-main interface): the
 * adapter runs a REALISTIC, fully deterministic order lifecycle. Note that
 * capabilities are owned by the broker CATALOG (Directive §M) — the adapter
 * declares none itself; it truthfully implements the trading surface the
 * catalog attributes to it.
 *
 * ENGINE SEMANTICS (documented contract of the simulation):
 * - Single instrument EURUSD (bid/ask, 5 digits, fixed 1-pip spread).
 * - Determinism rules: the price walk is a fixed documented step sequence
 *   (constructor-injectable for specs); time comes from an injectable clock
 *   (default: fixed epoch + 1s per tick); ALL money math is exact BigInt
 *   decimal-string math — never floats, never Date.now, never Math.random.
 * - MARKET orders fill immediately at the quote MID — the deterministic
 *   '1.10005' paper fill pinned by the adapter's historical contract.
 *   Manual closes (closeOrder/closeAllOrders) also execute at the mid, so
 *   an open-and-close with no intervening tick books exactly flat P&L.
 * - LIMIT/STOP/STOP_LIMIT place WORKING orders (PENDING result) evaluated on
 *   every market tick: BUY LIMIT fills when ask ≤ limitPrice, SELL LIMIT when
 *   bid ≥ limitPrice, BUY STOP when ask ≥ stopPrice, SELL STOP when bid ≤
 *   stopPrice; STOP_LIMIT triggers like STOP and then fills like LIMIT — if
 *   the price moves away before the limit fill the order stays working (the
 *   honest stop-limit miss).
 * - Working-order fills execute at the prevailing quote side (BUY fills at
 *   the ask, SELL at the bid — never worse than a resting limit).
 * - SL/TP close exactly at the protection level (resting orders; the sim
 *   does not model stop-gap slippage on protection levels).
 * - Only getCurrentPrice() advances the market (one deterministic tick + one
 *   second of simulated time, then the evaluation engine runs). Account and
 *   position reads are pure snapshots — they never move the market, and
 *   placing orders never ticks it either.
 * - Per tick: existing positions' SL/TP are evaluated first (SL before TP —
 *   conservative), then working orders in placement order. A position created
 *   by a fill this tick is first evaluated on the NEXT tick.
 * - One order = one position (no netting, no VWAP on partial adds). Partial
 *   closes reduce the position and book a closed trade for the reduced part.
 * - Balance starts at 10,000.00 USD; realized P&L adjusts the balance;
 *   equity = balance + Σ rounded unrealized (the books reconcile); margin =
 *   units × entry price / 100 locked at fill, consistent with
 *   getRequiredMargin's lot × contractSize × price / leverage formula;
 *   money is rendered at 2 fractional digits (half-up).
 * - Margin realism: MARKET orders that cannot be covered by free margin fail
 *   closed with INSUFFICIENT_MARGIN; WORKING orders that cannot be covered at
 *   fill time transition to a terminal REJECTED state (no caller to notify).
 * - Idempotency: TRUE dedupe — a repeat placeOrder with the same
 *   clientOrderId (or idempotencyKey when no clientOrderId is supplied)
 *   returns the ORIGINAL placement result verbatim (no new order, no new
 *   fill). The key is stored on the internal order record and embedded in
 *   its synthesized comment field.
 * - cancelOrder is a CONCRETE method (not part of IBrokerAdapter — the
 *   interface carries no cancel surface; harnesses and specs narrow to the
 *   concrete class to cancel a pending order). Unknown/non-working ids map
 *   to POSITION_NOT_FOUND with a clear message (the BrokerErrorCode set has
 *   no ORDER_NOT_FOUND — documented honest choice, same mapping as the
 *   OANDA sibling).
 * - closeOrder on an unknown id fails honestly with a REJECTED result (no
 *   silent success); working-order ids are rejected with a pointer to
 *   cancelOrder.
 * - closeAllOrders closes POSITIONS only (kill-switch semantics: open
 *   exposure), books them as closeReason SYSTEM, and leaves working orders
 *   untouched — cancelOrder is the honest path for those.
 * - Connection lifecycle: paper-account state persists for the adapter
 *   instance's lifetime; reconnects (e.g. periodic health checks) never wipe
 *   orders, positions, history, or balance.
 *
 * Use cases:
 * - Paper-mode end-to-end signal pipeline tests
 * - Development/CI testing without real broker credentials
 * - Verifying the Strategy → Risk → Execution → Reconciliation pathway
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */

// ─── Deterministic simulation constants ──────────────────────────────────────

const PAPER_INSTRUMENT = 'EURUSD';
const PAPER_ACCOUNT_ID = 'paper-account-001';
const PAPER_CURRENCY = 'USD';
const PAPER_LEVERAGE = 100;
const PAPER_STARTING_BALANCE = '10000.00';
/** Money is rendered at 2 fractional digits (account currency, half-up). */
const PAPER_MONEY_SCALE = 2;
/** Price scale for EURUSD (5-digit pricing). */
const PAPER_PRICE_SCALE = 5;
/** Fixed 1-pip spread (in price-scale units): bid 1.10000 / ask 1.10010. */
const PAPER_SPREAD_UNITS = 10n;
/**
 * Default deterministic tick step sequence: alternating +2 / −1 pips per tick
 * (net +0.5 pips per tick — a slow upward drift). The feed is
 * constructor-injectable, so specs script falling sequences to exercise the
 * mirrored SELL-side paths.
 */
const PAPER_TICK_STEPS_UNITS = [20n, -10n];
/** Each market tick advances simulated time by one second. */
const PAPER_TICK_DURATION_MS = 1_000;
const PAPER_TIMEFRAME_MS: Record<string, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};
/** Fixed deterministic clock epoch (no Date.now — CI-stable). */
const PAPER_CLOCK_BASE_EPOCH_MS = Date.UTC(2024, 0, 2, 3, 4, 5);
const PAPER_CONTRACT_SIZE = '100000';
const PAPER_MIN_LOT = '0.01';
const PAPER_MAX_LOT = '100.00';
/** One lot = 100,000 units; one lot step (0.01) = 1,000 units. */
const PAPER_UNITS_PER_LOT = 100_000n;
const PAPER_UNITS_PER_LOT_STEP = 1_000n;

/** The normalized order kinds of the Sprint 50 PR-3 order model. */
type PaperOrderKind = NonNullable<BrokerOrderRequest['orderKind']>;

const PAPER_ORDER_KINDS: readonly PaperOrderKind[] = ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'];

// ─── Injectable simulation seams (feed + clock) ───────────────────────────────

/** A bid/ask quote as decimal strings (5-digit EURUSD pricing). */
export interface PaperQuote {
  bid: string;
  ask: string;
}

/**
 * Deterministic price feed seam. The adapter drives the market through
 * tick(); quote() is a pure read of the current (prevailing) quote.
 */
export abstract class PaperPriceFeed {
  /** Current quote without advancing the walk (pure read). */
  abstract quote(): PaperQuote;
  /** Advance the walk one deterministic step and return the new quote. */
  abstract tick(): PaperQuote;
}

/**
 * Default price feed: the classic 1.10000/1.10010 quote with a documented
 * deterministic step sequence (alternating +2/−1 pips per tick).
 */
export class DeterministicPaperPriceFeed extends PaperPriceFeed {
  private bidUnits = 110_000n; // 1.10000 in price-scale units
  private stepIndex = 0;

  quote(): PaperQuote {
    return this.format();
  }

  tick(): PaperQuote {
    this.bidUnits += PAPER_TICK_STEPS_UNITS[this.stepIndex % PAPER_TICK_STEPS_UNITS.length]!;
    this.stepIndex += 1;
    return this.format();
  }

  private format(): PaperQuote {
    return {
      bid: formatScaledDecimal(this.bidUnits, PAPER_PRICE_SCALE),
      ask: formatScaledDecimal(this.bidUnits + PAPER_SPREAD_UNITS, PAPER_PRICE_SCALE),
    };
  }
}

/** Deterministic clock seam (no Date.now anywhere in the engine). */
export abstract class PaperClock {
  /** Current simulated time (pure read). */
  abstract now(): Date;
  /** Advance simulated time by `ms` milliseconds. */
  abstract advance(ms: number): void;
}

/** Default clock: fixed epoch, advanced only by market ticks (1s per tick). */
export class DeterministicPaperClock extends PaperClock {
  private offsetMs = 0;

  now(): Date {
    return new Date(PAPER_CLOCK_BASE_EPOCH_MS + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += Math.max(0, Math.trunc(ms));
  }
}

// ─── Exact decimal-string arithmetic (BigInt only — never floats) ─────────────

interface ScaledDecimal {
  digits: bigint;
  scale: number;
  negative: boolean;
}

function parseScaledDecimal(value: string, field: string, code: BrokerErrorCode): ScaledDecimal {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new BrokerAdapterError(code, `Field "${field}" is not a decimal string: "${value}".`);
  }
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = unsigned.split('.');
  return { digits: BigInt(intPart + fracPart), scale: fracPart.length, negative };
}

function formatScaledDecimal(digits: bigint, scale: number): string {
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

function signedDigits(d: ScaledDecimal): bigint {
  return d.negative ? -d.digits : d.digits;
}

function alignScales(
  a: ScaledDecimal,
  b: ScaledDecimal,
): { digitsA: bigint; digitsB: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    digitsA: a.digits * 10n ** BigInt(scale - a.scale),
    digitsB: b.digits * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

/** Exact addition of two decimal strings. */
function addDecimalStrings(a: string, b: string): string {
  const sa = parseScaledDecimal(a, 'a', BrokerErrorCode.BROKER_SERVER_ERROR);
  const sb = parseScaledDecimal(b, 'b', BrokerErrorCode.BROKER_SERVER_ERROR);
  const { digitsA, digitsB, scale } = alignScales(sa, sb);
  return formatScaledDecimal(
    (sa.negative ? -digitsA : digitsA) + (sb.negative ? -digitsB : digitsB),
    scale,
  );
}

/** Exact subtraction of two decimal strings. */
function subtractDecimalStrings(a: string, b: string): string {
  const sa = parseScaledDecimal(a, 'a', BrokerErrorCode.BROKER_SERVER_ERROR);
  const sb = parseScaledDecimal(b, 'b', BrokerErrorCode.BROKER_SERVER_ERROR);
  const { digitsA, digitsB, scale } = alignScales(sa, sb);
  return formatScaledDecimal(
    (sa.negative ? -digitsA : digitsA) - (sb.negative ? -digitsB : digitsB),
    scale,
  );
}

/** Exact multiplication of two decimal strings (scales add). */
function multiplyDecimalStrings(a: string, b: string): string {
  const sa = parseScaledDecimal(a, 'a', BrokerErrorCode.BROKER_SERVER_ERROR);
  const sb = parseScaledDecimal(b, 'b', BrokerErrorCode.BROKER_SERVER_ERROR);
  const product = sa.digits * sb.digits;
  return formatScaledDecimal(sa.negative !== sb.negative ? -product : product, sa.scale + sb.scale);
}

/** Numeric comparison of two decimal strings: −1 | 0 | 1 (sign-aware, exact). */
function compareDecimalStrings(a: string, b: string): number {
  const sa = parseScaledDecimal(a, 'a', BrokerErrorCode.BROKER_SERVER_ERROR);
  const sb = parseScaledDecimal(b, 'b', BrokerErrorCode.BROKER_SERVER_ERROR);
  const { digitsA, digitsB } = alignScales(sa, sb);
  const va = sa.negative ? -digitsA : digitsA;
  const vb = sb.negative ? -digitsB : digitsB;
  if (va < vb) return -1;
  if (va > vb) return 1;
  return 0;
}

/** True for '', '0', '0.00' — the "no SL/TP" convention. */
function isZeroLevel(value: string): boolean {
  try {
    return parseScaledDecimal(value, 'level', BrokerErrorCode.INVALID_PRICE).digits === 0n;
  } catch {
    return false;
  }
}

/**
 * Round a decimal string half-up (on magnitude) at `scale` fractional digits.
 * Always emits exactly `scale` fractional digits (padded) — money rendering.
 */
function roundHalfUpAtScale(value: string, scale: number): string {
  const parsed = parseScaledDecimal(value, 'value', BrokerErrorCode.BROKER_SERVER_ERROR);
  if (parsed.scale > scale) {
    const pow = 10n ** BigInt(parsed.scale - scale);
    const whole = parsed.digits / pow;
    const remainder = parsed.digits % pow;
    const bumped = remainder * 2n >= pow ? whole + 1n : whole;
    return formatScaledDecimal(parsed.negative ? -bumped : bumped, scale);
  }
  const padded = parsed.digits * 10n ** BigInt(scale - parsed.scale);
  return formatScaledDecimal(parsed.negative ? -padded : padded, scale);
}

/** Exact division by 10^places (scale grows — always representable). */
function divideByPowerOfTen(value: string, places: number): string {
  const parsed = parseScaledDecimal(value, 'value', BrokerErrorCode.BROKER_SERVER_ERROR);
  return formatScaledDecimal(signedDigits(parsed), parsed.scale + places);
}

/** a ÷ b rounded half-up (on magnitude) at `scale` fractional digits (padded). */
function divideDecimalStrings(a: string, b: string, scale: number): string {
  const sa = parseScaledDecimal(a, 'a', BrokerErrorCode.BROKER_SERVER_ERROR);
  const sb = parseScaledDecimal(b, 'b', BrokerErrorCode.BROKER_SERVER_ERROR);
  const aligned = alignScales(sa, sb);
  const num = signedDigits({ ...sa, digits: aligned.digitsA });
  const den = signedDigits({ ...sb, digits: aligned.digitsB });
  if (den === 0n) {
    throw new BrokerAdapterError(BrokerErrorCode.BROKER_SERVER_ERROR, 'Division by zero.');
  }
  const negative = num < 0n !== den < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;
  const factor = 10n ** BigInt(scale);
  const quotient = (absNum * factor * 2n + absDen) / (2n * absDen);
  return formatScaledDecimal(negative ? -quotient : quotient, scale);
}

/** Money rendering: 2 fractional digits, half-up. */
function toMoney(value: string): string {
  return roundHalfUpAtScale(value, PAPER_MONEY_SCALE);
}

/** The mid of a quote — the paper engine's MARKET/manual-close fill price. */
function quoteMid(quote: PaperQuote): string {
  return divideDecimalStrings(addDecimalStrings(quote.bid, quote.ask), '2', PAPER_PRICE_SCALE);
}

/**
 * Lot string → unsigned integer units (1 lot = 100,000 units). Accepts any
 * decimal spelling that is an exact multiple of the 0.01 lot step by VALUE
 * ('0.5000' is the same trade as '0.50'); the caller's spelling is preserved
 * on the position surface.
 */
function lotSizeToUnits(lotSize: string): bigint {
  const lot = parseScaledDecimal(lotSize, 'lotSize', BrokerErrorCode.INVALID_LOT_SIZE);
  const scaled = lot.digits * PAPER_UNITS_PER_LOT;
  const divisor = 10n ** BigInt(lot.scale);
  if (scaled % divisor !== 0n) {
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_LOT_SIZE,
      `lotSize "${lotSize}" is not a multiple of the 0.01 lot step.`,
    );
  }
  const units = scaled / divisor;
  if (units % PAPER_UNITS_PER_LOT_STEP !== 0n) {
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_LOT_SIZE,
      `lotSize "${lotSize}" is not a multiple of the 0.01 lot step.`,
    );
  }
  return units;
}

// ─── Internal simulation records ──────────────────────────────────────────────

type PaperOrderStatus = 'WORKING' | 'TRIGGERED' | 'FILLED' | 'REJECTED' | 'CANCELLED';

/** A pending order sitting in the working set. */
interface PaperWorkingOrder {
  orderId: string;
  dedupeKey: string;
  /** Synthesized broker comment: user comment + idempotency tag. */
  comment: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;
  orderKind: PaperOrderKind;
  timeInForce: string;
  limitPrice?: string;
  stopPrice?: string;
  stopLoss: string; // '0' = none
  takeProfit: string; // '0' = none
  status: PaperOrderStatus; // WORKING or TRIGGERED while in the working set
  placedAt: Date;
}

/** An open position (one order = one position, same id, no netting). */
interface PaperPosition {
  positionId: string;
  dedupeKey: string;
  comment: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  /** Remaining units (unsigned integer; reduced by partial closes). */
  units: bigint;
  /** Caller's lot spelling, reduced exactly by partial closes. */
  lotSize: string;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  openedAt: Date;
}

interface PaperClosedTrade {
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
  closeReason: 'TP' | 'SL' | 'MANUAL' | 'SYSTEM';
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

@Injectable()
export class PaperBrokerAdapter implements IBrokerAdapter {
  private readonly logger = new Logger(PaperBrokerAdapter.name);

  readonly brokerId = 'paper-broker';
  readonly brokerName = 'Paper Trading Broker (Simulated — PAPER_ONLY)';
  readonly supportsDemo = true;

  private _connected = false;
  private _mode: BrokerMode = BrokerMode.DEMO;
  private _orderCounter = 0;
  private _marketTickCounter = 0;
  private _balance = PAPER_STARTING_BALANCE;

  private readonly _feed: PaperPriceFeed;
  private readonly _clock: PaperClock;
  private readonly _working: PaperWorkingOrder[] = [];
  private readonly _positions = new Map<string, PaperPosition>();
  private readonly _closedTrades: PaperClosedTrade[] = [];
  /** Provider order states (working + terminal) — the getOrderById surface. */
  private readonly _orderStates = new Map<string, BrokerOrderState>();
  /** True-dedupe acknowledgement store, keyed by clientOrderId ?? idempotencyKey. */
  private readonly _resultsByDedupeKey = new Map<string, BrokerOrderResult>();

  /**
   * The feed and clock are constructor-injectable determinism seams for specs
   * (scripted falling walks, fake clocks). Under Nest DI both are optional and
   * default to the deterministic implementations above.
   */
  constructor(@Optional() priceFeed?: PaperPriceFeed, @Optional() clock?: PaperClock) {
    this._feed = priceFeed ?? new DeterministicPaperPriceFeed();
    this._clock = clock ?? new DeterministicPaperClock();
  }

  setMode(mode: BrokerMode): void {
    if (mode === BrokerMode.LIVE) {
      this.logger.warn('PaperBrokerAdapter cannot be set to LIVE mode. Ignoring setMode(LIVE).');
      return;
    }
    this._mode = mode;
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  async connect(_credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    // Credentials intentionally ignored — paper broker needs none.
    // Account state PERSISTS across reconnects (health checks must never wipe
    // orders/positions/history — the "preserve" contract).
    this._connected = true;
    this.logger.log('PaperBrokerAdapter connected (simulated)');
    return {
      success: true,
      accountId: PAPER_ACCOUNT_ID,
      accountType: BrokerMode.DEMO,
      currency: PAPER_CURRENCY,
      serverTime: this._clock.now(),
    };
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.logger.log('PaperBrokerAdapter disconnected');
  }

  async testConnection(
    _credentials: DecryptedBrokerCredentials,
  ): Promise<BrokerConnectionTestResult> {
    return {
      success: true,
      accountId: PAPER_ACCOUNT_ID,
      accountType: BrokerMode.DEMO,
      currency: PAPER_CURRENCY,
    };
  }

  isConnected(): boolean {
    return this._connected;
  }

  /** Directive §AN #1 — fail closed before connect(): never fabricate data. */
  private assertConnected(): void {
    if (!this._connected) {
      throw new BrokerAdapterError(
        BrokerErrorCode.NOT_CONNECTED,
        'PaperBrokerAdapter is not connected. Call connect() first.',
        undefined,
        false,
      );
    }
  }

  /** The single-instrument simulation only knows EURUSD. */
  private requireInstrument(instrument: string): string {
    const symbol = instrument.trim().toUpperCase();
    if (symbol !== PAPER_INSTRUMENT) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `Paper broker supports ${PAPER_INSTRUMENT} only (received "${instrument}").`,
      );
    }
    return symbol;
  }

  // ─── Account state ────────────────────────────────────────────────────────

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    this.assertConnected();
    const snapshot = this.accountSnapshot();
    return {
      accountId: PAPER_ACCOUNT_ID,
      currency: PAPER_CURRENCY,
      leverage: PAPER_LEVERAGE,
      balance: snapshot.balance,
      equity: snapshot.equity,
      margin: snapshot.margin,
      freeMargin: snapshot.freeMargin,
      marginLevel: snapshot.marginLevel,
    };
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    this.assertConnected();
    const snapshot = this.accountSnapshot();
    return {
      balance: snapshot.balance,
      equity: snapshot.equity,
      currency: PAPER_CURRENCY,
      timestamp: this._clock.now(),
    };
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    this.assertConnected();
    return Array.from(this._positions.values()).map((position) => this.mapPosition(position));
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    this.assertConnected();
    const position = this._positions.get(externalOrderId);
    return position ? this.mapPosition(position) : null;
  }

  /**
   * Sprint 32 Gate 2: calculate required margin for a proposed order.
   *
   * Paper broker formula (unchanged semantics, exact decimal math):
   *   requiredMargin = (lotSize × contractSize × currentPrice) / leverage
   *
   * The current price is the mid of the prevailing quote (pure read — a margin
   * calculation never moves the market). Returns null when the margin cannot
   * be safely calculated (unknown instrument, invalid lot) — fail-closed.
   */
  async getRequiredMargin(params: RequiredMarginParams): Promise<string | null> {
    this.assertConnected();
    try {
      if (params.instrument.trim().toUpperCase() !== PAPER_INSTRUMENT) return null;
      const lot = parseScaledDecimal(params.lotSize, 'lotSize', BrokerErrorCode.INVALID_LOT_SIZE);
      if (lot.negative || lot.digits === 0n) return null;
      // Any exact lot-step spelling is calculable; non-step values are not.
      try {
        lotSizeToUnits(params.lotSize);
      } catch {
        return null;
      }

      const quote = this._feed.quote();
      const mid = quoteMid(quote);
      const product = multiplyDecimalStrings(
        multiplyDecimalStrings(params.lotSize.trim(), PAPER_CONTRACT_SIZE),
        mid,
      );
      // / leverage (100) → exact right shift by 2, rendered at 2dp half-up.
      return roundHalfUpAtScale(divideByPowerOfTen(product, 2), PAPER_MONEY_SCALE);
    } catch {
      return null;
    }
  }

  /**
   * Account snapshot (pure — never ticks the market). equity sums the ROUNDED
   * per-position unrealized P&L so the books always reconcile with the values
   * surfaces report; margin sums per-position margin locked at entry price.
   */
  private accountSnapshot(): {
    balance: string;
    equity: string;
    margin: string;
    freeMargin: string;
    marginLevel: string;
  } {
    const quote = this._feed.quote();
    let equity = this._balance;
    let margin = '0.00';
    for (const position of this._positions.values()) {
      equity = addDecimalStrings(equity, toMoney(this.unrealisedPnlExact(position, quote)));
      margin = addDecimalStrings(margin, toMoney(this.positionMarginExact(position)));
    }
    const freeMargin = subtractDecimalStrings(equity, margin);
    const marginLevel =
      compareDecimalStrings(margin, '0') === 0
        ? '0.00'
        : divideDecimalStrings(multiplyDecimalStrings(equity, '100'), margin, PAPER_MONEY_SCALE);
    return { balance: this._balance, equity, margin, freeMargin, marginLevel };
  }

  /** Free margin available to cover a new fill (pure read). */
  private freeMargin(): string {
    return this.accountSnapshot().freeMargin;
  }

  /** (currentPrice − entry) × units with the direction sign — exact strings. */
  private unrealisedPnlExact(position: PaperPosition, quote: PaperQuote): string {
    const exitPrice = position.direction === 'BUY' ? quote.bid : quote.ask;
    const diff =
      position.direction === 'BUY'
        ? subtractDecimalStrings(exitPrice, position.entryPrice)
        : subtractDecimalStrings(position.entryPrice, exitPrice);
    return multiplyDecimalStrings(diff, position.units.toString());
  }

  /** units × entryPrice / leverage — margin locked at fill, exact strings. */
  private positionMarginExact(position: PaperPosition): string {
    return divideByPowerOfTen(
      multiplyDecimalStrings(position.units.toString(), position.entryPrice),
      2,
    );
  }

  private mapPosition(position: PaperPosition): BrokerPosition {
    const quote = this._feed.quote();
    const exitPrice = position.direction === 'BUY' ? quote.bid : quote.ask;
    return {
      externalOrderId: position.positionId,
      instrument: position.instrument,
      direction: position.direction,
      lotSize: position.lotSize,
      openPrice: position.entryPrice,
      // Exit-side quote: the price at which the position would close — the
      // same side the SL/TP triggers and the unrealized valuation use.
      currentPrice: exitPrice,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      unrealisedPnl: toMoney(this.unrealisedPnlExact(position, quote)),
      openedAt: position.openedAt,
      commission: '0',
      swap: '0',
    };
  }

  // ─── Provider order state (reconciliation read surface) ────────────────────

  /**
   * WORKING/pending orders (LIMIT/STOP/STOP_LIMIT, incl. triggered-but-
   * unfilled stop-limits — still working). Terminal (history) orders are NOT
   * listed here; getOrderById covers them.
   */
  async listOrders(): Promise<BrokerOrderState[]> {
    this.assertConnected();
    return this._working.map((order) => this.workingOrderState(order));
  }

  /**
   * Look up a single provider order by its stable identifier — including
   * COMPLETED (history) orders. Returns null when the paper provider knows
   * no such order.
   */
  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    this.assertConnected();
    const state = this._orderStates.get(providerOrderId);
    return state ? { ...state } : null;
  }

  /** BrokerOrderState projection of one working order (a copy — never live). */
  private workingOrderState(order: PaperWorkingOrder): BrokerOrderState {
    return {
      providerOrderId: order.orderId,
      // Idempotency passthrough (Directive §AN #6): the caller's stable
      // clientOrderId is preferred; the idempotencyKey is the fallback —
      // same convention as the MetaTrader adapter's clientId.
      clientOrderId: order.dedupeKey,
      status: 'WORKING',
      instrument: order.instrument,
      direction: order.direction,
      requestedQuantity: order.lotSize,
      filledQuantity: '0.0000',
      avgFillPrice: null,
      orderKind: order.orderKind,
      limitPrice: order.limitPrice ?? null,
      stopPrice: order.stopPrice ?? null,
      timeInForce: order.timeInForce,
      placedAt: order.placedAt,
      updatedAt: order.placedAt,
    };
  }

  // ─── Market data ──────────────────────────────────────────────────────────

  async getInstrumentList(): Promise<BrokerInstrument[]> {
    this.assertConnected();
    return [
      {
        symbol: PAPER_INSTRUMENT,
        description: 'Euro vs US Dollar (Paper)',
        digits: PAPER_PRICE_SCALE,
        minLot: PAPER_MIN_LOT,
        maxLot: PAPER_MAX_LOT,
        lotStep: '0.01',
        contractSize: PAPER_CONTRACT_SIZE,
      },
    ];
  }

  /**
   * The market heartbeat: each price poll advances the deterministic walk by
   * ONE tick (+1s simulated time) and then runs the evaluation engine
   * (position SL/TP first, then working orders). This is the only public
   * surface that moves the market.
   */
  async getCurrentPrice(instrument: string): Promise<BrokerPrice> {
    this.assertConnected();
    this.requireInstrument(instrument);
    const quote = this.advanceMarket();
    return {
      instrument: PAPER_INSTRUMENT,
      bid: quote.bid,
      ask: quote.ask,
      spread: subtractDecimalStrings(quote.ask, quote.bid),
      timestamp: this._clock.now(),
    };
  }

  async getOHLCV(instrument: string, timeframe: string, count: number): Promise<OHLCV[]> {
    this.assertConnected();
    this.requireInstrument(instrument);

    const normalizedTimeframe = timeframe.trim().toUpperCase();
    const spacingMs = PAPER_TIMEFRAME_MS[normalizedTimeframe];
    if (!spacingMs) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `Unsupported paper-market timeframe: ${timeframe}`,
      );
    }

    // Deterministic but EVOLVING candles. The market tick counter is advanced
    // by the explicit paper heartbeat (getCurrentPrice) once per AI scan; OHLCV
    // reads are pure snapshots so an MTF evaluation does not tick five times.
    const candles: OHLCV[] = [];
    const base = 1.1;
    const now = this._clock.now();
    const phaseNow = this._marketTickCounter;

    for (let i = count - 1; i >= 0; i--) {
      const phase = phaseNow - i;
      const ts = new Date(now.getTime() - i * spacingMs);
      const open = String((base + Math.sin(phase * 0.1) * 0.005).toFixed(5));
      const close = String((base + Math.sin((phase + 1) * 0.1) * 0.005).toFixed(5));
      const high = String((Math.max(parseFloat(open), parseFloat(close)) + 0.0002).toFixed(5));
      const low = String((Math.min(parseFloat(open), parseFloat(close)) - 0.0002).toFixed(5));
      candles.push({
        timestamp: ts,
        open,
        high,
        low,
        close,
        volume: '1000',
        tickVolume: '1000',
        spreadPoints: PAPER_SPREAD_UNITS.toString(),
        priceDigits: PAPER_PRICE_SCALE,
        brokerTime: ts.toISOString(),
      });
    }

    this.logger.debug(
      `PaperBrokerAdapter: returning ${count} evolving mock candles for ${instrument} ${normalizedTimeframe} tick=${phaseNow}`,
    );
    return candles;
  }

  // ─── Order management ─────────────────────────────────────────────────────

  // ─── Order capability contract (Round 6 §7) ──────────────────────────────

  /**
   * Paper broker capability matrix (the DECLARED truth): all four normalized
   * kinds (validated by validateOrderKind); LIMIT/STOP_LIMIT need
   * limitPrice, STOP/STOP_LIMIT need stopPrice; MARKET orders attach SL/TP
   * at placement.
   */
  getOrderCapabilities(): OrderCapabilityDeclaration {
    return {
      brokerId: this.brokerId,
      supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'],
      requirements: {
        MARKET: { limitPriceRequired: false, stopPriceRequired: false },
        LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
        STOP: { limitPriceRequired: false, stopPriceRequired: true },
        STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
      },
      marketSlTpAttachedAtPlacement: true,
    };
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    // PAPER-ONLY write certainty (correction round 4, finding 6): the paper
    // broker is fully LOCAL and deterministic — every failure provably never
    // left iRexPro (there is no provider), so every error it throws is
    // classified DEFINITELY_NOT_SENT.
    try {
      this.assertConnected();
      // Order-kind + parameter validation runs BEFORE any order creation
      // (fail-closed, never silently downgrading a non-market order kind).
      const orderKind = this.validateOrderKind(order);
      const instrument = this.requireInstrument(order.instrument);
      this.validateLotSize(order.lotSize);
      const stopLoss = this.normalizeProtectionLevel(order.stopLoss, 'stopLoss');
      const takeProfit = this.normalizeProtectionLevel(order.takeProfit, 'takeProfit');
      // Price-parameter validation (fail-fast, MT/OANDA-adapter convention):
      // LIMIT/STOP_LIMIT require a positive limitPrice; STOP/STOP_LIMIT require
      // a positive stopPrice.
      if (orderKind === 'LIMIT' || orderKind === 'STOP_LIMIT') {
        this.requirePositiveOrderPrice(orderKind, 'limitPrice', order.limitPrice);
      }
      if (orderKind === 'STOP' || orderKind === 'STOP_LIMIT') {
        this.requirePositiveOrderPrice(orderKind, 'stopPrice', order.stopPrice);
      }

      // Idempotency — TRUE dedupe: a repeat request carrying the same stable
      // identifier (clientOrderId, else idempotencyKey) returns the ORIGINAL
      // placement result verbatim (no new order, no new fill).
      const dedupeKey = order.clientOrderId ?? order.idempotencyKey;
      const original = this._resultsByDedupeKey.get(dedupeKey);
      if (original) {
        this.logger.log(
          `PaperBrokerAdapter: idempotent replay for key=${dedupeKey} ` +
            `returns original result [PAPER_ONLY]`,
        );
        return { ...original };
      }

      this._orderCounter += 1;
      const orderId = `paper-order-${this._orderCounter.toString().padStart(6, '0')}`;
      const comment = [order.comment?.trim(), `idem:${order.idempotencyKey}`]
        .filter((part) => part && part.length > 0)
        .join(' | ');

      let result: BrokerOrderResult;
      if (orderKind === 'MARKET') {
        result = this.executeMarketOrder(orderId, order, instrument, stopLoss, takeProfit, comment);
      } else {
        const placedAt = this._clock.now();
        const working: PaperWorkingOrder = {
          orderId,
          dedupeKey,
          comment,
          instrument,
          direction: order.direction,
          lotSize: order.lotSize.trim(),
          orderKind,
          timeInForce: order.timeInForce ?? 'GTC',
          limitPrice: order.limitPrice?.trim(),
          stopPrice: order.stopPrice?.trim(),
          stopLoss,
          takeProfit,
          status: 'WORKING',
          placedAt,
        };
        this._working.push(working);
        this._orderStates.set(orderId, this.workingOrderState(working));
        result = {
          success: true,
          externalOrderId: orderId,
          status: 'PENDING',
          brokerMessage: `PAPER_ONLY simulated working ${orderKind} order`,
        };
      }

      this._resultsByDedupeKey.set(dedupeKey, result);
      this.logger.log(
        `PaperBrokerAdapter: simulated order placed id=${orderId} ` +
          `instrument=${instrument} dir=${order.direction} lot=${order.lotSize} ` +
          `kind=${orderKind} [PAPER_ONLY — no real order placed]`,
      );
      return result;
    } catch (err) {
      throw this.toLocalWriteError(err);
    }
  }

  /**
   * Order-kind validation: the normalized Sprint 50 PR-3 model only, and
   * never a silent downgrade — unknown kinds fail closed loudly.
   */
  private validateOrderKind(order: BrokerOrderRequest): PaperOrderKind {
    const kind = order.orderKind ?? 'MARKET';
    if (!PAPER_ORDER_KINDS.includes(kind)) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_ORDER_TYPE,
        `Unsupported order kind: ${String(kind)}`,
      );
    }
    return kind;
  }

  /**
   * Price-parameter validation for non-market order kinds (fail-closed,
   * never a silent downgrade): the named field must be a positive decimal.
   */
  private requirePositiveOrderPrice(
    orderKind: PaperOrderKind,
    field: 'limitPrice' | 'stopPrice',
    value: string | undefined,
  ): void {
    if (value === undefined || value.trim() === '') {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_PRICE,
        `${orderKind} order requires a positive decimal ${field}`,
      );
    }
    const parsed = parseScaledDecimal(value, field, BrokerErrorCode.INVALID_PRICE);
    if (parsed.negative || parsed.digits === 0n) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_PRICE,
        `${orderKind} order requires a positive decimal ${field} (got: ${value})`,
      );
    }
  }

  /** Immediate MARKET fill at the quote mid (the deterministic '1.10005'). */
  private executeMarketOrder(
    orderId: string,
    order: BrokerOrderRequest,
    instrument: string,
    stopLoss: string,
    takeProfit: string,
    comment: string,
  ): BrokerOrderResult {
    const quote = this._feed.quote();
    const fillPrice = quoteMid(quote);
    const units = lotSizeToUnits(order.lotSize);
    const requiredMargin = toMoney(
      divideByPowerOfTen(multiplyDecimalStrings(units.toString(), fillPrice), 2),
    );
    if (compareDecimalStrings(requiredMargin, this.freeMargin()) > 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INSUFFICIENT_MARGIN,
        `Required margin ${requiredMargin} USD exceeds free margin ${this.freeMargin()} USD.`,
      );
    }
    this.openPosition(
      orderId,
      order.direction,
      instrument,
      units,
      order.lotSize.trim(),
      fillPrice,
      stopLoss,
      takeProfit,
      order.clientOrderId ?? order.idempotencyKey,
      comment,
    );
    this._orderStates.set(orderId, {
      providerOrderId: orderId,
      clientOrderId: order.clientOrderId ?? order.idempotencyKey,
      status: 'FILLED',
      instrument,
      direction: order.direction,
      requestedQuantity: order.lotSize.trim(),
      filledQuantity: order.lotSize.trim(),
      avgFillPrice: fillPrice,
      orderKind: 'MARKET',
      limitPrice: null,
      stopPrice: null,
      timeInForce: order.timeInForce ?? 'GTC',
      placedAt: this._clock.now(),
      updatedAt: this._clock.now(),
    });
    return {
      success: true,
      externalOrderId: orderId,
      filledPrice: fillPrice,
      filledQuantity: order.lotSize.trim(),
      filledAt: this._clock.now(),
      status: 'FILLED',
      brokerMessage: 'PAPER_ONLY simulated fill',
    };
  }

  private openPosition(
    orderId: string,
    direction: 'BUY' | 'SELL',
    instrument: string,
    units: bigint,
    lotSize: string,
    entryPrice: string,
    stopLoss: string,
    takeProfit: string,
    dedupeKey = '',
    comment = '',
  ): PaperPosition {
    const position: PaperPosition = {
      positionId: orderId,
      dedupeKey,
      comment,
      instrument,
      direction,
      units,
      lotSize,
      entryPrice,
      stopLoss,
      takeProfit,
      openedAt: this._clock.now(),
    };
    this._positions.set(orderId, position);
    return position;
  }

  async modifyOrder(
    externalOrderId: string,
    modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult> {
    try {
      this.assertConnected();
      const { newStopLoss, newTakeProfit, newTrailingStop } = modifications ?? {};
      if (
        newStopLoss === undefined &&
        newTakeProfit === undefined &&
        newTrailingStop === undefined
      ) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_REQUEST,
          'At least one modification (newStopLoss/newTakeProfit) is required.',
        );
      }
      if (newTrailingStop !== undefined) {
        // Honest: the paper engine does not simulate trailing stops (same
        // fail-closed convention as the OANDA sibling).
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_REQUEST,
          'The paper broker does not simulate trailing stops (fail-closed — use stopLoss/takeProfit only).',
        );
      }
      const stopLoss = this.normalizeProtectionLevel(newStopLoss, 'newStopLoss');
      const takeProfit = this.normalizeProtectionLevel(newTakeProfit, 'newTakeProfit');

      const position = this._positions.get(externalOrderId);
      if (position) {
        if (stopLoss !== undefined) position.stopLoss = stopLoss;
        if (takeProfit !== undefined) position.takeProfit = takeProfit;
      } else {
        const working = this._working.find((o) => o.orderId === externalOrderId);
        if (!working) {
          throw new BrokerAdapterError(
            BrokerErrorCode.POSITION_NOT_FOUND,
            `"${externalOrderId}" is neither an open paper position nor a working paper order.`,
          );
        }
        // Protection attached to a working order is carried into the eventual fill.
        if (stopLoss !== undefined) working.stopLoss = stopLoss;
        if (takeProfit !== undefined) working.takeProfit = takeProfit;
      }
      return {
        success: true,
        externalOrderId,
        status: 'FILLED',
        brokerMessage: 'PAPER_ONLY simulated modification',
      };
    } catch (err) {
      throw this.toLocalWriteError(err);
    }
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    try {
      this.assertConnected();
      const position = this._positions.get(externalOrderId);
      if (!position) {
        // Fail honestly (never a silent success): unknown ids are rejected;
        // working-order ids carry a pointer to cancelOrder — their honest path.
        const isWorking = this._working.some((o) => o.orderId === externalOrderId);
        return {
          success: false,
          externalOrderId,
          status: 'REJECTED',
          brokerMessage: isWorking
            ? 'PAPER_ONLY: working order — cancelOrder is the path for pending orders'
            : 'PAPER_ONLY: unknown position — nothing to close',
        };
      }

      let closeUnits: bigint;
      let closedLot = position.lotSize;
      if (lotSize === undefined) {
        closeUnits = position.units; // full close
      } else {
        this.validateLotSize(lotSize);
        if (compareDecimalStrings(lotSize.trim(), position.lotSize) > 0) {
          throw new BrokerAdapterError(
            BrokerErrorCode.INVALID_LOT_SIZE,
            `Close lot size ${lotSize} exceeds the open size ${position.lotSize}.`,
          );
        }
        closeUnits = lotSizeToUnits(lotSize);
        closedLot = lotSize.trim();
      }

      // Manual closes execute at the quote mid (zero-slippage paper model —
      // an open-and-close without an intervening tick books exactly flat).
      const quote = this._feed.quote();
      const closePrice = quoteMid(quote);

      this.closePositionUnits(position, closeUnits, closedLot, closePrice, 'MANUAL');
      return {
        success: true,
        externalOrderId,
        filledPrice: closePrice,
        filledQuantity: closedLot,
        filledAt: this._clock.now(),
        status: 'FILLED',
        brokerMessage: 'PAPER_ONLY simulated close',
      };
    } catch (err) {
      throw this.toLocalWriteError(err);
    }
  }

  /**
   * CONCRETE cancel surface (not part of IBrokerAdapter — the interface has
   * no cancel method). Cancels a WORKING order; unknown/non-working ids map
   * to POSITION_NOT_FOUND (the BrokerErrorCode set has no ORDER_NOT_FOUND —
   * documented honest choice, same mapping as the OANDA sibling).
   */
  async cancelOrder(externalOrderId: string): Promise<BrokerOrderResult> {
    try {
      this.assertConnected();
      const index = this._working.findIndex((o) => o.orderId === externalOrderId);
      if (index === -1) {
        throw new BrokerAdapterError(
          BrokerErrorCode.POSITION_NOT_FOUND,
          `"${externalOrderId}" is not a working paper order.`,
        );
      }
      const [cancelled] = this._working.splice(index, 1);
      const now = this._clock.now();
      this._orderStates.set(externalOrderId, {
        providerOrderId: externalOrderId,
        clientOrderId: cancelled.dedupeKey,
        status: 'CANCELLED',
        instrument: cancelled.instrument,
        direction: cancelled.direction,
        requestedQuantity: cancelled.lotSize,
        filledQuantity: '0.0000',
        avgFillPrice: null,
        orderKind: cancelled.orderKind,
        limitPrice: cancelled.limitPrice ?? null,
        stopPrice: cancelled.stopPrice ?? null,
        timeInForce: cancelled.timeInForce,
        placedAt: cancelled.placedAt,
        updatedAt: now,
      });
      this.logger.log(
        `PaperBrokerAdapter: cancelled working order id=${externalOrderId} ` +
          `kind=${cancelled.orderKind} [PAPER_ONLY]`,
      );
      return {
        success: true,
        externalOrderId,
        status: 'FILLED',
        brokerMessage: 'PAPER_ONLY working order cancelled',
      };
    } catch (err) {
      throw this.toLocalWriteError(err);
    }
  }

  /**
   * Kill-switch semantics (documented decision): closes open POSITIONS only,
   * booked as closeReason SYSTEM, honest counts. Working orders carry no
   * exposure and stay working — cancelOrder is the path for those.
   */
  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    try {
      this.assertConnected();
      const quote = this._feed.quote();
      let closedCount = 0;
      let failedCount = 0;
      const errors: string[] = [];

      for (const position of Array.from(this._positions.values())) {
        try {
          const closePrice = quoteMid(quote);
          this.closePositionUnits(position, position.units, position.lotSize, closePrice, 'SYSTEM');
          closedCount++;
        } catch (err) {
          failedCount++;
          errors.push(String((err as Error).message));
        }
      }

      this.logger.log(
        `PaperBrokerAdapter: closeAllOrders closed=${closedCount} failed=${failedCount} ` +
          `(working orders left untouched: ${this._working.length}) [PAPER_ONLY]`,
      );
      return { closedCount, failedCount, errors };
    } catch (err) {
      throw this.toLocalWriteError(err);
    }
  }

  /**
   * PAPER-ONLY write certainty (Sprint 56 correction round 4, finding 6):
   * the paper broker is fully LOCAL and deterministic — every failure it
   * throws provably never left iRexPro (no provider exists), so every error
   * is classified DEFINITELY_NOT_SENT (retrying later is always safe).
   */
  private toLocalWriteError(err: unknown): BrokerAdapterError {
    if (err instanceof BrokerAdapterError) {
      if (err.dispatchCertainty) return err;
      return new BrokerAdapterError(
        err.code,
        err.message,
        err.brokerMessage,
        err.isRetryable,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return new BrokerAdapterError(
      BrokerErrorCode.UNKNOWN,
      message,
      message,
      false,
      ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
    );
  }

  // ─── Trade history ────────────────────────────────────────────────────────

  async getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]> {
    this.assertConnected();
    const fromMs = from.getTime();
    const toMs = to.getTime();
    return this._closedTrades
      .filter((trade) => trade.closedAt.getTime() >= fromMs && trade.closedAt.getTime() <= toMs)
      .map((trade) => ({ ...trade }));
  }

  // ─── Evaluation engine (runs on every market tick) ───────────────────────

  /** Advance one deterministic tick, then evaluate positions and orders. */
  private advanceMarket(): PaperQuote {
    const quote = this._feed.tick();
    this._marketTickCounter += 1;
    this._clock.advance(PAPER_TICK_DURATION_MS);
    this.evaluatePositions(quote);
    this.evaluateWorkingOrders(quote);
    return quote;
  }

  /**
   * Position SL/TP (SL checked before TP — conservative). SL/TP close exactly
   * at their level (resting protection orders; no gap slippage modeled).
   */
  private evaluatePositions(quote: PaperQuote): void {
    for (const position of Array.from(this._positions.values())) {
      if (position.direction === 'BUY') {
        if (
          !isZeroLevel(position.stopLoss) &&
          compareDecimalStrings(quote.bid, position.stopLoss) <= 0
        ) {
          this.closePositionUnits(
            position,
            position.units,
            position.lotSize,
            position.stopLoss,
            'SL',
          );
          continue;
        }
        if (
          !isZeroLevel(position.takeProfit) &&
          compareDecimalStrings(quote.bid, position.takeProfit) >= 0
        ) {
          this.closePositionUnits(
            position,
            position.units,
            position.lotSize,
            position.takeProfit,
            'TP',
          );
        }
      } else {
        if (
          !isZeroLevel(position.stopLoss) &&
          compareDecimalStrings(quote.ask, position.stopLoss) >= 0
        ) {
          this.closePositionUnits(
            position,
            position.units,
            position.lotSize,
            position.stopLoss,
            'SL',
          );
          continue;
        }
        if (
          !isZeroLevel(position.takeProfit) &&
          compareDecimalStrings(quote.ask, position.takeProfit) <= 0
        ) {
          this.closePositionUnits(
            position,
            position.units,
            position.lotSize,
            position.takeProfit,
            'TP',
          );
        }
      }
    }
  }

  /** Working orders in placement order; fills may create positions (evaluated next tick). */
  private evaluateWorkingOrders(quote: PaperQuote): void {
    for (const order of Array.from(this._working)) {
      const fillPrice = this.workingFillPrice(order, quote);
      if (fillPrice !== undefined) {
        this.fillWorkingOrder(order, fillPrice);
      }
    }
  }

  /**
   * Fill rule per order kind against the tick quote; undefined = stays
   * working. LIMIT fills at the prevailing quote side (never worse than the
   * limit); STOP fills at the prevailing quote side once triggered;
   * STOP_LIMIT triggers like STOP then fills like LIMIT — a just-triggered
   * stop-limit fills the same tick when the quote already satisfies the
   * limit.
   */
  private workingFillPrice(order: PaperWorkingOrder, quote: PaperQuote): string | undefined {
    const buy = order.direction === 'BUY';
    switch (order.orderKind) {
      case 'LIMIT':
        if (buy) {
          return compareDecimalStrings(quote.ask, order.limitPrice!) <= 0 ? quote.ask : undefined;
        }
        return compareDecimalStrings(quote.bid, order.limitPrice!) >= 0 ? quote.bid : undefined;
      case 'STOP':
        if (buy) {
          return compareDecimalStrings(quote.ask, order.stopPrice!) >= 0 ? quote.ask : undefined;
        }
        return compareDecimalStrings(quote.bid, order.stopPrice!) <= 0 ? quote.bid : undefined;
      case 'STOP_LIMIT': {
        const triggered = buy
          ? compareDecimalStrings(quote.ask, order.stopPrice!) >= 0
          : compareDecimalStrings(quote.bid, order.stopPrice!) <= 0;
        if (order.status === 'WORKING' && triggered) {
          order.status = 'TRIGGERED'; // stop condition met; the limit part remains
        }
        if (order.status !== 'TRIGGERED') {
          return undefined;
        }
        // Fill like LIMIT from here on — if the price moved away beyond the
        // limit, the order stays working (honest stop-limit miss).
        if (buy) {
          return compareDecimalStrings(quote.ask, order.limitPrice!) <= 0 ? quote.ask : undefined;
        }
        return compareDecimalStrings(quote.bid, order.limitPrice!) >= 0 ? quote.bid : undefined;
      }
      default:
        return undefined;
    }
  }

  /** Fill a working order — margin-checked like a real broker fill. */
  private fillWorkingOrder(order: PaperWorkingOrder, fillPrice: string): void {
    const units = lotSizeToUnits(order.lotSize);
    const requiredMargin = toMoney(
      divideByPowerOfTen(multiplyDecimalStrings(units.toString(), fillPrice), 2),
    );
    if (compareDecimalStrings(requiredMargin, this.freeMargin()) > 0) {
      // No caller to notify on a deferred fill — the order transitions to a
      // terminal REJECTED state and leaves the working set (documented).
      this.removeWorkingOrder(order.orderId);
      this._orderStates.set(order.orderId, {
        ...this.workingOrderState(order),
        status: 'REJECTED',
        updatedAt: this._clock.now(),
      });
      this.logger.warn(
        `PaperBrokerAdapter: working order id=${order.orderId} REJECTED at fill time — ` +
          `required margin ${requiredMargin} USD exceeds free margin ${this.freeMargin()} USD [PAPER_ONLY]`,
      );
      return;
    }
    this.removeWorkingOrder(order.orderId);
    this.openPosition(
      order.orderId,
      order.direction,
      order.instrument,
      units,
      order.lotSize,
      fillPrice,
      order.stopLoss,
      order.takeProfit,
      order.dedupeKey,
      order.comment,
    );
    // Correct the originating order's terminal state: it was a working
    // order that filled at the prevailing quote, not a market order.
    this._orderStates.set(order.orderId, {
      providerOrderId: order.orderId,
      clientOrderId: order.dedupeKey,
      status: 'FILLED',
      instrument: order.instrument,
      direction: order.direction,
      requestedQuantity: order.lotSize,
      filledQuantity: order.lotSize,
      avgFillPrice: fillPrice,
      orderKind: order.orderKind,
      limitPrice: order.limitPrice ?? null,
      stopPrice: order.stopPrice ?? null,
      timeInForce: order.timeInForce,
      placedAt: order.placedAt,
      updatedAt: this._clock.now(),
    });
    this.logger.log(
      `PaperBrokerAdapter: working order id=${order.orderId} filled at ${fillPrice} ` +
        `[PAPER_ONLY]`,
    );
  }

  private removeWorkingOrder(orderId: string): void {
    const index = this._working.findIndex((o) => o.orderId === orderId);
    if (index !== -1) {
      this._working.splice(index, 1);
    }
  }

  /**
   * Core close path (SL/TP/MANUAL/SYSTEM): books a closed trade for the
   * closed units, adjusts the balance, and reduces/removes the position.
   */
  private closePositionUnits(
    position: PaperPosition,
    closeUnits: bigint,
    closedLot: string,
    closePrice: string,
    closeReason: PaperClosedTrade['closeReason'],
  ): PaperClosedTrade {
    const diff =
      position.direction === 'BUY'
        ? subtractDecimalStrings(closePrice, position.entryPrice)
        : subtractDecimalStrings(position.entryPrice, closePrice);
    const realisedPnl = toMoney(multiplyDecimalStrings(diff, closeUnits.toString()));
    this._balance = toMoney(addDecimalStrings(this._balance, realisedPnl));

    const trade: PaperClosedTrade = {
      externalOrderId: position.positionId,
      instrument: position.instrument,
      direction: position.direction,
      lotSize: closedLot,
      openPrice: position.entryPrice,
      closePrice,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      realisedPnl,
      openedAt: position.openedAt,
      closedAt: this._clock.now(),
      commission: '0',
      swap: '0',
      closeReason,
    };
    this._closedTrades.push(trade);

    if (closeUnits >= position.units) {
      this._positions.delete(position.positionId);
    } else {
      position.units -= closeUnits;
      // Preserve the caller's lot spelling scale exactly ('1.0000' − '0.4'
      // → '0.6000' — never a reformatted 2dp shadow).
      position.lotSize = subtractDecimalStrings(position.lotSize, closedLot);
    }
    this.logger.log(
      `PaperBrokerAdapter: position id=${position.positionId} closed ` +
        `(${trade.lotSize} lots @ ${closePrice}, reason=${closeReason}, ` +
        `pnl=${realisedPnl} USD) [PAPER_ONLY]`,
    );
    return trade;
  }

  // ─── Request validation ───────────────────────────────────────────────────

  /** Lot-size validation against the instrument's min/max/step rules. */
  private validateLotSize(lotSize: string): string {
    const lot = parseScaledDecimal(lotSize, 'lotSize', BrokerErrorCode.INVALID_LOT_SIZE);
    if (lot.negative || lot.digits === 0n) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_LOT_SIZE,
        `lotSize "${lotSize}" must be positive.`,
      );
    }
    if (compareDecimalStrings(lotSize.trim(), PAPER_MIN_LOT) < 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_LOT_SIZE,
        `lotSize "${lotSize}" is below the minimum ${PAPER_MIN_LOT}.`,
      );
    }
    if (compareDecimalStrings(lotSize.trim(), PAPER_MAX_LOT) > 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_LOT_SIZE,
        `lotSize "${lotSize}" is above the maximum ${PAPER_MAX_LOT}.`,
      );
    }
    // Step rule by VALUE (any exact decimal spelling of a 0.01 multiple).
    lotSizeToUnits(lotSize);
    return lotSize.trim();
  }

  /**
   * SL/TP normalization: undefined → '0' (none), ''/'0' → '0' (clear),
   * otherwise a validated positive decimal string.
   */
  private normalizeProtectionLevel(value: string | undefined, field: string): string {
    if (value === undefined) return '0';
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '0') return '0';
    const parsed = parseScaledDecimal(trimmed, field, BrokerErrorCode.INVALID_PRICE);
    if (parsed.negative) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_PRICE,
        `Field "${field}" must be a positive price decimal string.`,
      );
    }
    return trimmed;
  }
}
