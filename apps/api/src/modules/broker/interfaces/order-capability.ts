import { BrokerOrderRequest } from './broker-adapter.interface';

/** The normalized order kinds (Sprint 50 PR-3 order model). */
export type NormalizedOrderKind = NonNullable<BrokerOrderRequest['orderKind']>;

/** Field requirements a declared order kind imposes. */
export interface OrderKindRequirement {
  /** limitPrice must be a positive decimal string. */
  limitPriceRequired: boolean;
  /** stopPrice must be a positive decimal string. */
  stopPriceRequired: boolean;
}

/**
 * Round 6 live-execution completion (§7) — the per-adapter ORDER CAPABILITY
 * CONTRACT: a machine-readable declaration of which normalized order kinds
 * the adapter truly supports and what each kind requires.
 *
 * The contract is enforced at TWO layers:
 *   1. PRE-COMMITMENT (orchestrator): assertOrderWithinCapabilities rejects
 *      an intent the connection's adapter can never fulfill — a typed,
 *      zero-provider-call terminal rejection BEFORE the dispatch commitment
 *      (never a provider-side error after the grant was consumed).
 *   2. CONTRACT SUITE: every adapter's declaration is verified against its
 *      actual placeOrder behavior (a declared kind must be accepted, an
 *      undeclared kind must be rejected loudly — never silently downgraded).
 */
export interface OrderCapabilityDeclaration {
  /** brokerId of the declaring adapter (audit + diagnostics). */
  brokerId: string;
  /** Supported normalized order kinds. Anything else fails closed. */
  supportedOrderKinds: readonly NormalizedOrderKind[];
  /** Per-kind required fields (indexed by kind). */
  requirements: Readonly<Record<NormalizedOrderKind, OrderKindRequirement>>;
  /**
   * Whether MARKET orders attach SL/TP at PLACEMENT time. FALSE means the
   * adapter defers protective attachment to the POSITION after the fill
   * (the cTrader model — §8's protective loop verifies both shapes).
   */
  marketSlTpAttachedAtPlacement: boolean;
}

/** Typed §26-style stable machine codes for capability violations. */
export type OrderCapabilityViolationCode =
  | 'ORDER_KIND_NOT_SUPPORTED'
  | 'LIMIT_PRICE_REQUIRED'
  | 'STOP_PRICE_REQUIRED';

/** Typed fail-closed capability violation (zero provider calls). */
export class OrderCapabilityError extends Error {
  constructor(
    readonly code: OrderCapabilityViolationCode,
    readonly brokerId: string,
    message: string,
  ) {
    super(`Order capability contract violation [${code}] on ${brokerId}: ${message}`);
    this.name = 'OrderCapabilityError';
  }
}

const isPositiveDecimalString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== '' && Number(value) > 0 && Number.isFinite(Number(value));

/**
 * Assert ONE order request is within the adapter's declared capability.
 * Throws OrderCapabilityError (typed, stable code) on any violation — the
 * caller MUST NOT proceed to dispatch. Pure function: no adapter call.
 */
export function assertOrderWithinCapabilities(
  request: Pick<BrokerOrderRequest, 'orderKind' | 'limitPrice' | 'stopPrice'>,
  declaration: OrderCapabilityDeclaration,
): void {
  const kind: NormalizedOrderKind = request.orderKind ?? 'MARKET';

  if (!declaration.supportedOrderKinds.includes(kind)) {
    throw new OrderCapabilityError(
      'ORDER_KIND_NOT_SUPPORTED',
      declaration.brokerId,
      `order kind ${kind} is not supported (supported: ${declaration.supportedOrderKinds.join(', ')})`,
    );
  }

  const requirement = declaration.requirements[kind];
  if (requirement?.limitPriceRequired && !isPositiveDecimalString(request.limitPrice)) {
    throw new OrderCapabilityError(
      'LIMIT_PRICE_REQUIRED',
      declaration.brokerId,
      `order kind ${kind} requires a positive limitPrice`,
    );
  }
  if (requirement?.stopPriceRequired && !isPositiveDecimalString(request.stopPrice)) {
    throw new OrderCapabilityError(
      'STOP_PRICE_REQUIRED',
      declaration.brokerId,
      `order kind ${kind} requires a positive stopPrice`,
    );
  }
}
