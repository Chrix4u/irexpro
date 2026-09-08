import {
  ReconciliationDiscrepancySeverity,
  ReconciliationDiscrepancyType,
  ReconciliationRefType,
} from './reconciliation.enums';
import {
  BrokerAccountInfo,
  BrokerOrderState,
  BrokerPosition,
} from '../../broker/interfaces/broker-adapter.interface';

/**
 * ReconciliationComparator — PURE diff of internal state vs provider state
 * (Directive PHASE G + §25). No I/O, no services, no clock — everything it
 * needs arrives as input snapshots; time-dependent decisions (grace periods)
 * receive `now` as a parameter. Exhaustively unit-testable by construction.
 *
 * DECIMAL SAFETY: all comparisons between numeric fields use
 * string-decimal arithmetic (BigInt-scaled) — never JS floats.
 *
 * FAIL-CLOSED: anything the comparator cannot confidently classify is
 * surfaced as a discrepancy (never silently dropped), and provider values
 * it does not recognize (e.g. UNKNOWN order state) never drive resolutions.
 */

// ─── Input snapshots ─────────────────────────────────────────────────────────

/** Internal view of ONE non-terminal order (safe projection of Order). */
export interface InternalOrderSnapshot {
  orderId: string;
  clientOrderId: string;
  providerOrderId: string | null;
  status: string;
  orderKind: string;
  instrument: string;
  requestedQuantity: string;
  filledQuantity: string;
  avgFillPrice: string | null;
  submittedAt: Date | null;
  tradeId: string | null;
}

/** Internal view of ONE open/pending trade (safe projection of Trade). */
export interface InternalTradeSnapshot {
  tradeId: string;
  externalOrderId: string | null;
  externalPositionId: string | null;
  status: string;
  instrument: string;
  lotSize: string;
  fillPrice: string | null;
  openedAt: Date | null;
}

/** Internal stored account snapshot (BrokerAccount projection). */
export interface InternalAccountSnapshot {
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  marginLevel: string;
  currency: string | null;
  leverage: number | null;
}

/** Full provider-side state for one connection (read in one pass). */
export interface ProviderStateSnapshot {
  orders: BrokerOrderState[];
  positions: BrokerPosition[];
  account: BrokerAccountInfo;
}

/** Internal-side state for one connection. */
export interface InternalStateSnapshot {
  orders: InternalOrderSnapshot[];
  trades: InternalTradeSnapshot[];
  account: InternalAccountSnapshot | null;
}

/** What one detected mismatch looks like before persistence. */
export interface DiscrepancyCandidate {
  type: ReconciliationDiscrepancyType;
  severity: ReconciliationDiscrepancySeverity;
  internalRefType: ReconciliationRefType | null;
  internalRefId: string | null;
  providerRef: string | null;
  clientOrderId: string | null;
  details: Record<string, unknown>;
}

/** Comparator options (defaults below). */
export interface ComparatorOptions {
  /**
   * Account fields are compared with a relative tolerance to absorb
   * live-market movement between internal sync and provider read.
   * Default: 0.5% (0.005). Absolute floor of 0.01 in account units.
   */
  accountDriftTolerance: number;
  /**
   * Orders/trades in RECONCILIATION_PENDING younger than this (ms) are
   * assumed still resolving (Directive §26 gives the resolution loop time
   * to query the provider). Default: 5 minutes.
   */
  unresolvedGraceMs: number;
}

export const DEFAULT_COMPARATOR_OPTIONS: ComparatorOptions = {
  accountDriftTolerance: 0.005,
  unresolvedGraceMs: 5 * 60_000,
};

/** Order statuses reconciliation expects to see at the provider. */
const PROVIDER_EXPECTED_ORDER_STATUSES = new Set([
  'SUBMITTED',
  'ACKNOWLEDGED',
  'PARTIALLY_FILLED',
  'RECONCILIATION_PENDING',
]);

/** Trade statuses that hold a live provider-side position. */
const POSITION_HOLDING_TRADE_STATUSES = new Set(['OPEN', 'RECONCILIATION_PENDING']);

// ─── Decimal helpers (string-decimal, no floats) ────────────────────────────

/** Parse a decimal string into scaled BigInt at `scale` digits. */
function toScaledBigInt(value: string, scale: number): bigint {
  const trimmed = String(value ?? '0').trim();
  const neg = trimmed.startsWith('-');
  const unsigned = neg ? trimmed.slice(1) : trimmed;
  const [intPart = '0', fracPartRaw = ''] = unsigned.split('.');
  const fracPart = (fracPartRaw + '0'.repeat(scale)).slice(0, scale);
  const combined = BigInt(intPart || '0') * 10n ** BigInt(scale) + BigInt(fracPart || '0');
  return neg ? -combined : combined;
}

