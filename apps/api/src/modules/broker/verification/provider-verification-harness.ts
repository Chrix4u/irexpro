/**
 * Provider verification harness — credential-gated, repeatable provider
 * verification (Sprint 56 / Task 47-C5; re-integrated onto new main as
 * Task 48-D).
 *
 * WHAT THIS IS:
 * A plain (NON-Nest) verification engine, usable both from the application
 * (BrokerDemoValidationService — the evidence-based write path for
 * BrokerConnection.demoValidated) and from jest specs (the operator-run
 * credential-gated harnesses in this directory). It drives a REAL
 * IBrokerAdapter through the Sprint 56 verification checklist:
 *
 *   connect → account info → market data → positions snapshot →
 *   small market order → position verification → SL/TP modification (where
 *   supported) → partial close → full close → closed-trade history →
 *   pending limit order (far from market) → pending modification →
 *   cancellation → open-order listing (cancelled order gone) → margin info →
 *   reconciliation (positions + working orders consistent) → reconnect →
 *   provider error path (typed error on a deliberately invalid instrument).
 *
 * NEW-MAIN ADAPTATION (Task 48-D — superseded surfaces removed):
 * - NO capability-guard: the old `adapter.capabilities` /
 *   ProviderCapability model is superseded by the server-authoritative
 *   broker catalog. Step applicability is now discovered at RUNTIME:
 *   typed BrokerAdapterError rejections that mean "this provider surface
 *   does not exist" (INVALID_ORDER_TYPE / INVALID_REQUEST /
 *   POSITION_NOT_FOUND on a just-verified working order) SKIP the step with
 *   the honest reason; every other outcome FAILS.
 * - `cancelOrder` is intentionally OFF the IBrokerAdapter interface —
 *   adapters that support working-order cancellation expose it as a
 *   concrete-class method, discovered here via structural narrowing
 *   (`hasCancelOrder(adapter)`).
 * - `listOrders()` / `getOrderById()` are REQUIRED interface members
 *   (BrokerOrderState reconciliation surface) — the order-history step
 *   exercises them directly.
 * - `orderKind`/`timeInForce` string unions replace the old BrokerOrderType
 *   enum on BrokerOrderRequest.
 *
 * INVARIANTS (non-negotiable):
 * - DEMO ONLY: the harness never operates in LIVE mode. `mode` is typed and
 *   runtime-guarded to 'DEMO'. The small market order it places is therefore
 *   a DEMO/practice order only.
 * - SANITIZED EVIDENCE: the returned evidence object contains ONLY non-secret
 *   references — timestamps, step statuses, provider order/position ids,
 *   instrument symbols, decimal-string sanity results. Credentials NEVER
 *   appear: every free-text detail passes through redactString() (the shared
 *   credential-shaped-fragment redactor from redact-sensitive.util) and the
 *   evidence shape has no credential-shaped fields.
 * - DECIMAL-STRING DISCIPLINE: every monetary field the providers return is
 *   asserted to be a decimal STRING — a step FAILS when a money field is a
 *   JavaScript number (the float-money contract violation).
 * - FAIL-CLOSED PER STEP: each step records PASS/FAIL/SKIPPED. A step whose
 *   prerequisite did not pass is SKIPPED (never silently attempted); a
 *   provider surface the adapter does not support makes its step SKIPPED with
 *   the honest reason. overall === 'PASS' requires ZERO failures and at least
 *   one executed PASS.
 *
 * PRODUCTION-LIVE VERIFICATION RULE (the ONLY legitimate path to VERIFIED):
 *   productionLiveVerification.status === VERIFIED on a broker catalog entry
 *   may ONLY be flipped by an authorized operator running these harnesses
 *   against real provider credentials, then recording the sanitized evidence
 *   (evidenceRef + verifiedAt) in the broker catalog and
 *   docs/brokers/provider-matrix.md. TESTS NEVER FLIP IT — the paper harness
 *   spec that runs in CI proves the harness itself works; it is NOT
 *   provider verification evidence.
 */
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
  BrokerPosition,
  BrokerMode,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
} from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import { redactString } from '../../../common/utils/redact-sensitive.util';
import { PaperBrokerAdapter } from '../adapters/paper-broker.adapter';
import { OandaAdapter } from '../adapters/oanda/oanda.adapter';

// ─── Evidence types (sanitized — safe to log, audit, and console.log) ─────────

export type VerificationStepStatus = 'PASS' | 'FAIL' | 'SKIPPED';
export type VerificationOverallStatus = 'PASS' | 'FAIL';

/** One checklist step's sanitized result. providerOrderId is non-secret. */
export interface ProviderVerificationStep {
  name: string;
  status: VerificationStepStatus;
  /** Sanitized human-readable evidence — never credentials (redaction applied). */
  detail?: string;
  /** Provider order/position identifier (non-secret by entity design). */
  providerOrderId?: string;
}

export interface ProviderVerificationSummary {
  passed: number;
  failed: number;
  skipped: number;
}

export interface ProviderVerificationEvidence {
  brokerId: string;
  mode: 'DEMO';
  /** BrokerConnection id when the run was bound to a persisted connection. */
  connectionId?: string;
  startedAt: string;
  finishedAt: string;
  steps: ProviderVerificationStep[];
  summary: ProviderVerificationSummary;
  overall: VerificationOverallStatus;
}

// ─── Canonical step sequence ──────────────────────────────────────────────────

/**
 * Full operator-harness checklist (the Sprint 56 directive list). The
 * runtime-capability-aware engine SKIPS steps whose surface the adapter does
 * not expose — a SKIPPED step never counts against overall.
 */
