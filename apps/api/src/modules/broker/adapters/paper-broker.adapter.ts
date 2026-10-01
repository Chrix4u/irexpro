import { Injectable, Logger, Optional } from '@nestjs/common';
import { readFileSync } from 'node:fs';
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
import { PaperBrokerStateService } from '../services/paper-broker-state.service';
import { LivePaperMarketDataService } from '../services/live-paper-market-data.service';

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
  /** Mark observation metadata when known. */
  timestamp?: Date;
  /** Mark provenance for live, candle-fallback, or deterministic simulation. */
  source?: 'STREAM' | 'REST_M5' | 'SIMULATED';
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

  restoreTickCounter(tickCounter: number): void {
    if (!Number.isSafeInteger(tickCounter) || tickCounter < 0) {
      throw new Error('Paper feed tick counter must be a non-negative safe integer');
    }
    const cycleLength = PAPER_TICK_STEPS_UNITS.length;
    const cycleSum = PAPER_TICK_STEPS_UNITS.reduce((sum, step) => sum + step, 0n);
    const completeCycles = Math.floor(tickCounter / cycleLength);
    const remainder = tickCounter % cycleLength;
    let bidUnits = 110_000n + cycleSum * BigInt(completeCycles);
    for (let index = 0; index < remainder; index += 1) {
      bidUnits += PAPER_TICK_STEPS_UNITS[index]!;
    }
    this.bidUnits = bidUnits;
    this.stepIndex = tickCounter;
  }

  private format(): PaperQuote {
    return {
      bid: formatScaledDecimal(this.bidUnits, PAPER_PRICE_SCALE),
      ask: formatScaledDecimal(this.bidUnits + PAPER_SPREAD_UNITS, PAPER_PRICE_SCALE),
    };
  }
}

interface PaperReplayRow {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  tickVolume: string;
  spreadPoints: string;
  priceDigits: number;
}

/** Optional real-market USDJPY M1 replay for Research PAPER UAT only. */
class CsvReplayPaperPriceFeed extends PaperPriceFeed {
  readonly instrument = 'USDJPY';
  private readonly rows: PaperReplayRow[];
  private readonly startCursor: number;
  private cursor: number;