/** Compare two decimal strings at a safe scale. Returns -1 | 0 | 1. */
export function compareDecimal(a: string, b: string, scale = 10): number {
  const av = toScaledBigInt(a, scale);
  const bv = toScaledBigInt(b, scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** |a - b| relative to |a| exceeds tolerance (both decimal strings). */
function driftExceeds(expected: string, observed: string, tolerance: number): boolean {
  const scale = 10;
  const ev = toScaledBigInt(expected, scale);
  const ov = toScaledBigInt(observed, scale);
  const diff = ev > ov ? ev - ov : ov - ev;
  if (diff === 0n) return false;
  const base = ev < 0n ? -ev : ev;
  // Absolute floor: 0.01 in account units (absorbs rounding noise on 0).
  const floor = 1n * 10n ** BigInt(scale - 2);
  if (diff <= floor) return false;
  if (base === 0n) return true; // moved away from a stored zero
  // diff / base > tolerance  →  diff * 10000 > base * tolerance * 10000
  const toleranceBps = BigInt(Math.round(tolerance * 10_000));
  return diff * 10_000n > base * toleranceBps;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Full comparison of one connection's internal state against its provider
 * state. Returns every directive §25 discrepancy candidate, deduplicated by
 * identity (type + internalRefId + providerRef).
 */
export function compareStates(
  internal: InternalStateSnapshot,
  provider: ProviderStateSnapshot,
  now: Date,
  options: Partial<ComparatorOptions> = {},
): DiscrepancyCandidate[] {
  const opts: ComparatorOptions = { ...DEFAULT_COMPARATOR_OPTIONS, ...options };
  const candidates: DiscrepancyCandidate[] = [
    ...compareOrders(internal.orders, provider.orders, provider.positions, opts),
    ...comparePositions(internal.trades, provider.positions),
    ...compareAccount(internal.account, provider.account, opts),
    ...detectUnresolvedExecutions(internal.orders, internal.trades, now, opts),
  ];

  // Deduplicate by identity (a record can be flagged by two detectors —
  // e.g. a RECONCILIATION_PENDING trade without external id is also
  // position-missing; keep the FIRST, most-specific finding).
  const seen = new Set<string>();
  const unique: DiscrepancyCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.type}|${c.internalRefId ?? ''}|${c.providerRef ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  return unique;
}

// ─── Orders ──────────────────────────────────────────────────────────────────

/**
 * Compare internal non-terminal orders with provider working orders.
 *
 * A provider-known order = appears in provider working orders OR as an open
 * position id (filled market orders become positions — they legitimately
 * leave the working-order list while the internal order is fillable).
 */
export function compareOrders(
  internalOrders: InternalOrderSnapshot[],
  providerOrders: BrokerOrderState[],
  providerPositions: BrokerPosition[],
  _options: Partial<ComparatorOptions> = {},
): DiscrepancyCandidate[] {
  const out: DiscrepancyCandidate[] = [];

  const providerOrderIds = new Set(providerOrders.map((o) => o.providerOrderId));
  const providerPositionIds = new Set(providerPositions.map((p) => p.externalOrderId));
  const internalProviderIds = new Set(
    internalOrders.map((o) => o.providerOrderId).filter((id): id is string => !!id),
  );

  // Duplicate provider IDs across internal orders (§25 "duplicate provider
  // ID") — detected BEFORE presence checks so it is never masked.
  const byProviderId = new Map<string, InternalOrderSnapshot[]>();
  for (const o of internalOrders) {
    if (!o.providerOrderId) continue;
    const list = byProviderId.get(o.providerOrderId) ?? [];
    list.push(o);
    byProviderId.set(o.providerOrderId, list);
  }
  for (const [providerId, orders] of byProviderId) {
    if (orders.length > 1) {
      out.push({
        type: ReconciliationDiscrepancyType.DUPLICATE_PROVIDER_ID,
        severity: ReconciliationDiscrepancySeverity.CRITICAL,
        internalRefType: ReconciliationRefType.ORDER,
        internalRefId: orders[0].orderId,
        providerRef: providerId,
        clientOrderId: orders[0].clientOrderId,
        details: {
          internalOrderIds: orders.map((o) => o.orderId),
          providerOrderId: providerId,
          note: 'Multiple internal orders claim the same provider order id',
        },
      });
    }
  }

  for (const order of internalOrders) {
    // Only states with a provider expectation are compared. CREATED orders
    // were never submitted; terminal orders are beyond provider interest.
    if (!PROVIDER_EXPECTED_ORDER_STATUSES.has(order.status)) continue;

    const knownAtProvider =
      order.providerOrderId !== null &&
      (providerOrderIds.has(order.providerOrderId) ||
        providerPositionIds.has(order.providerOrderId));

    if (!order.providerOrderId) {
      // Submitted without a provider id — an uncertain execution result;
      // reported by detectUnresolvedExecutions (not here: avoid duplicates).
      continue;
    }

    if (!knownAtProvider) {
      // Internal expects the order; provider neither works it nor holds a
      // position for it. The stable identifier exists — the run's resolution
      // phase will query the provider by id (Directive §26) before this is
      // treated as a hard mismatch, so this surfaces as WARNING.
      out.push({
        type: ReconciliationDiscrepancyType.MISSING_PROVIDER_ORDER,
        severity: ReconciliationDiscrepancySeverity.WARNING,
        internalRefType: ReconciliationRefType.ORDER,
        internalRefId: order.orderId,
        providerRef: order.providerOrderId,
        clientOrderId: order.clientOrderId,
        details: {
          internalStatus: order.status,
          instrument: order.instrument,
          orderKind: order.orderKind,
          requestedQuantity: order.requestedQuantity,
          filledQuantity: order.filledQuantity,
          note: 'Provider reports neither a working order nor an open position for this id',
        },
      });
      continue;
    }

    // Present at the provider — check state freshness (§25 "stale order
    // state") when the provider working-order view carries it.
    const providerOrder = providerOrders.find((o) => o.providerOrderId === order.providerOrderId);
    if (providerOrder) {
      out.push(...checkStaleOrderState(order, providerOrder));
    }
  }

  // Provider orders with no internal record (§25 "missing internal order").
  for (const providerOrder of providerOrders) {
    if (internalProviderIds.has(providerOrder.providerOrderId)) continue;

    // Correlate by the caller-supplied stable identifier when present.
    const byClient = internalOrders.find(
      (o) => o.clientOrderId && o.clientOrderId === providerOrder.clientOrderId,
    );
    if (byClient) continue; // internal knows it under a different provider id

    out.push({
      type: ReconciliationDiscrepancyType.MISSING_INTERNAL_ORDER,
      severity: ReconciliationDiscrepancySeverity.CRITICAL,
      internalRefType: null,
      internalRefId: null,
      providerRef: providerOrder.providerOrderId,
      clientOrderId: providerOrder.clientOrderId ?? null,
      details: {
        providerStatus: providerOrder.status,
        instrument: providerOrder.instrument,
        direction: providerOrder.direction,
        orderKind: providerOrder.orderKind ?? null,
        requestedQuantity: providerOrder.requestedQuantity,
        filledQuantity: providerOrder.filledQuantity,
        note: 'Provider holds a working order with no internal record (externally placed?)',
      },
    });
  }

  return out;
}

/**
 * Internal order state vs provider order state for the SAME order.
 * Only INTERNAL-LAGGING states are discrepancies: if the provider has moved
 * the order to a terminal state the internal record must catch up (the run's
 * resolution phase will do so — provider is authoritative, §24).
 */
function checkStaleOrderState(
  order: InternalOrderSnapshot,
  providerOrder: BrokerOrderState,
): DiscrepancyCandidate[] {
  const out: DiscrepancyCandidate[] = [];

  // Provider terminal states with internal still non-terminal → stale.
  const providerTerminal: Record<string, boolean> = {
    FILLED: true,
    CANCELLED: true,
    REJECTED: true,
    EXPIRED: true,
  };

  if (providerTerminal[providerOrder.status]) {
    out.push({
      type: ReconciliationDiscrepancyType.STALE_ORDER_STATE,
      severity: ReconciliationDiscrepancySeverity.WARNING,
      internalRefType: ReconciliationRefType.ORDER,
      internalRefId: order.orderId,
      providerRef: providerOrder.providerOrderId,
      clientOrderId: order.clientOrderId,
      details: {
        internalStatus: order.status,
        providerStatus: providerOrder.status,
        providerFilledQuantity: providerOrder.filledQuantity,
        providerAvgFillPrice: providerOrder.avgFillPrice ?? null,
        note: 'Provider reached a terminal order state; internal state lags',
      },
    });
    return out;
  }

  // UNKNOWN provider state: surface (fail-closed) but never auto-resolve.
  if (providerOrder.status === 'UNKNOWN') {
    out.push({
      type: ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_ORDER,
      severity: ReconciliationDiscrepancySeverity.WARNING,
      internalRefType: ReconciliationRefType.ORDER,
      internalRefId: order.orderId,
      providerRef: providerOrder.providerOrderId,
      clientOrderId: order.clientOrderId,
      details: {
        internalStatus: order.status,
        providerStatus: 'UNKNOWN',
        note: 'Provider reported an unrecognized order state — manual review required',
      },
    });
    return out;
  }

  // Provider filled MORE than internal recorded (fill events missed).
  if (compareDecimal(providerOrder.filledQuantity, order.filledQuantity) > 0) {
    out.push({
      type: ReconciliationDiscrepancyType.STALE_ORDER_STATE,
      severity: ReconciliationDiscrepancySeverity.WARNING,
      internalRefType: ReconciliationRefType.ORDER,
      internalRefId: order.orderId,
      providerRef: providerOrder.providerOrderId,
      clientOrderId: order.clientOrderId,
      details: {
        internalStatus: order.status,
        providerStatus: providerOrder.status,
        internalFilledQuantity: order.filledQuantity,
        providerFilledQuantity: providerOrder.filledQuantity,
        note: 'Provider fill quantity exceeds internal record (missed fill events)',
      },
    });
  }

  return out;
}

// ─── Positions ───────────────────────────────────────────────────────────────

/**
 * Compare internal open/pending trades against provider open positions
 * (§25 "unknown provider position", "position closed externally").
 */
export function comparePositions(
  internalTrades: InternalTradeSnapshot[],
  providerPositions: BrokerPosition[],
): DiscrepancyCandidate[] {
  const out: DiscrepancyCandidate[] = [];

  const providerPositionIds = new Set(providerPositions.map((p) => p.externalOrderId));
  const internalPositionIds = new Set<string>();
  const idOwners = new Map<string, InternalTradeSnapshot[]>();

  for (const trade of internalTrades) {
    if (!POSITION_HOLDING_TRADE_STATUSES.has(trade.status)) continue;
    const ids = [trade.externalOrderId, trade.externalPositionId].filter(
      (id): id is string => !!id,
    );
    for (const id of ids) {
      internalPositionIds.add(id);
      const list = idOwners.get(id) ?? [];
      list.push(trade);
      idOwners.set(id, list);
    }
  }

  // Duplicate provider position id across internal trades (§25 duplicate).
  for (const [id, trades] of idOwners) {
    const uniqueTradeIds = new Set(trades.map((t) => t.tradeId));
    if (uniqueTradeIds.size > 1) {
      out.push({
        type: ReconciliationDiscrepancyType.DUPLICATE_PROVIDER_ID,
        severity: ReconciliationDiscrepancySeverity.CRITICAL,
        internalRefType: ReconciliationRefType.TRADE,
        internalRefId: trades[0].tradeId,
        providerRef: id,
        clientOrderId: null,
        details: {
          internalTradeIds: trades.map((t) => t.tradeId),
          providerPositionId: id,
          note: 'Multiple internal trades claim the same provider position id',
        },
      });
    }
  }

  // Internal open position the provider no longer holds (§25).
  for (const trade of internalTrades) {
    if (!POSITION_HOLDING_TRADE_STATUSES.has(trade.status)) continue;
    if (!trade.externalOrderId) continue; // surfaced by unresolved detection

    const providerHas =
      providerPositionIds.has(trade.externalOrderId) ||
      (trade.externalPositionId !== null && providerPositionIds.has(trade.externalPositionId));

    if (!providerHas) {
      out.push({
        type: ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
        severity: ReconciliationDiscrepancySeverity.WARNING,
        internalRefType: ReconciliationRefType.TRADE,
        internalRefId: trade.tradeId,
        providerRef: trade.externalOrderId,
        clientOrderId: null,
        details: {
          internalStatus: trade.status,
          instrument: trade.instrument,
          internalLotSize: trade.lotSize,
          note: 'Internal position is open but the provider no longer reports it (SL/TP/manual close)',
        },
      });
    }
  }

  // Provider position with no internal record (§25).
  for (const position of providerPositions) {
    if (internalPositionIds.has(position.externalOrderId)) continue;
    out.push({
      type: ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION,
      severity: ReconciliationDiscrepancySeverity.CRITICAL,
      internalRefType: null,
      internalRefId: null,
      providerRef: position.externalOrderId,
      clientOrderId: null,
      details: {
        instrument: position.instrument,
        direction: position.direction,
        lotSize: position.lotSize,
        openPrice: position.openPrice,
        openedAt: position.openedAt?.toISOString?.() ?? null,
        note: 'Provider reports an open position with no internal record (externally opened?)',
      },
    });
  }

  return out;
}

// ─── Account snapshot ────────────────────────────────────────────────────────

/**
 * Compare the STORED internal account snapshot against the provider's
 * account info (§25 "account-state mismatch"). Drift beyond tolerance on
 * monetary fields, or any currency/leverage mismatch, is surfaced.
 */
export function compareAccount(
  internal: InternalAccountSnapshot | null,
  provider: BrokerAccountInfo,
  options: ComparatorOptions,
): DiscrepancyCandidate[] {
  if (!internal) return []; // nothing stored yet — sync will create it

  const drift: Record<string, { expected: string; observed: string }> = {};

  const monetary: Array<[string, string, string]> = [
    ['balance', internal.balance, provider.balance],
    ['equity', internal.equity, provider.equity],
    ['margin', internal.margin, provider.margin],
    ['freeMargin', internal.freeMargin, provider.freeMargin],
    ['marginLevel', internal.marginLevel, provider.marginLevel],
  ];

  for (const [field, expected, observed] of monetary) {
    if (driftExceeds(expected, observed, options.accountDriftTolerance)) {
      drift[field] = { expected, observed };
    }
  }

  const structural: Record<string, unknown> = {};
  if (internal.currency !== null && internal.currency !== provider.currency) {
    structural.currency = { expected: internal.currency, observed: provider.currency };
  }
  if (internal.leverage !== null && internal.leverage !== provider.leverage) {
    structural.leverage = { expected: internal.leverage, observed: provider.leverage };
  }

  if (Object.keys(drift).length === 0 && Object.keys(structural).length === 0) {
    return [];
  }

  return [
    {
      type: ReconciliationDiscrepancyType.ACCOUNT_STATE_MISMATCH,
      severity:
        Object.keys(structural).length > 0
          ? ReconciliationDiscrepancySeverity.CRITICAL
          : ReconciliationDiscrepancySeverity.WARNING,
      internalRefType: ReconciliationRefType.ACCOUNT,
      internalRefId: null,
      providerRef: null,
      clientOrderId: null,
      details: {
        monetaryDrift: drift,
        structuralMismatch: structural,
        note: 'Internal account snapshot diverges from provider account info beyond tolerance',
      },
    },
  ];
}

// ─── Uncertain executions (Directive §26) ────────────────────────────────────

/**
 * Detect RECONCILIATION_PENDING records that have exceeded their grace
 * period without resolution (§25 "unresolved execution result") — including
 * the previously silent case of trades WITHOUT an external id, which older
 * reconciliation skipped forever.
 */
export function detectUnresolvedExecutions(
  internalOrders: InternalOrderSnapshot[],
  internalTrades: InternalTradeSnapshot[],
  now: Date,
  options: ComparatorOptions,
): DiscrepancyCandidate[] {
  const out: DiscrepancyCandidate[] = [];
  const cutoff = now.getTime() - options.unresolvedGraceMs;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  for (const order of internalOrders) {
    if (order.status !== 'RECONCILIATION_PENDING') continue;
    const since = order.submittedAt?.getTime() ?? 0;
    if (since > cutoff) continue; // still within grace — resolution loop active

    out.push({
      type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
      severity: ReconciliationDiscrepancySeverity.WARNING,
      internalRefType: ReconciliationRefType.ORDER,
      internalRefId: order.orderId,
      providerRef: order.providerOrderId,
      clientOrderId: order.clientOrderId,
      details: {
        internalStatus: order.status,
        submittedAt: iso(order.submittedAt),
        hasProviderId: order.providerOrderId !== null,
        note: 'Order in RECONCILIATION_PENDING beyond grace period without resolution',
      },
    });
  }

  for (const trade of internalTrades) {
    if (trade.status !== 'RECONCILIATION_PENDING') continue;
    const since = trade.openedAt?.getTime() ?? 0;
    if (since > cutoff) continue;

    out.push({
      type: ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
      severity: ReconciliationDiscrepancySeverity.WARNING,
      internalRefType: ReconciliationRefType.TRADE,
      internalRefId: trade.tradeId,
      providerRef: trade.externalOrderId,
      clientOrderId: null,
      details: {
        internalStatus: trade.status,
        openedAt: iso(trade.openedAt),
        hasProviderId: trade.externalOrderId !== null,
        note: 'Trade in RECONCILIATION_PENDING beyond grace period without resolution',
      },
    });
  }

  return out;
}