export const PROVIDER_VERIFICATION_STEPS: readonly string[] = [
  'connect',
  'account-info',
  'market-data',
  'positions-snapshot',
  'market-order',
  'position-verify',
  'modify-sl-tp',
  'partial-close',
  'full-close',
  'trade-history',
  'pending-limit-order',
  'pending-modify',
  'pending-cancel',
  'order-history',
  'margin-info',
  'reconciliation',
  'reconnect',
  'provider-error-path',
];

/**
 * DEMO-connection validation checklist (BrokerDemoValidationService): the
 * user-facing trading-surface checklist. Deliberately EXCLUDES the
 * operator-only steps — modify-sl-tp (the directive's SL/TP exercise),
 * reconciliation, reconnect (drops the session mid-validation) and
 * provider-error-path (deliberately trips provider errors).
 */
export const DEMO_VALIDATION_STEPS: readonly string[] = [
  'connect',
  'account-info',
  'market-data',
  'positions-snapshot',
  'market-order',
  'position-verify',
  'partial-close',
  'full-close',
  'trade-history',
  'pending-limit-order',
  'pending-modify',
  'pending-cancel',
  'order-history',
  'margin-info',
];

// ─── Sanitization ──────────────────────────────────────────────────────────────

/** Sanitizes any error text into a one-line redacted detail (never raw provider text). */
export function sanitizeVerificationDetail(message: string): string {
  return redactString(message).slice(0, 300);
}

// ─── Exact decimal-string helpers (BigInt only — never floats) ────────────────

/**
 * The repo-wide decimal-string contract (mirrors the OANDA types): SIGNED
 * decimal strings — P&L/financing legitimately go negative; what the harness
 * forbids is float money (JavaScript numbers).
 */
const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

/** Unsigned form — used when COMPUTING trigger prices from provider quotes. */
const UNSIGNED_DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;

interface ParsedDecimal {
  digits: bigint;
  scale: number;
}

function parseDecimalString(value: string): ParsedDecimal | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!UNSIGNED_DECIMAL_STRING_PATTERN.test(trimmed)) return null;
  const [intPart, fracPart = ''] = trimmed.split('.');
  return { digits: BigInt(`${intPart}${fracPart}`), scale: fracPart.length };
}

function formatScaledDecimal(digits: bigint, scale: number): string {
  const sign = digits < 0n ? '-' : '';
  const absolute = digits < 0n ? -digits : digits;
  const text = absolute.toString().padStart(scale + 1, '0');
  if (scale === 0) return `${sign}${text}`;
  return `${sign}${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
}

/**
 * Rescales a parsed decimal to `targetScale` (only ever needed upward here —
 * harness prices are provider-rendered at their own instrument digits).
 */
function rescale(parsed: ParsedDecimal, targetScale: number): ParsedDecimal {
  if (parsed.scale === targetScale) return parsed;
  if (parsed.scale < targetScale) {
    return {
      digits: parsed.digits * 10n ** BigInt(targetScale - parsed.scale),
      scale: targetScale,
    };
  }
  return {
    digits: parsed.digits / 10n ** BigInt(parsed.scale - targetScale),
    scale: targetScale,
  };
}

/**
 * Exact `value × numerator / denominator` rendered at `targetScale` digits
 * (truncating BigInt division — trigger prices, not accounting values).
 * Returns null when value is not a non-negative decimal string.
 */
export function scaledFractionOfDecimalString(
  value: string,
  numerator: bigint,
  denominator: bigint,
  targetScale: number,
): string | null {
  const parsed = parseDecimalString(value);
  if (!parsed) return null;
  const rescaled = rescale(parsed, targetScale);
  return formatScaledDecimal((rescaled.digits * numerator) / denominator, targetScale);
}

/** Exact `value × 2` (used to size the market order at 2 × the partial-close lot). */
export function doubleDecimalString(value: string): string | null {
  const parsed = parseDecimalString(value);
  if (!parsed) return null;
  return formatScaledDecimal(parsed.digits * 2n, parsed.scale);
}

/** Decimal-string max (null when either input is not a decimal string). */
export function maxDecimalString(a: string, b: string): string | null {
  const pa = parseDecimalString(a);
  const pb = parseDecimalString(b);
  if (!pa || !pb) return null;
  const scale = Math.max(pa.scale, pb.scale);
  const da = rescale(pa, scale).digits;
  const db = rescale(pb, scale).digits;
  return da >= db ? a : b;
}

/**
 * A pending BUY LIMIT price ~10% below the prevailing ask — far enough from
 * the market to stay WORKING through the harness run (the honest way to
 * exercise place → modify → cancel without a fill).
 */
export function farBelowMarketPrice(price: string, digits: number): string | null {
  return scaledFractionOfDecimalString(price, 9n, 10n, digits);
}

/** A BUY TP ~10% above the market — inert protection level (never triggered). */
export function farAboveMarketPrice(price: string, digits: number): string | null {
  return scaledFractionOfDecimalString(price, 11n, 10n, digits);
}

/**
 * Decimal-string sanity assertion for provider payloads. Returns the list of
 * violations (empty when clean) — the harness FAILS the step when a money
 * field is a number or not a decimal string.
 */
export function decimalStringViolations(
  source: string,
  record: Record<string, unknown>,
  fields: string[],
): string[] {
  const violations: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'number') {
      violations.push(`${source}.${field} must be a decimal string — received number ${value}`);
      continue;
    }
    if (typeof value !== 'string' || !DECIMAL_STRING_PATTERN.test(value.trim())) {
      violations.push(
        `${source}.${field} must be a decimal string — received ${describeValue(value)}`,
      );
    }
  }
  return violations;
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return `${value}`;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.slice(0, 80)}"`;
}