  constructor(path: string, replayStartIso: string) {
    super();
    const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
    if (lines.length < 3) throw new Error('Paper replay CSV has insufficient rows');
    const headers = lines[0]!.split(',');
    const idx = Object.fromEntries(headers.map((h, i) => [h.trim(), i]));
    const required = [
      'timestamp',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'tick_volume',
      'spread_points',
      'price_digits',
    ];
    for (const name of required)
      if (idx[name] === undefined) throw new Error(`Paper replay CSV missing ${name}`);
    this.rows = lines
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const c = line.split(',');
        return {
          timestamp: new Date(c[idx.timestamp]!),
          open: c[idx.open]!,
          high: c[idx.high]!,
          low: c[idx.low]!,
          close: c[idx.close]!,
          volume: c[idx.volume] || c[idx.tick_volume] || '0',
          tickVolume: c[idx.tick_volume] || c[idx.volume] || '0',
          spreadPoints: c[idx.spread_points] || '0',
          priceDigits: Number(c[idx.price_digits] || '3'),
        };
      });
    const replayStart = new Date(replayStartIso).getTime();
    const first = this.rows.findIndex((row) => row.timestamp.getTime() >= replayStart);
    if (first <= 0) throw new Error('Paper replay start requires prior context row');
    this.cursor = first - 1;
    this.startCursor = this.cursor;
  }

  quote(): PaperQuote {
    return this.quoteFor(this.rows[this.cursor]!);
  }
  tick(): PaperQuote {
    if (this.cursor < this.rows.length - 1) this.cursor += 1;
    return this.quote();
  }
  restoreTickCounter(tickCounter: number): void {
    if (!Number.isSafeInteger(tickCounter) || tickCounter < 0) {
      throw new Error('Paper replay tick counter must be a non-negative safe integer');
    }
    this.cursor = Math.min(this.rows.length - 1, this.startCursor + tickCounter);
  }
  now(): Date {
    return new Date(this.rows[this.cursor]!.timestamp);
  }
  digits(): number {
    return this.rows[this.cursor]!.priceDigits;
  }

  ohlcv(timeframe: string, count: number): OHLCV[] {
    const spacingMs = PAPER_TIMEFRAME_MS[timeframe];
    if (!spacingMs)
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `Unsupported paper-market timeframe: ${timeframe}`,
      );
    const source = this.rows.slice(0, this.cursor + 1);
    const buckets = new Map<number, PaperReplayRow[]>();
    for (const row of source) {
      const key = Math.floor(row.timestamp.getTime() / spacingMs) * spacingMs;
      const bucket = buckets.get(key) ?? [];
      bucket.push(row);
      buckets.set(key, bucket);
    }
    const requiredRows = Math.max(1, Math.trunc(spacingMs / 60_000));
    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .filter(([, rows]) => rows.length === requiredRows)
      .slice(-count)
      .map(([key, rows]) => {
        const first = rows[0]!,
          last = rows[rows.length - 1]!;
        const high = Math.max(...rows.map((r) => Number(r.high)));
        const low = Math.min(...rows.map((r) => Number(r.low)));
        const volume = rows.reduce((sum, r) => sum + Number(r.volume || 0), 0);
        const ticks = rows.reduce((sum, r) => sum + Number(r.tickVolume || 0), 0);
        return {
          timestamp: new Date(key),
          open: first.open,
          high: high.toFixed(last.priceDigits),
          low: low.toFixed(last.priceDigits),
          close: last.close,
          volume: String(volume),
          tickVolume: String(ticks),
          spreadPoints: last.spreadPoints,
          priceDigits: last.priceDigits,
          brokerTime: last.timestamp.toISOString(),
        };
      });
  }

  private quoteFor(row: PaperReplayRow): PaperQuote {
    const digits = row.priceDigits;
    const mid = Number(row.close);
    const spread = Number(row.spreadPoints || '0') * 10 ** -digits;
    const renderDigits = Math.min(8, digits + 1);
    return {
      bid: (mid - spread / 2).toFixed(renderDigits),
      ask: (mid + spread / 2).toFixed(renderDigits),
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

  restoreTickCounter(tickCounter: number): void {
    if (!Number.isSafeInteger(tickCounter) || tickCounter < 0) {
      throw new Error('Paper clock tick counter must be a non-negative safe integer');
    }
    this.offsetMs = tickCounter * PAPER_TICK_DURATION_MS;
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
  const scale = Math.max(
    (quote.bid.split('.')[1] ?? '').length,
    (quote.ask.split('.')[1] ?? '').length,
  );
  return divideDecimalStrings(addDecimalStrings(quote.bid, quote.ask), '2', scale);
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

type SerializedPaperWorkingOrder = Omit<PaperWorkingOrder, 'placedAt'> & {
  placedAt: string;
};

type SerializedPaperPosition = Omit<PaperPosition, 'units' | 'openedAt'> & {
  units: string;
  openedAt: string;
};

type SerializedPaperClosedTrade = Omit<PaperClosedTrade, 'openedAt' | 'closedAt'> & {
  openedAt: string;
  closedAt: string;
};

type SerializedBrokerOrderState = Omit<BrokerOrderState, 'placedAt' | 'updatedAt' | 'raw'> & {
  placedAt?: string | null;
  updatedAt?: string | null;
};

type SerializedBrokerOrderResult = Omit<BrokerOrderResult, 'filledAt' | 'rawResponse'> & {
  filledAt?: string;
};

interface PaperBrokerDurableStateV1 {
  version: 1;
  orderCounter: number;
  marketTickCounter: number;
  balance: string;
  working: SerializedPaperWorkingOrder[];
  positions: SerializedPaperPosition[];
  closedTrades: SerializedPaperClosedTrade[];
  orderStates: Array<[string, SerializedBrokerOrderState]>;
  resultsByDedupeKey: Array<[string, SerializedBrokerOrderResult]>;
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
  private readonly _replayFeed: CsvReplayPaperPriceFeed | null;
  private readonly _clock: PaperClock;
  private readonly _working: PaperWorkingOrder[] = [];
  private readonly _positions = new Map<string, PaperPosition>();
  private readonly _closedTrades: PaperClosedTrade[] = [];
  /** Provider order states (working + terminal) — the getOrderById surface. */
  private readonly _orderStates = new Map<string, BrokerOrderState>();
  /** True-dedupe acknowledgement store, keyed by clientOrderId ?? idempotencyKey. */
  private readonly _resultsByDedupeKey = new Map<string, BrokerOrderResult>();
  private readonly _stateStore?: PaperBrokerStateService;
  private readonly _connectionId?: string;
  private _stateLoaded = false;
  private _persistQueue: Promise<void> = Promise.resolve();

  /**
   * The feed and clock are constructor-injectable determinism seams for specs
   * (scripted falling walks, fake clocks). Under Nest DI both are optional and
   * default to the deterministic implementations above.
   */
  constructor(
    @Optional() priceFeed?: PaperPriceFeed,
    @Optional() clock?: PaperClock,
    @Optional() stateStore?: PaperBrokerStateService,
    @Optional() connectionId?: string,
    @Optional() private readonly liveMarketData?: LivePaperMarketDataService,
  ) {
    const liveMode = Boolean(liveMarketData?.isLiveConnection(connectionId));
    const replayPath =
      !priceFeed && !liveMode ? (process.env.PAPER_REPLAY_M1_CSV ?? '').trim() : '';
    const replayStart = (process.env.PAPER_REPLAY_START ?? '').trim();
    this._replayFeed =
      replayPath && replayStart ? new CsvReplayPaperPriceFeed(replayPath, replayStart) : null;
    this._feed = priceFeed ?? this._replayFeed ?? new DeterministicPaperPriceFeed();
    this._clock = clock ?? new DeterministicPaperClock();
    this._stateStore = stateStore;
    this._connectionId = connectionId;
  }

  private isLiveMarketMode(): boolean {
    return this.liveMarketData?.isLiveConnection(this._connectionId) ?? false;
  }

  private currentTime(): Date {
    if (this.isLiveMarketMode()) return this.liveMarketData!.now();
    return this._replayFeed ? this._replayFeed.now() : this._clock.now();
  }

  private quoteForInstrument(instrument: string): PaperQuote {
    if (this.isLiveMarketMode()) {
      const quote = this.liveMarketData!.getQuote(instrument);
      return {
        bid: quote.bid,
        ask: quote.ask,
        timestamp: quote.timestamp,
        source: quote.source,
      };
    }
    // Never value a durable position using another instrument's fallback feed.
    // This is especially important across process restarts while a VPS-live
    // PAPER position is still open and the in-memory live cache is rebuilding.
    this.requireInstrument(instrument);
    return {
      ...this._feed.quote(),
      timestamp: this.currentTime(),
      source: 'SIMULATED',
    };
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
    // Preserve the historical synchronous-connect seam for isolated test/
    // ephemeral adapters. Persisted connection adapters restore before use.
    if (this._stateStore && this._connectionId) {
      await this.restoreDurableState();
    }
    this._connected = true;
    if (this._stateStore && this._connectionId) {
      await this.persistDurableState();
    }
    this.logger.log(
      `PaperBrokerAdapter connected (simulated)${this._connectionId ? ' [durable]' : ''}`,
    );
    return {
      success: true,
      accountId: PAPER_ACCOUNT_ID,
      accountType: BrokerMode.DEMO,
      currency: PAPER_CURRENCY,
      serverTime: this.currentTime(),
    };
  }

  async disconnect(): Promise<void> {
    await this.persistDurableState();
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

  /**
   * Default simulator: EURUSD. Research replay: USDJPY. VPS live-paper mode:
   * fixed six-major universe, validated by LivePaperMarketDataService.
   */
  private requireInstrument(instrument: string): string {
    const symbol = instrument.trim().toUpperCase();
    if (this.isLiveMarketMode()) {
      this.liveMarketData!.spec(symbol);
      return symbol;
    }
    const supported = this._replayFeed ? this._replayFeed.instrument : PAPER_INSTRUMENT;
    if (symbol !== supported) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `Paper broker supports ${supported} only in the active feed (received "${instrument}").`,
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
      timestamp: this.currentTime(),
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
      try {
        this.requireInstrument(params.instrument);
      } catch {
        return null;
      }
      const lot = parseScaledDecimal(params.lotSize, 'lotSize', BrokerErrorCode.INVALID_LOT_SIZE);
      if (lot.negative || lot.digits === 0n) return null;
      // Any exact lot-step spelling is calculable; non-step values are not.
      try {
        lotSizeToUnits(params.lotSize);
      } catch {
        return null;
      }

      const quote = this.quoteForInstrument(params.instrument);
      const mid = quoteMid(quote);
      const product = multiplyDecimalStrings(
        multiplyDecimalStrings(params.lotSize.trim(), PAPER_CONTRACT_SIZE),
        mid,
      );
      const quoteMargin = divideByPowerOfTen(product, 2);
      const accountMargin = this.quoteAmountToAccountCurrencyExact(
        params.instrument,
        quoteMargin,
        mid,
      );
      return roundHalfUpAtScale(accountMargin, PAPER_MONEY_SCALE);
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
    let equity = this._balance;
    let margin = '0.00';
    for (const position of this._positions.values()) {
      const quote = this.quoteForInstrument(position.instrument);
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

  /**
   * Convert an amount expressed in an FX instrument's quote currency into the
   * PAPER account currency. The simulator is USD-denominated and supports
   * either USD as quote (EURUSD) or USD as base (USDJPY Research UAT).
   * Third-currency conversions are never invented.
   */
  private quoteAmountToAccountCurrencyExact(
    instrument: string,
    quoteAmount: string,
    conversionPrice: string,
  ): string {
    const symbol = instrument.trim().toUpperCase();
    if (!/^[A-Z]{6}$/.test(symbol)) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `Cannot prove FX base/quote currencies for ${instrument}.`,
      );
    }
    const baseCurrency = symbol.slice(0, 3);
    const quoteCurrency = symbol.slice(3, 6);
    if (quoteCurrency === PAPER_CURRENCY) return quoteAmount;
    if (baseCurrency === PAPER_CURRENCY) {
      return divideDecimalStrings(quoteAmount, conversionPrice, 12);
    }
    throw new BrokerAdapterError(
      BrokerErrorCode.INVALID_INSTRUMENT,
      `Paper account currency ${PAPER_CURRENCY} matches neither leg of ${symbol}.`,
    );
  }

  /** Required margin converted into the PAPER account currency. */
  private marginInAccountCurrencyExact(
    instrument: string,
    units: bigint,
    entryPrice: string,
  ): string {
    const quoteMargin = divideByPowerOfTen(multiplyDecimalStrings(units.toString(), entryPrice), 2);
    return this.quoteAmountToAccountCurrencyExact(instrument, quoteMargin, entryPrice);
  }

  /** (currentPrice − entry) × units, converted into account currency. */
  private unrealisedPnlExact(position: PaperPosition, quote: PaperQuote): string {
    const exitPrice = position.direction === 'BUY' ? quote.bid : quote.ask;
    const diff =
      position.direction === 'BUY'
        ? subtractDecimalStrings(exitPrice, position.entryPrice)
        : subtractDecimalStrings(position.entryPrice, exitPrice);
    const quotePnl = multiplyDecimalStrings(diff, position.units.toString());
    return this.quoteAmountToAccountCurrencyExact(position.instrument, quotePnl, exitPrice);
  }

  /** Margin locked at fill and denominated in the account currency. */
  private positionMarginExact(position: PaperPosition): string {
    return this.marginInAccountCurrencyExact(
      position.instrument,
      position.units,
      position.entryPrice,
    );
  }

  private mapPosition(position: PaperPosition): BrokerPosition {
    const liveQuote = this.isLiveMarketMode()
      ? this.liveMarketData!.getMarkQuote(position.instrument)
      : null;
    const quote: PaperQuote = liveQuote
      ? {
          bid: liveQuote.bid,
          ask: liveQuote.ask,
          timestamp: liveQuote.timestamp,
          source: liveQuote.source,
        }
      : this.quoteForInstrument(position.instrument);
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
      markObservedAt: liveQuote?.timestamp ?? null,
      markSource: liveQuote?.source ?? null,
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
    if (this.isLiveMarketMode()) {
      return this.liveMarketData!.instruments.map((symbol) => {
        const spec = this.liveMarketData!.spec(symbol);
        return {
          symbol,
          description: `${spec.description} (VPS Live PAPER)`,
          digits: spec.digits,
          minLot: PAPER_MIN_LOT,
          maxLot: PAPER_MAX_LOT,
          lotStep: '0.01',
          contractSize: PAPER_CONTRACT_SIZE,
        };
      });
    }
    const symbol = this._replayFeed ? this._replayFeed.instrument : PAPER_INSTRUMENT;
    return [
      {
        symbol,
        description: this._replayFeed
          ? 'US Dollar vs Japanese Yen (Real-data Paper Replay)'
          : 'Euro vs US Dollar (Paper)',
        digits: this._replayFeed ? this._replayFeed.digits() : PAPER_PRICE_SCALE,
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
  async getCurrentPrice(
    instrument: string,
    options?: { advanceSimulation?: boolean },
  ): Promise<BrokerPrice> {
    this.assertConnected();
    const symbol = this.requireInstrument(instrument);
    if (this.isLiveMarketMode()) {
      const liveQuote = this.liveMarketData!.getQuote(symbol);
      const quote: PaperQuote = { bid: liveQuote.bid, ask: liveQuote.ask };
      // First replay every fully closed M5 candle since each position opened.
      // This captures an SL/TP touched inside a candle even when the scanner
      // polls only every 10 minutes. If both levels were touched in the same
      // candle we conservatively count the stop first (unknown intrabar path).
      this.evaluateLiveCandleProtection(symbol);
      // getQuote() is deliberately the closed-M5 execution/evidence quote.
      // Streaming ticks are consumed only by getMarkQuote() for Current/P&L,
      // so all six pairs keep identical v5 SL/TP and resting-order semantics.
      this._marketTickCounter += 1;
      this.evaluatePositions(quote, symbol);
      this.evaluateWorkingOrders(quote, symbol);
      await this.persistDurableState();
      return {
        instrument: symbol,
        bid: quote.bid,
        ask: quote.ask,
        spread: subtractDecimalStrings(quote.ask, quote.bid),
        timestamp: liveQuote.timestamp,
      };
    }
    const shouldAdvance = !this._replayFeed || options?.advanceSimulation === true;
    const quote = shouldAdvance ? this.advanceMarket() : this._feed.quote();
    if (shouldAdvance) {
      await this.persistDurableState();
    }
    return {
      instrument: symbol,
      bid: quote.bid,
      ask: quote.ask,
      spread: subtractDecimalStrings(quote.ask, quote.bid),
      timestamp: this.currentTime(),
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

    if (this.isLiveMarketMode()) {
      return this.liveMarketData!.getOHLCV(instrument, normalizedTimeframe, count);
    }

    if (this._replayFeed) {
      return this._replayFeed.ohlcv(normalizedTimeframe, count);
    }

    // Deterministic but EVOLVING candles. The market tick counter is advanced
    // by the explicit paper heartbeat (getCurrentPrice) once per AI scan; OHLCV
    // reads are pure snapshots so an MTF evaluation does not tick five times.
    const candles: OHLCV[] = [];
    const base = 1.1;
    const now = this.currentTime();
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
        const placedAt = this.currentTime();
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
      await this.persistDurableState();
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
    const quote = this.quoteForInstrument(instrument);
    const fillPrice = quoteMid(quote);
    const units = lotSizeToUnits(order.lotSize);
    const requiredMargin = toMoney(this.marginInAccountCurrencyExact(instrument, units, fillPrice));
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
      placedAt: this.currentTime(),
      updatedAt: this.currentTime(),
    });
    return {
      success: true,
      externalOrderId: orderId,
      filledPrice: fillPrice,
      filledQuantity: order.lotSize.trim(),
      filledAt: this.currentTime(),
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
      openedAt: this.currentTime(),
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
      await this.persistDurableState();
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
      const quote = this.quoteForInstrument(position.instrument);
      const closePrice = quoteMid(quote);

      const closedTrade = this.closePositionUnits(
        position,
        closeUnits,
        closedLot,
        closePrice,
        'MANUAL',
      );
      await this.persistDurableState();
      return {
        success: true,
        externalOrderId,
        filledPrice: closePrice,
        filledQuantity: closedLot,
        filledAt: closedTrade.closedAt,
        realisedPnl: closedTrade.realisedPnl,
        commission: closedTrade.commission,
        swap: closedTrade.swap,
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
      const now = this.currentTime();
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
      await this.persistDurableState();
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
      let closedCount = 0;
      let failedCount = 0;
      const errors: string[] = [];

      for (const position of Array.from(this._positions.values())) {
        try {
          const quote = this.quoteForInstrument(position.instrument);
          const closePrice = quoteMid(quote);
          this.closePositionUnits(position, position.units, position.lotSize, closePrice, 'SYSTEM');
          closedCount++;
        } catch (err) {
          failedCount++;
          errors.push(String((err as Error).message));
        }
      }

      await this.persistDurableState();
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
    if (!this._replayFeed) this._clock.advance(PAPER_TICK_DURATION_MS);
    this.evaluatePositions(quote);
    this.evaluateWorkingOrders(quote);
    return quote;
  }

  /**
   * Live PAPER M5 protection path. Twelve Data supplies closed-candle MID OHLC,
   * while this simulator executes against a documented fixed bid/ask spread.
   * Convert candle extremes to the relevant executable side and conservatively
   * evaluate SL before TP when both were touched in one candle.
   */
  private evaluateLiveCandleProtection(instrument: string): void {
    if (!this.isLiveMarketMode()) return;
    const symbol = this.requireInstrument(instrument);
    const spec = this.liveMarketData!.spec(symbol);
    const candles = this.liveMarketData!.getOHLCV(symbol, 'M5', 500);
    const halfSpread = spec.spread / 2;

    for (const position of Array.from(this._positions.values())) {
      if (position.instrument !== symbol) continue;
      for (const candle of candles) {
        // Candle timestamps are bar-open times; only bars that CLOSED after
        // the fill can contain post-entry price action.
        const candleClosedAt = new Date(candle.timestamp.getTime() + 5 * 60_000);
        if (candleClosedAt.getTime() <= position.openedAt.getTime()) continue;

        const high = Number(candle.high);
        const low = Number(candle.low);
        if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

        if (position.direction === 'BUY') {
          const bidLow = (low - halfSpread).toFixed(spec.digits);
          const bidHigh = (high - halfSpread).toFixed(spec.digits);
          if (
            !isZeroLevel(position.stopLoss) &&
            compareDecimalStrings(bidLow, position.stopLoss) <= 0
          ) {
            this.closePositionUnits(
              position,
              position.units,
              position.lotSize,
              position.stopLoss,
              'SL',
              candleClosedAt,
            );
            break;
          }
          if (
            !isZeroLevel(position.takeProfit) &&
            compareDecimalStrings(bidHigh, position.takeProfit) >= 0
          ) {
            this.closePositionUnits(
              position,
              position.units,
              position.lotSize,
              position.takeProfit,
              'TP',
              candleClosedAt,
            );
            break;
          }
        } else {
          const askHigh = (high + halfSpread).toFixed(spec.digits);
          const askLow = (low + halfSpread).toFixed(spec.digits);
          if (
            !isZeroLevel(position.stopLoss) &&
            compareDecimalStrings(askHigh, position.stopLoss) >= 0
          ) {
            this.closePositionUnits(
              position,
              position.units,
              position.lotSize,
              position.stopLoss,
              'SL',
              candleClosedAt,
            );
            break;
          }
          if (
            !isZeroLevel(position.takeProfit) &&
            compareDecimalStrings(askLow, position.takeProfit) <= 0
          ) {
            this.closePositionUnits(
              position,
              position.units,
              position.lotSize,
              position.takeProfit,
              'TP',
              candleClosedAt,
            );
            break;
          }
        }
      }
    }
  }

  /**
   * Position SL/TP (SL checked before TP — conservative). SL/TP close exactly
   * at their level (resting protection orders; no gap slippage modeled).
   */
  private evaluatePositions(quote: PaperQuote, instrumentFilter?: string): void {
    for (const position of Array.from(this._positions.values())) {
      if (instrumentFilter && position.instrument !== instrumentFilter) continue;
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
  private evaluateWorkingOrders(quote: PaperQuote, instrumentFilter?: string): void {
    for (const order of Array.from(this._working)) {
      if (instrumentFilter && order.instrument !== instrumentFilter) continue;
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
      this.marginInAccountCurrencyExact(order.instrument, units, fillPrice),
    );
    if (compareDecimalStrings(requiredMargin, this.freeMargin()) > 0) {
      // No caller to notify on a deferred fill — the order transitions to a
      // terminal REJECTED state and leaves the working set (documented).
      this.removeWorkingOrder(order.orderId);
      this._orderStates.set(order.orderId, {
        ...this.workingOrderState(order),
        status: 'REJECTED',
        updatedAt: this.currentTime(),
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
      updatedAt: this.currentTime(),
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
    closedAtOverride?: Date,
  ): PaperClosedTrade {
    const diff =
      position.direction === 'BUY'
        ? subtractDecimalStrings(closePrice, position.entryPrice)
        : subtractDecimalStrings(position.entryPrice, closePrice);
    const quotePnl = multiplyDecimalStrings(diff, closeUnits.toString());
    const realisedPnl = toMoney(
      this.quoteAmountToAccountCurrencyExact(position.instrument, quotePnl, closePrice),
    );
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
      closedAt: closedAtOverride ? new Date(closedAtOverride) : this.currentTime(),
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

  private durableSnapshot(): PaperBrokerDurableStateV1 {
    const orderStates: Array<[string, SerializedBrokerOrderState]> = Array.from(
      this._orderStates.entries(),
      ([key, value]) => {
        const { raw: ignoredRaw, placedAt, updatedAt, ...rest } = value;
        void ignoredRaw;
        return [
          key,
          {
            ...rest,
            placedAt: placedAt?.toISOString() ?? null,
            updatedAt: updatedAt?.toISOString() ?? null,
          },
        ];
      },
    );
    const resultsByDedupeKey: Array<[string, SerializedBrokerOrderResult]> = Array.from(
      this._resultsByDedupeKey.entries(),
      ([key, value]) => {
        const { rawResponse: ignoredRawResponse, filledAt, ...rest } = value;
        void ignoredRawResponse;
        return [
          key,
          {
            ...rest,
            filledAt: filledAt?.toISOString(),
          },
        ];
      },
    );

    return {
      version: 1,
      orderCounter: this._orderCounter,
      marketTickCounter: this._marketTickCounter,
      balance: this._balance,
      working: this._working.map((order) => ({
        ...order,
        placedAt: order.placedAt.toISOString(),
      })),
      positions: Array.from(this._positions.values()).map((position) => ({
        ...position,
        units: position.units.toString(),
        openedAt: position.openedAt.toISOString(),
      })),
      closedTrades: this._closedTrades.map((trade) => ({
        ...trade,
        openedAt: trade.openedAt.toISOString(),
        closedAt: trade.closedAt.toISOString(),
      })),
      orderStates,
      resultsByDedupeKey,
    };
  }

  private async restoreDurableState(): Promise<void> {
    if (this._stateLoaded || !this._stateStore || !this._connectionId) return;

    const raw = await this._stateStore.load(this._connectionId);
    this._stateLoaded = true;
    if (!raw) return;

    const state = raw as unknown as PaperBrokerDurableStateV1;
    if (
      state.version !== 1 ||
      !Number.isSafeInteger(state.orderCounter) ||
      !Number.isSafeInteger(state.marketTickCounter) ||
      state.orderCounter < 0 ||
      state.marketTickCounter < 0 ||
      typeof state.balance !== 'string' ||
      !Array.isArray(state.working) ||
      !Array.isArray(state.positions) ||
      !Array.isArray(state.closedTrades) ||
      !Array.isArray(state.orderStates) ||
      !Array.isArray(state.resultsByDedupeKey)
    ) {
      throw new Error('Invalid durable paper broker state for connection ' + this._connectionId);
    }

    this._orderCounter = state.orderCounter;
    this._marketTickCounter = state.marketTickCounter;
    this._balance = state.balance;

    this._working.splice(
      0,
      this._working.length,
      ...state.working.map((order) => ({
        ...order,
        placedAt: new Date(order.placedAt),
      })),
    );

    this._positions.clear();
    for (const position of state.positions) {
      this._positions.set(position.positionId, {
        ...position,
        units: BigInt(position.units),
        openedAt: new Date(position.openedAt),
      });
    }

    this._closedTrades.splice(
      0,
      this._closedTrades.length,
      ...state.closedTrades.map((trade) => ({
        ...trade,
        openedAt: new Date(trade.openedAt),
        closedAt: new Date(trade.closedAt),
      })),
    );

    this._orderStates.clear();
    for (const [key, value] of state.orderStates) {
      this._orderStates.set(key, {
        ...value,
        placedAt: value.placedAt ? new Date(value.placedAt) : null,
        updatedAt: value.updatedAt ? new Date(value.updatedAt) : null,
      });
    }

    this._resultsByDedupeKey.clear();
    for (const [key, value] of state.resultsByDedupeKey) {
      this._resultsByDedupeKey.set(key, {
        ...value,
        filledAt: value.filledAt ? new Date(value.filledAt) : undefined,
      });
    }

    if (this._feed instanceof DeterministicPaperPriceFeed) {
      this._feed.restoreTickCounter(this._marketTickCounter);
    }
    if (this._replayFeed) {
      this._replayFeed.restoreTickCounter(this._marketTickCounter);
    }
    if (this._clock instanceof DeterministicPaperClock) {
      this._clock.restoreTickCounter(this._marketTickCounter);
    }

    this.logger.log(
      'PaperBrokerAdapter restored durable state connection=' +
        this._connectionId +
        ' positions=' +
        this._positions.size +
        ' working=' +
        this._working.length +
        ' closed=' +
        this._closedTrades.length +
        ' tick=' +
        this._marketTickCounter,
    );
  }

  private async persistDurableState(): Promise<void> {
    if (!this._stateStore || !this._connectionId) return;
    const snapshot = this.durableSnapshot() as unknown as Record<string, unknown>;
    const write = this._persistQueue.then(() =>
      this._stateStore!.save(this._connectionId!, snapshot),
    );
    this._persistQueue = write.catch(() => undefined);
    await write;
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