// ─── Optional-surface narrowing (cancelOrder is off the interface) ───────────

/**
 * Structural narrowing for the working-order cancellation surface.
 * `cancelOrder` is intentionally NOT part of IBrokerAdapter (Task 48-A
 * supersession map) — adapters that support it expose a concrete method,
 * discovered here at runtime.
 */
interface AdapterWithCancelOrder {
  cancelOrder(externalOrderId: string): Promise<BrokerOrderResult>;
}

export function hasCancelOrder(
  adapter: IBrokerAdapter,
): adapter is IBrokerAdapter & AdapterWithCancelOrder {
  return (
    'cancelOrder' in adapter &&
    typeof (adapter as { cancelOrder?: unknown }).cancelOrder === 'function'
  );
}

// ─── Checklist engine ─────────────────────────────────────────────────────────

export interface ProviderVerificationChecklistOptions {
  brokerId: string;
  /** Logical mode — always DEMO (runtime-guarded). */
  mode: 'DEMO';
  /**
   * Allow-list of step names (must be a subset of PROVIDER_VERIFICATION_STEPS).
   * Defaults to the full canonical list.
   */
  steps?: readonly string[];
  /**
   * Pre-computed connect step result. When provided the engine does NOT call
   * adapter.connect() itself — BrokerDemoValidationService injects the result
   * of BrokerService.connectBroker (the canonical CONNECTING→CONNECTED state
   * machine with BrokerAccount upsert + BROKER_CONNECTED audit). A FAILed
   * injected connect skips every subsequent step (fail-closed cascade).
   */
  connectStep?: ProviderVerificationStep;
  /**
   * Credentials for the harness's own connect/reconnect calls and
   * connectionReference routing (memory-only — NEVER recorded in evidence).
   * Optional when connectStep is provided (the adapter is already connected).
   */
  credentials?: DecryptedBrokerCredentials;
  /** BrokerConnection id recorded in the evidence (non-secret). */
  connectionId?: string;
}

interface ChecklistContext {
  adapter: IBrokerAdapter;
  credentials?: DecryptedBrokerCredentials;
  connectionReference?: string;
  instrumentSymbol?: string;
  askPrice?: string;
  digits: number;
  partialLot: string;
  marketLot: string;
  marketOrderId?: string;
  pendingOrderId?: string;
}

interface StepOutcome {
  status: VerificationStepStatus;
  detail?: string;
  providerOrderId?: string;
}

const POSITION_DECIMAL_FIELDS = [
  'lotSize',
  'openPrice',
  'currentPrice',
  'stopLoss',
  'takeProfit',
  'unrealisedPnl',
  'commission',
  'swap',
];
const CLOSED_TRADE_DECIMAL_FIELDS = [
  'lotSize',
  'openPrice',
  'closePrice',
  'stopLoss',
  'takeProfit',
  'realisedPnl',
  'commission',
  'swap',
];
const INSTRUMENT_DECIMAL_FIELDS = ['minLot', 'maxLot', 'lotStep', 'contractSize'];
/** BrokerOrderState required-quantity fields (always decimal strings). */
const ORDER_STATE_REQUIRED_DECIMAL_FIELDS = ['requestedQuantity', 'filledQuantity'];
/** BrokerOrderState optional price fields (decimal strings whenever present). */
const ORDER_STATE_OPTIONAL_DECIMAL_FIELDS = ['avgFillPrice', 'limitPrice', 'stopPrice'];

/** BrokerOrderState decimal sanity — required fields always, optional when set. */
function orderStateViolations(source: string, state: BrokerOrderState): string[] {
  const record = state as unknown as Record<string, unknown>;
  const violations = decimalStringViolations(source, record, ORDER_STATE_REQUIRED_DECIMAL_FIELDS);
  const optionalPresent = ORDER_STATE_OPTIONAL_DECIMAL_FIELDS.filter(
    (field) => record[field] !== null && record[field] !== undefined,
  );
  if (optionalPresent.length > 0) {
    violations.push(...decimalStringViolations(source, record, optionalPresent));
  }
  return violations;
}

/**
 * Typed-error codes that mean "this provider surface does not exist" for the
 * step being attempted — the runtime replacement for the superseded
 * capability-guard SKIP. Anything else (outage, auth, rate limit, market
 * state, validation of the payload itself) FAILS honestly.
 */
const NOT_APPLICABLE_ERROR_CODES: readonly BrokerErrorCode[] = [
  // The adapter refuses the order kind outright (fail-closed dispatch on
  // providers that do not offer pending orders).
  BrokerErrorCode.INVALID_ORDER_TYPE,
];

/**
 * Runs the runtime-capability-aware checklist against a CONNECTED (or
 * connectable) adapter and returns sanitized evidence. Pure engine — no
 * Nest, no I/O of its own: every provider interaction goes through the
 * adapter.
 */
export async function runVerificationChecklist(
  adapter: IBrokerAdapter,
  options: ProviderVerificationChecklistOptions,
): Promise<ProviderVerificationEvidence> {
  if (options.mode !== 'DEMO') {
    throw new Error('The verification checklist only runs in DEMO mode.');
  }
  const selected = normalizeStepSelection(options.steps);
  const startedAt = new Date();

  const steps: ProviderVerificationStep[] = [];
  const statuses = new Map<string, VerificationStepStatus>();

  const ctx: ChecklistContext = {
    adapter,
    credentials: options.credentials,
    connectionReference: options.credentials?.accountId,
    digits: 5,
    // Mission-documented lot sizing: the partial close uses the instrument's
    // minLot (0.01 fallback); the market order uses exactly 2× that so the
    // partial close is genuinely partial and a remainder stays for the full
    // close. Exact decimal math — never floats.
    partialLot: '0.01',
    marketLot: '0.02',
  };

  const pushStep = (name: string, status: VerificationStepStatus, outcome?: StepOutcome): void => {
    const step: ProviderVerificationStep = { name, status };
    if (outcome?.detail) step.detail = sanitizeVerificationDetail(outcome.detail);
    if (outcome?.providerOrderId) step.providerOrderId = outcome.providerOrderId;
    steps.push(step);
    statuses.set(name, status);
  };

  const skipped = (detail: string): StepOutcome => ({ status: 'SKIPPED', detail });

  const passed = (name: string): boolean => statuses.get(name) === 'PASS';

  const runStep = async (name: string, run: () => Promise<StepOutcome>): Promise<void> => {
    let outcome: StepOutcome;
    try {
      outcome = await run();
    } catch (err) {
      outcome = { status: 'FAIL', detail: describeError(err) };
    }
    pushStep(name, outcome.status, outcome);
  };

  /**
   * Converts a typed "surface not supported" rejection into an honest
   * SKIPPED outcome. Returns null when the error must FAIL the step.
   */
  const notApplicable = (err: unknown, extraCodes: BrokerErrorCode[] = []): StepOutcome | null => {
    if (
      err instanceof BrokerAdapterError &&
      [...NOT_APPLICABLE_ERROR_CODES, ...extraCodes].includes(err.code)
    ) {
      return skipped(`adapter reported ${err.code} — step not applicable on this provider surface`);
    }
    return null;
  };

  const assertOrderResult = (
    source: string,
    result: BrokerOrderResult,
    expectedStatus: BrokerOrderResult['status'],
    expectedId: boolean,
  ): string[] => {
    const violations: string[] = [];
    if (!result.success) violations.push(`${source}.success === false`);
    if (result.status !== expectedStatus) {
      violations.push(`${source}.status "${result.status}" !== "${expectedStatus}"`);
    }
    if (expectedId && !result.externalOrderId) {
      violations.push(`${source}.externalOrderId missing`);
    }
    if (result.filledPrice !== undefined) {
      violations.push(
        ...decimalStringViolations(source, result as unknown as Record<string, unknown>, [
          'filledPrice',
        ]),
      );
    }
    if (result.filledQuantity !== undefined) {
      violations.push(
        ...decimalStringViolations(source, result as unknown as Record<string, unknown>, [
          'filledQuantity',
        ]),
      );
    }
    return violations;
  };

  // ── Step: connect ─────────────────────────────────────────────────────────
  if (selected.has('connect')) {
    if (options.connectStep) {
      // Injected (BrokerDemoValidationService): BrokerService.connectBroker
      // owns the connection state machine; only its outcome is recorded here.
      pushStep('connect', options.connectStep.status, options.connectStep);
    } else {
      await runStep('connect', async () => {
        if (!options.credentials) {
          return skipped('no credentials supplied — cannot connect');
        }
        adapter.setMode(BrokerMode.DEMO);
        const result = await adapter.connect(options.credentials);
        if (!result.success) {
          return {
            status: 'FAIL',
            detail: `connect() reported failure${result.error ? `: ${result.error}` : ''}`,
          };
        }
        if (result.accountType !== BrokerMode.DEMO) {
          return {
            status: 'FAIL',
            detail: `connection accountType "${result.accountType}" is not DEMO — refusing to validate`,
          };
        }
        return {
          status: 'PASS',
          detail: `connected to account ${result.accountId} (${result.currency})`,
        };
      });
    }
  }

  const connectFailed = statuses.get('connect') === 'FAIL';

  // Fail-closed cascade: without a connection nothing else can be verified.
  for (const name of PROVIDER_VERIFICATION_STEPS) {
    if (!selected.has(name) || name === 'connect') continue;
    if (connectFailed && statuses.get(name) === undefined) {
      pushStep(name, 'SKIPPED', {
        status: 'SKIPPED',
        detail: 'connect failed — step not attempted',
      });
    }
  }

  // ── Step: account-info ────────────────────────────────────────────────────
  if (selected.has('account-info') && !connectFailed) {
    await runStep('account-info', async () => {
      const info = await adapter.getAccountInfo();
      const violations = decimalStringViolations(
        'accountInfo',
        info as unknown as Record<string, unknown>,
        ['balance', 'equity', 'margin', 'freeMargin', 'marginLevel'],
      );
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      return {
        status: 'PASS',
        detail: `account ${info.accountId} currency=${info.currency} leverage=${info.leverage}`,
      };
    });
  }

  // ── Step: market-data (instrument catalog + current price) ─────────────────
  if (selected.has('market-data') && !connectFailed) {
    await runStep('market-data', async () => {
      const instruments = await adapter.getInstrumentList();
      if (!Array.isArray(instruments) || instruments.length === 0) {
        return { status: 'FAIL', detail: 'getInstrumentList() returned no instruments' };
      }
      const instrument = instruments[0]!;
      const instrumentViolations = decimalStringViolations(
        `instrument[${instrument.symbol}]`,
        instrument as unknown as Record<string, unknown>,
        INSTRUMENT_DECIMAL_FIELDS,
      );
      if (instrumentViolations.length > 0) {
        return { status: 'FAIL', detail: instrumentViolations.join('; ') };
      }
      const price = await adapter.getCurrentPrice(instrument.symbol);
      const priceViolations = decimalStringViolations(
        'price',
        price as unknown as Record<string, unknown>,
        ['bid', 'ask', 'spread'],
      );
      if (priceViolations.length > 0) {
        return { status: 'FAIL', detail: priceViolations.join('; ') };
      }
      ctx.instrumentSymbol = instrument.symbol;
      ctx.askPrice = price.ask;
      ctx.digits = instrument.digits > 0 ? instrument.digits : 5;
      const minLot = maxDecimalString(instrument.minLot, '0.01') ?? '0.01';
      const doubled = doubleDecimalString(minLot) ?? '0.02';
      ctx.partialLot = minLot;
      ctx.marketLot = doubled;
      return {
        status: 'PASS',
        detail: `instrument ${instrument.symbol} (digits ${ctx.digits}, minLot ${instrument.minLot}) bid=${price.bid} ask=${price.ask}`,
      };
    });
  }

  // ── Step: positions-snapshot ──────────────────────────────────────────────
  if (selected.has('positions-snapshot') && !connectFailed) {
    await runStep('positions-snapshot', async () => {
      const positions = await adapter.getOpenPositions();
      for (const [index, position] of positions.entries()) {
        const violations = decimalStringViolations(
          `position[${position.externalOrderId ?? index}]`,
          position as unknown as Record<string, unknown>,
          POSITION_DECIMAL_FIELDS,
        );
        if (violations.length > 0) {
          return { status: 'FAIL', detail: violations.join('; ') };
        }
      }
      return { status: 'PASS', detail: `snapshot resolved (${positions.length} open position(s))` };
    });
  }

  // ── Step: market-order (small DEMO market order) ──────────────────────────
  if (selected.has('market-order') && !connectFailed) {
    await runStep('market-order', async () => {
      if (!passed('market-data')) {
        return skipped('market-data did not pass — no instrument/lot context');
      }
      const request: BrokerOrderRequest = {
        idempotencyKey: `harness-${randomUUID()}`,
        instrument: ctx.instrumentSymbol!,
        direction: 'BUY',
        lotSize: ctx.marketLot,
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'MARKET',
        timeInForce: 'GTC',
        comment: 'demo-validation-harness',
        connectionReference: ctx.connectionReference,
      };
      let result: BrokerOrderResult;
      try {
        result = await adapter.placeOrder(request);
      } catch (err) {
        const na = notApplicable(err);
        if (na) return na;
        throw err;
      }
      const violations = assertOrderResult('marketOrder', result, 'FILLED', true);
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      ctx.marketOrderId = result.externalOrderId;
      return {
        status: 'PASS',
        detail: `MARKET BUY ${ctx.marketLot} lots filled at ${result.filledPrice}`,
        providerOrderId: result.externalOrderId,
      };
    });
  }

  // ── Step: position-verify (the order reached the open positions) ───────────
  if (selected.has('position-verify') && !connectFailed) {
    await runStep('position-verify', async () => {
      if (!passed('market-order')) {
        return skipped('market-order did not pass — no position to verify');
      }
      const positions = await adapter.getOpenPositions();
      const position = positions.find((p) => p.externalOrderId === ctx.marketOrderId);
      if (!position) {
        return {
          status: 'FAIL',
          detail: `order ${ctx.marketOrderId} not found among ${positions.length} open position(s)`,
        };
      }
      const violations = decimalStringViolations(
        `position[${position.externalOrderId}]`,
        position as unknown as Record<string, unknown>,
        POSITION_DECIMAL_FIELDS,
      );
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      return {
        status: 'PASS',
        detail: `position ${position.externalOrderId} open at ${position.openPrice} (lot ${position.lotSize})`,
        providerOrderId: position.externalOrderId,
      };
    });
  }

  // ── Step: modify-sl-tp (SL/TP modification where supported) ────────────────
  if (selected.has('modify-sl-tp') && !connectFailed) {
    await runStep('modify-sl-tp', async () => {
      if (!passed('position-verify')) {
        return skipped('position-verify did not pass — no position to modify');
      }
      const newStopLoss = farBelowMarketPrice(ctx.askPrice!, ctx.digits);
      const newTakeProfit = farAboveMarketPrice(ctx.askPrice!, ctx.digits);
      if (!newStopLoss || !newTakeProfit) {
        return { status: 'FAIL', detail: 'could not compute inert SL/TP levels (bad price shape)' };
      }
      let result: BrokerOrderResult;
      try {
        result = await adapter.modifyOrder(ctx.marketOrderId!, {
          newStopLoss,
          newTakeProfit,
        });
      } catch (err) {
        // Adapters whose modifyOrder surface covers ONLY pending orders (no
        // open-position SL/TP) skip honestly; everything else fails.
        const na = notApplicable(err, [
          BrokerErrorCode.INVALID_REQUEST,
          BrokerErrorCode.POSITION_NOT_FOUND,
        ]);
        if (na) return na;
        throw err;
      }
      const violations = assertOrderResult('modifyOrder', result, 'FILLED', false);
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      return {
        status: 'PASS',
        detail: `SL/TP modified to inert levels (SL ${newStopLoss} / TP ${newTakeProfit})`,
      };
    });
  }

  // ── Step: partial-close ───────────────────────────────────────────────────
  if (selected.has('partial-close') && !connectFailed) {
    await runStep('partial-close', async () => {
      if (!passed('market-order')) {
        return skipped('market-order did not pass — no position to partially close');
      }
      const result = await adapter.closeOrder(ctx.marketOrderId!, ctx.partialLot);
      const violations = assertOrderResult('partialClose', result, 'FILLED', false);
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      return {
        status: 'PASS',
        detail: `partial close of ${ctx.partialLot} lots succeeded`,
        providerOrderId: ctx.marketOrderId,
      };
    });
  }

  // ── Step: full-close ──────────────────────────────────────────────────────
  if (selected.has('full-close') && !connectFailed) {
    await runStep('full-close', async () => {
      if (!passed('market-order')) {
        return skipped('market-order did not pass — no position to close');
      }
      const result = await adapter.closeOrder(ctx.marketOrderId!);
      const violations = assertOrderResult('fullClose', result, 'FILLED', false);
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      return {
        status: 'PASS',
        detail: 'full close succeeded — validation position closed',
        providerOrderId: ctx.marketOrderId,
      };
    });
  }

  // ── Step: trade-history (closed-trade history contains the trade) ──────────
  if (selected.has('trade-history') && !connectFailed) {
    await runStep('trade-history', async () => {
      if (!passed('full-close')) {
        return skipped('full-close did not pass — trade not closed');
      }
      // Deliberately wide window: from the Unix epoch to a day past now so
      // providers' own clock conventions can never hide the trade.
      const from = new Date(0);
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const trades = await adapter.getClosedTrades(from, to);
      const match = trades.find((t) => t.externalOrderId === ctx.marketOrderId);
      if (!match) {
        return {
          status: 'FAIL',
          detail: `closed trade ${ctx.marketOrderId} not found in history (${trades.length} record(s) returned)`,
        };
      }
      const violations = decimalStringViolations(
        `closedTrade[${match.externalOrderId}]`,
        match as unknown as Record<string, unknown>,
        CLOSED_TRADE_DECIMAL_FIELDS,
      );
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      return {
        status: 'PASS',
        detail: `closed trade ${match.externalOrderId} present (closeReason ${match.closeReason})`,
        providerOrderId: match.externalOrderId,
      };
    });
  }

  // ── Step: pending-limit-order (far-from-market, stays WORKING) ─────────────
  if (selected.has('pending-limit-order') && !connectFailed) {
    await runStep('pending-limit-order', async () => {
      if (!passed('market-data')) {
        return skipped('market-data did not pass — no instrument/price context');
      }
      const limitPrice = farBelowMarketPrice(ctx.askPrice!, ctx.digits);
      if (!limitPrice) {
        return { status: 'FAIL', detail: 'could not compute a far-from-market limit price' };
      }
      const request: BrokerOrderRequest = {
        idempotencyKey: `harness-${randomUUID()}`,
        instrument: ctx.instrumentSymbol!,
        direction: 'BUY',
        lotSize: ctx.partialLot,
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'LIMIT',
        timeInForce: 'GTC',
        limitPrice,
        comment: 'demo-validation-harness',
        connectionReference: ctx.connectionReference,
      };
      let result: BrokerOrderResult;
      try {
        result = await adapter.placeOrder(request);
      } catch (err) {
        const na = notApplicable(err);
        if (na) return na;
        throw err;
      }
      const violations = assertOrderResult('pendingLimitOrder', result, 'PENDING', true);
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      ctx.pendingOrderId = result.externalOrderId;
      return {
        status: 'PASS',
        detail: `pending BUY LIMIT ${ctx.partialLot} lots at ${limitPrice} (working)`,
        providerOrderId: result.externalOrderId,
      };
    });
  }

  // ── Step: pending-modify (modify SL/TP of the working order) ───────────────
  if (selected.has('pending-modify') && !connectFailed) {
    await runStep('pending-modify', async () => {
      if (!passed('pending-limit-order')) {
        return skipped('pending-limit-order did not pass — no working order to modify');
      }
      const newTakeProfit = farAboveMarketPrice(ctx.askPrice!, ctx.digits);
      if (!newTakeProfit) {
        return { status: 'FAIL', detail: 'could not compute an inert take-profit level' };
      }
      let result: BrokerOrderResult;
      try {
        result = await adapter.modifyOrder(ctx.pendingOrderId!, { newTakeProfit });
      } catch (err) {
        // Adapters whose modifyOrder surface covers ONLY open trades (no
        // working-order modification — e.g. the OANDA v20 dependent-order
        // endpoint) skip honestly; the just-placed working order is known to
        // exist, so POSITION_NOT_FOUND means "not a trade", not "vanished".
        const na = notApplicable(err, [
          BrokerErrorCode.INVALID_REQUEST,
          BrokerErrorCode.POSITION_NOT_FOUND,
        ]);
        if (na) return na;
        throw err;
      }
      const violations = assertOrderResult('pendingModify', result, 'FILLED', false);
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      // Providers with atomic-REPLACE pending modification (e.g. OANDA v20
      // PUT /orders/{id}) return the REPLACEMENT order id — the following
      // steps must target it. Adapters without replacement keep the id.
      if (result.externalOrderId) {
        ctx.pendingOrderId = result.externalOrderId;
      }
      return {
        status: 'PASS',
        detail: `pending order modified (inert TP ${newTakeProfit}; current id ${ctx.pendingOrderId})`,
        providerOrderId: ctx.pendingOrderId,
      };
    });
  }

  // ── Step: pending-cancel ──────────────────────────────────────────────────
  if (selected.has('pending-cancel') && !connectFailed) {
    await runStep('pending-cancel', async () => {
      if (!passed('pending-limit-order')) {
        return skipped('pending-limit-order did not pass — no working order to cancel');
      }
      // cancelOrder is intentionally OFF the IBrokerAdapter interface —
      // adapters that support working-order cancellation expose it as a
      // concrete method (structural narrowing, supersession map).
      if (!hasCancelOrder(adapter)) {
        return skipped('adapter does not implement cancelOrder() — cancellation not applicable');
      }
      const result = await adapter.cancelOrder(ctx.pendingOrderId!);
      const violations = assertOrderResult('pendingCancel', result, 'FILLED', false);
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      return {
        status: 'PASS',
        detail: `working order ${ctx.pendingOrderId} cancelled`,
        providerOrderId: ctx.pendingOrderId,
      };
    });
  }

  // ── Step: order-history (working-order listing; cancelled order gone) ──────
  if (selected.has('order-history') && !connectFailed) {
    await runStep('order-history', async () => {
      // listOrders() is a REQUIRED interface member (BrokerOrderState
      // reconciliation surface) — no capability gate, it must resolve.
      const orders: BrokerOrderState[] = await adapter.listOrders();
      for (const [index, order] of orders.entries()) {
        const violations = orderStateViolations(
          `orderState[${order.providerOrderId ?? index}]`,
          order,
        );
        if (violations.length > 0) {
          return { status: 'FAIL', detail: violations.join('; ') };
        }
      }
      if (passed('pending-cancel') && ctx.pendingOrderId) {
        const stillListed = orders.some((o) => o.providerOrderId === ctx.pendingOrderId);
        if (stillListed) {
          return {
            status: 'FAIL',
            detail: `cancelled order ${ctx.pendingOrderId} still listed as working`,
          };
        }
        return {
          status: 'PASS',
          detail: `cancelled order ${ctx.pendingOrderId} absent from ${orders.length} working order(s)`,
        };
      }
      return { status: 'PASS', detail: `listing resolved (${orders.length} working order(s))` };
    });
  }

  // ── Step: margin-info (getRequiredMargin sanity; null is acceptable) ───────
  if (selected.has('margin-info') && !connectFailed) {
    await runStep('margin-info', async () => {
      if (!passed('market-data')) {
        return skipped('market-data did not pass — no instrument context');
      }
      const margin = await adapter.getRequiredMargin({
        instrument: ctx.instrumentSymbol!,
        lotSize: ctx.partialLot,
        direction: 'BUY',
        connectionReference: ctx.connectionReference,
      });
      if (margin === null) {
        return {
          status: 'PASS',
          detail: 'getRequiredMargin resolved null (acceptable: provider cannot quote margin)',
        };
      }
      const violations = decimalStringViolations('requiredMargin', { margin }, ['margin']);
      if (violations.length > 0) {
        return { status: 'FAIL', detail: violations.join('; ') };
      }
      return { status: 'PASS', detail: `required margin ${margin} for ${ctx.partialLot} lots` };
    });
  }

  // ── Step: reconciliation (positions + working orders consistent) ───────────
  if (selected.has('reconciliation') && !connectFailed) {
    await runStep('reconciliation', async () => {
      const positions: BrokerPosition[] = await adapter.getOpenPositions();
      const workingOrders: BrokerOrderState[] = await adapter.listOrders();
      // Consistency check: after a successful full close the validation
      // position must be gone from the open-position snapshot.
      if (passed('full-close') && ctx.marketOrderId) {
        const leaked = positions.some((p) => p.externalOrderId === ctx.marketOrderId);
        if (leaked) {
          return {
            status: 'FAIL',
            detail: `closed position ${ctx.marketOrderId} still reported open`,
          };
        }
      }
      return {
        status: 'PASS',
        detail: `reconciled: ${positions.length} open position(s), ${workingOrders.length} working order(s)`,
      };
    });
  }

  // ── Step: reconnect (disconnect → connect → account read) ──────────────────
  if (selected.has('reconnect') && !connectFailed) {
    await runStep('reconnect', async () => {
      if (!options.credentials) {
        return skipped('no credentials supplied — reconnect cannot re-authenticate');
      }
      await adapter.disconnect();
      adapter.setMode(BrokerMode.DEMO);
      const result = await adapter.connect(options.credentials);
      if (!result.success) {
        return { status: 'FAIL', detail: 'reconnect() reported failure' };
      }
      // Prove the session is genuinely usable again after reconnecting.
      await adapter.getAccountInfo();
      return { status: 'PASS', detail: 'disconnect → connect → account-info resolved' };
    });
  }

  // ── Step: provider-error-path (typed error, never a crash) ─────────────────
  if (selected.has('provider-error-path') && !connectFailed) {
    await runStep('provider-error-path', async () => {
      try {
        const price = await adapter.getCurrentPrice(HARNESS_INVALID_INSTRUMENT);
        return {
          status: 'FAIL',
          detail: `provider accepted invalid instrument "${HARNESS_INVALID_INSTRUMENT}" (bid ${price.bid}) — error path must fail typed`,
        };
      } catch (err) {
        if (err instanceof BrokerAdapterError) {
          return {
            status: 'PASS',
            detail: `invalid instrument rejected with typed ${err.code}`,
          };
        }
        return {
          status: 'FAIL',
          detail: `invalid instrument rejected with an UNTYPED error (${describeError(err)})`,
        };
      }
    });
  }

  const finishedAt = new Date();
  const summary: ProviderVerificationSummary = {
    passed: steps.filter((s) => s.status === 'PASS').length,
    failed: steps.filter((s) => s.status === 'FAIL').length,
    skipped: steps.filter((s) => s.status === 'SKIPPED').length,
  };
  const overall: VerificationOverallStatus =
    summary.failed === 0 && summary.passed > 0 ? 'PASS' : 'FAIL';

  return {
    brokerId: options.brokerId,
    mode: 'DEMO',
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    steps,
    summary,
    overall,
  };
}

function describeError(err: unknown): string {
  if (err instanceof BrokerAdapterError) {
    // Typed provider failures keep their code in the evidence detail.
    return `${err.code}: ${err.message.slice(0, 120)}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 120)}`;
  return String(err).slice(0, 120);
}

function normalizeStepSelection(steps?: readonly string[]): Set<string> {
  if (!steps) return new Set(PROVIDER_VERIFICATION_STEPS);
  const known = new Set(PROVIDER_VERIFICATION_STEPS);
  for (const name of steps) {
    if (!known.has(name)) {
      throw new Error(`Unknown verification step "${name}" (see PROVIDER_VERIFICATION_STEPS).`);
    }
  }
  return new Set(steps);
}

/** An instrument no real provider can resolve — the error-path probe. */
const HARNESS_INVALID_INSTRUMENT = 'ZZZDEMOHARNESSINVALIDPAIR';

// ─── Operator harness entry point ────────────────────────────────────────────

export interface ProviderVerificationHarnessOptions {
  brokerId: string;
  /** DEMO ONLY — the harness never operates against a LIVE account. */
  mode: 'DEMO';
  /** Supplied by the authorized operator at runtime — NEVER committed. */
  credentials: DecryptedBrokerCredentials;
  /** Optional step allow-list (defaults to the full canonical checklist). */
  steps?: readonly string[];
  /**
   * Adapter override for tests/stubs. When omitted the harness constructs the
   * REAL provider adapter for the brokerId (paper / oanda / ctrader family).
   */
  adapter?: IBrokerAdapter;
}

/**
 * Credential-gated provider verification harness (operator-run, NEVER in CI).
 *
 * Builds (or takes) a REAL adapter, connects in DEMO mode, drives the full
 * Sprint 56 checklist, disconnects in `finally`, and returns SANITIZED
 * evidence (safe to console.log / persist — it contains no credentials by
 * construction: timestamps, step statuses, provider order ids, sanitized
 * details only).
 *
 * The ONLY legitimate use of a PASSING evidence object is an authorized
 * operator recording it (evidenceRef + verifiedAt) against the broker
 * catalog entry + docs/brokers/provider-matrix.md to flip
 * productionLiveVerification to VERIFIED. Tests must NEVER do that.
 */
export async function runProviderVerificationHarness(
  options: ProviderVerificationHarnessOptions,
): Promise<ProviderVerificationEvidence> {
  if (options.mode !== 'DEMO') {
    throw new Error('The provider verification harness only runs in DEMO mode.');
  }
  const built = options.adapter ? null : await buildHarnessAdapter(options.brokerId);
  const adapter = options.adapter ?? built!.adapter;
  try {
    return await runVerificationChecklist(adapter, {
      brokerId: options.brokerId,
      mode: 'DEMO',
      steps: options.steps,
      credentials: options.credentials,
    });
  } finally {
    // Jest/CI hygiene: never leave a provider session open behind the harness.
    try {
      await adapter.disconnect();
    } catch {
      // disconnect best-effort — the evidence already records the run outcome.
    }
    if (built?.dispose) {
      try {
        await built.dispose();
      } catch {
        // best-effort cleanup (transport teardown)
      }
    }
  }
}

// ─── Adapter factory (real adapters, harness-owned lifecycles) ────────────────

interface BuiltHarnessAdapter {
  adapter: IBrokerAdapter;
  /** Optional teardown for harness-owned platform clients (cTrader WS). */
  dispose?: () => Promise<void>;
}

/**
 * Constructs the REAL adapter for a harness-supported broker family:
 * - 'paper-broker' — deterministic simulation (no secrets, CI-safe);
 * - 'oanda' — OANDA v20 REST (per-user practice token, no platform config);
 * - 'ctrader' family — cTrader Open API (needs CTRADER_CLIENT_ID/SECRET env
 *   for the platform app; the operator's access token arrives per run).
 *
 * The cTrader suite is loaded via DYNAMIC import: it is owned by the
 * parallel-port stream and must not be on this module's static dependency
 * path — the paper/oanda harness runs never load it.
 *
 * MetaTrader/MetaAPI is intentionally NOT harness-buildable: its cloud SDK
 * lifecycle is owned by the Nest module graph; run its verification through
 * the application (BrokerDemoValidationService) instead.
 */
export async function buildHarnessAdapter(brokerId: string): Promise<BuiltHarnessAdapter> {
  switch (brokerId) {
    case 'paper-broker':
      return { adapter: new PaperBrokerAdapter() };
    case 'oanda':
      return { adapter: new OandaAdapter() };
    case 'ctrader':
    case 'pepperstone-ctrader':
    case 'icmarkets-ctrader': {
      // CTraderClientService reads its platform app credentials through Nest's
      // ConfigService; outside the module graph the harness supplies a minimal
      // read-only view of the same env vars (never logged, never persisted).
      const [{ CTraderAdapter }, { CTraderClientService }] = await Promise.all([
        import('../adapters/ctrader/ctrader.adapter'),
        import('../adapters/ctrader/ctrader-client.service'),
      ]);
      const config = new HarnessConfigService();
      const client = new CTraderClientService(config as unknown as ConfigService);
      return {
        adapter: new CTraderAdapter(client),
        dispose: () => client.onModuleDestroy(),
      };
    }
    default:
      throw new Error(
        `No harness adapter factory for broker "${brokerId}" ` +
          '(supported: paper-broker, oanda, ctrader family).',
      );
  }
}

/**
 * Minimal read-only ConfigService view for harness-constructed adapters.
 * Maps the same env vars the application configuration maps (see
 * src/config/configuration.ts `broker.*`).
 */
class HarnessConfigService {
  get(key: string, defaultValue?: string): string | undefined {
    if (key === 'broker.ctraderClientId') return process.env.CTRADER_CLIENT_ID ?? defaultValue;
    if (key === 'broker.ctraderClientSecret') {
      return process.env.CTRADER_CLIENT_SECRET ?? defaultValue;
    }
    return defaultValue;
  }
}
