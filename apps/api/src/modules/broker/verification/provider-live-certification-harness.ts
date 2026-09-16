/**
 * Provider PRODUCTION-LIVE certification harness — Round 7 (R7-impl-harness).
 *
 * WHAT THIS IS:
 * The OPERATOR-ONLY REAL-MONEY certification engine (audit R7-audit-D gap
 * matrix items #1/#2/#4/#5/#6/#7). It is a SEPARATE engine from the DEMO
 * verification harness in provider-verification-harness.ts — that engine's
 * contract (mode: 'DEMO' typed + runtime-guarded) is untouched and this file
 * reuses only its exported disciplines:
 *   - sanitized evidence (redactString-backed sanitizeVerificationDetail),
 *   - decimal-string violation assertions (decimalStringViolations),
 *   - per-step PASS / FAIL / SKIPPED with a fail-closed cascade.
 *
 * WHAT IT DOES:
 * Drives a REAL IBrokerAdapter constructed in BrokerMode.LIVE through the
 * production-LIVE certification sequence:
 *
 *   CONNECT → ACCOUNT_DISCOVERY → ACCOUNT_STATE → SYMBOL_METADATA → PRICE →
 *   MARGIN_ESTIMATE → BASELINE_EXPOSURE_SNAPSHOT → PLACE_MINIMUM_SAFE_ORDER →
 *   VERIFY_PROVIDER_ACK → QUERY_ORDER → QUERY_POSITION →
 *   MODIFY_PROTECTIVE_LEVELS → CLOSE_POSITION → VERIFY_CLOSED →
 *   RECONCILE_HISTORY → VERIFY_ZERO_UNEXPECTED_OPEN_EXPOSURE
 *
 * The canary order it places is REAL MONEY at the provider's own minimum
 * size, capped by the operator's explicit maximum exposure — NEVER sized from
 * any AI signal, NEVER above the cap.
 *
 * CERTIFICATION GATES (non-negotiable, evaluated IN THIS ORDER, BEFORE any
 * provider call):
 *  1. IREXPRO_ALLOW_LIVE_CERTIFICATION must be EXPLICITLY enabled. The engine
 *     receives the resolved gate object; the canonical resolution paths are
 *     isLiveCertificationEnabled(configuration()) (the app config maps the
 *     env var to broker.allowLiveCertification, FAIL-CLOSED: only the exact
 *     string 'true' enables — never a default-true) and
 *     resolveLiveCertificationGateFromEnv(). Missing/disabled → typed
 *     LiveCertificationGateDisabledError with ZERO provider calls.
 *  2. The operator must pass an explicit CertificationTarget (brokerId,
 *     accountId, credentialSource — a DESCRIPTION of where the credential
 *     came from, never the credential itself) AND an explicit operator
 *     identity (operatorId, optional evidenceDir). Missing → typed
 *     LiveCertificationConfigurationError, zero provider calls.
 *  3. An explicit maximum canary exposure: maxCanaryExposure — a positive
 *     decimal string in the CANARY INSTRUMENT'S QUOTE CURRENCY (the currency
 *     the provider itself prices the canary notional in; for EURUSD that is
 *     USD, which equals the account currency for USD-denominated accounts).
 *     The canary size is derived ONLY from the provider's own instrument
 *     minimum (minLot), multiplied by the HARDCODED safety factor
 *     LIVE_CANARY_SAFETY_FACTOR (= 1 — the smallest order the provider
 *     accepts), and CAPPED at the smaller of (providerMinimum × safety
 *     factor, the lot cap derived from maxCanaryExposure). If the provider
 *     minimum exceeds the operator cap → typed LiveCanaryExposureRefusalError
 *     (fail-closed, ZERO orders). Never from any AI signal, never above the
 *     cap.
 *  4. The adapter is set to BrokerMode.LIVE before ANY connect call, the
 *     CONNECT step refuses a provider-reported non-LIVE account, and the
 *     ACCOUNT_STATE step re-verifies the classification through
 *     testConnection() — a DEMO-classified account under a LIVE certification
 *     is an immediate FAIL (mirror of the connect-time environment-mismatch
 *     enforcement in broker.service.ts).
 *  5. The engine never runs inside jest/CI unless the env gate is explicitly
 *     set AND credentials are provided via env — the spec entry points
 *     (metatrader5/oanda/ctrader .live-certification.spec.ts) wrap everything
 *     in describe.skip guards. CI is credential-free and gate-closed, so the
 *     real-provider suites structurally cannot run there.
 *
 * INVARIANTS (non-negotiable):
 * - SANITIZED EVIDENCE: the returned evidence object contains ONLY non-secret
 *   references — timestamps, step statuses, provider order/position ids,
 *   instrument symbols, masked account ids (maskProviderId — the platform's
 *   maskAccountIdForLog pattern), decimal-string sanity results. Credentials
 *   NEVER appear: every free-text detail passes through
 *   sanitizeVerificationDetail() and the evidence shape has no
 *   credential-shaped fields.
 * - DECIMAL-STRING DISCIPLINE: every monetary field the providers return is
 *   asserted to be a decimal STRING — a step FAILS when a money field is a
 *   JavaScript number (float-money contract violation).
 * - FAIL-CLOSED PER STEP: each step records PASS/FAIL/SKIPPED. A step whose
 *   prerequisite did not pass is SKIPPED (never silently attempted); a
 *   provider surface the adapter does not support makes its step SKIPPED with
 *   the honest reason. overall === 'PASS' additionally requires the full
 *   canary lifecycle (place → close → verify-closed →
 *   verify-zero-unexpected-open-exposure) to have PASSED — a PASS certifies
 *   that real money moved through the complete cycle and left no residue.
 * - REAL-MONEY SAFETY: the canary close (CLOSE_POSITION) is attempted
 *  whenever a canary order exists, regardless of intermediate step failures;
 *  the final VERIFY_ZERO_UNEXPECTED_OPEN_EXPOSURE diff treats ANY unexpected
 *  position or working order (vs the baseline snapshot) as a CRITICAL FAIL.
 *
 * PRODUCTION-LIVE VERIFICATION RULE (unchanged — this harness RECORDS
 * evidence, it never flips anything): productionLiveVerification stays the
 * documented operator catalog-edit + provider-matrix process. See
 * docs/brokers/provider-matrix.md — "Operator edits BROKER_CATALOG with
 * attested verifiedAt + evidenceRef (doc/ticket reference — never secrets).
 * Tests never flip it." The durable JSON artifact this harness writes is the
 * evidenceRef material for that process.
 */
import { createHash, randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import {
  BrokerInstrument,
  BrokerMode,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
  BrokerPosition,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
} from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import { OandaAdapter } from '../adapters/oanda/oanda.adapter';
import {
  ProviderVerificationSummary,
  VerificationOverallStatus,
  VerificationStepStatus,
  decimalStringViolations,
  sanitizeVerificationDetail,
} from './provider-verification-harness';

// ─── Typed fail-closed certification errors ───────────────────────────────────

/** Gate 1: the LIVE certification env gate is missing/disabled (zero provider calls). */
export class LiveCertificationGateDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCertificationGateDisabledError';
  }
}

/** Gate 2/3: required operator certification inputs are missing or malformed (zero provider calls). */
export class LiveCertificationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCertificationConfigurationError';
  }
}

/**
 * Gate 3 (runtime half): the provider's own minimum order exceeds the
 * operator's explicit maximum canary exposure — the certification refuses to
 * place ANY order (fail-closed, zero orders).
 */
export class LiveCanaryExposureRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCanaryExposureRefusalError';
  }
}

// ─── Gate resolution (fail-closed; canonical helpers for callers) ─────────────

/** The resolved state of the IREXPRO_ALLOW_LIVE_CERTIFICATION master gate. */
export interface LiveCertificationGate {
  readonly allowLiveCertification: boolean;
  /** Provenance description for the evidence record (e.g. 'env:IREXPRO_ALLOW_LIVE_CERTIFICATION'). */
  readonly source: string;
}

/**
 * Resolves the LIVE certification master gate straight from the environment —
 * the spec entry points' resolution path. FAIL-CLOSED: only the EXACT string
 * 'true' enables; absent, blank, 'false', or any other value = disabled.
 * (The application path is isLiveCertificationEnabled(configuration()) —
 * see src/config/configuration.ts.)
 */
export function resolveLiveCertificationGateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveCertificationGate {
  return {
    allowLiveCertification: env.IREXPRO_ALLOW_LIVE_CERTIFICATION === 'true',
    source: 'env:IREXPRO_ALLOW_LIVE_CERTIFICATION',
  };
}

// ─── Evidence types (sanitized — safe to log, persist, and console.log) ───────

/** One certification step's sanitized result (provider order ids are non-secret by entity design). */
export interface LiveCertificationStep {
  name: string;
  status: VerificationStepStatus;
  /** Sanitized human-readable evidence — never credentials (redaction applied). */
  detail?: string;
  /** Provider order/position identifier (non-secret by entity design). */
  providerOrderId?: string;
}

/**
 * Masked account/position/order id — the platform's maskAccountIdForLog
 * pattern (oanda.adapter.ts / live-account.service.ts maskAccountId): ONLY the
 * last 4 characters survive, prefixed '•••'.
 */
export function maskProviderId(value: string | null | undefined): string {
  if (!value || value.length < 4) return '•••';
  return `•••${String(value).slice(-4)}`;
}

/** Counted + masked-only exposure fingerprint (never raw id lists, never volumes). */
export interface LiveExposureFingerprint {
  capturedAt: string;
  positions: { count: number; maskedIds: string[] };
  workingOrders: { count: number; maskedIds: string[] };
}

/** The canary sizing record embedded in the evidence (all decimal strings). */
export interface LiveCanaryRecord {
  instrument: string;
  /** Policy candidate: providerMinimum × LIVE_CANARY_SAFETY_FACTOR. */
  requestedSize: string;
  /** The provider's own instrument minimum — the ONLY sizing source. */
  providerMinimum: string;
  /** The operator's explicit exposure cap + the lot cap derived from it. */
  cap: { maxCanaryExposure: string; derivedLotCap: string };
  /** The size actually placed: min(requestedSize, derivedLotCap). */
  actualSize: string;
  direction: 'BUY';
}

export interface LiveCertificationRunRecord {
  /**
   * Round 7.1 (P0-2): the unique certification run identity — generated at
   * run start, embedded in the evidence, and part of the artifact filename
   * (two same-broker runs in the same UTC second can never overwrite each
   * other). This is the reference an operator records against the broker
   * catalog when (and only when) the run certifies.
   */
  runId: string;
  mode: 'LIVE';
  brokerId: string;
  operatorId: string;
  target: {
    brokerId: string;
    /** The certification target's provider account id — MASKED in evidence. */
    accountIdMasked: string;
    /** Sanitized description of the credential source — never the credential itself. */
    credentialSource: string;
  };
  /** Present once the canary sizing was derived (before the order was placed). */
  canary?: LiveCanaryRecord;
  /** Present once the baseline snapshot step ran (before any state-changing step). */
  baselineExposure?: LiveExposureFingerprint;
  /** Present once the final zero-unexpected-exposure diff ran. */
  postExposure?: LiveExposureFingerprint;
  startedAt: string;
  finishedAt: string;
  steps: LiveCertificationStep[];
  summary: ProviderVerificationSummary;
  /** The raw checklist outcome (every stage green). NOT the certification decision — see certificationResult. */
  overall: VerificationOverallStatus;
}

/**
 * The FINAL, durable certification record.
 *
 * Round 7.1 (P0-2 — durable-evidence requirement): a certification run may
 * report `certificationResult === 'PASS'` ONLY when
 *   1. every required certification stage passed (checklist overall PASS),
 *   2. the run identity is known (runId),
 *   3. provider/broker/account environment is captured (mode + target),
 *   4. safety limits are captured (canary cap record),
 *   5. relevant provider references are captured (step-level provider ids),
 *   6. timestamps are captured (startedAt/finishedAt),
 *   7. the evidence is sanitized (every detail redacted + bounded),
 *   8. the evidence artifact is durably persisted to disk,
 *   9. persistence is VERIFIED by read-back + hash comparison, and
 *   10. an evidence identifier/hash is available (evidenceSha256).
 * If artifact persistence (or its verification) fails, the result is the
 * explicit `EVIDENCE_PERSISTENCE_FAILED` state — NEVER a PASS. An operator
 * can therefore not promote a provider to production-certified from an
 * ephemeral console result.
 */
export interface LiveCertificationEvidence extends LiveCertificationRunRecord {
  /**
   * sha256 (hex) over the canonical run-record content — every field of
   * LiveCertificationRunRecord in insertion order, excluding the durability
   * metadata fields. Embedded in the artifact and re-verified on read-back.
   */
  evidenceSha256: string;
  /** Durable-evidence outcome of the artifact write + read-back verification. */
  evidenceState: 'PERSISTED' | 'PERSISTENCE_FAILED';
  /**
   * THE authoritative certification decision. `PASS` requires a PASSING
   * checklist AND verified durable evidence. `EVIDENCE_PERSISTENCE_FAILED`
   * means the checklist outcome (see `overall`) exists only as ephemeral
   * console output — the run certified nothing.
   */
  certificationResult: 'PASS' | 'FAIL' | 'EVIDENCE_PERSISTENCE_FAILED';
  /** Absolute path of the durable evidence artifact (only once PERSISTED). */
  artifactPath?: string;
}

/**
 * Round 7.1 (P0-2): the single certifiability predicate — true ONLY for a
 * passing checklist whose evidence is durably persisted, read-back verified,
 * hash-referenced and path-recorded. Operator workflows and tests use this
 * guard instead of string-matching `overall`.
 */
export function isCertifiablePass(evidence: LiveCertificationEvidence): boolean {
  return (
    evidence.certificationResult === 'PASS' &&
    evidence.evidenceState === 'PERSISTED' &&
    evidence.overall === 'PASS' &&
    typeof evidence.artifactPath === 'string' &&
    evidence.artifactPath.length > 0 &&
    /^[0-9a-f]{64}$/.test(evidence.evidenceSha256)
  );
}

// ─── Canonical certification sequence ─────────────────────────────────────────

/**
 * The full production-LIVE certification sequence. There is deliberately NO
 * step allow-list: LIVE certification is the complete sequence or nothing.
 */
export const LIVE_CERTIFICATION_STAGES: readonly string[] = [
  'connect',
  'account-discovery',
  'account-state',
  'symbol-metadata',
  'price',
  'margin-estimate',
  'baseline-exposure-snapshot',
  'place-minimum-safe-order',
  'verify-provider-ack',
  'query-order',
  'query-position',
  'modify-protective-levels',
  'close-position',
  'verify-closed',
  'reconcile-history',
  'verify-zero-unexpected-open-exposure',
];

/** Stages that must PASS for overall === 'PASS' (the full canary lifecycle). */
export const LIVE_CERTIFICATION_REQUIRED_FOR_PASS: readonly string[] = [
  'place-minimum-safe-order',
  'close-position',
  'verify-closed',
  'verify-zero-unexpected-open-exposure',
];

// ─── Exact decimal-string helpers (BigInt only — never floats) ────────────────

const UNSIGNED_DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
/** Positive decimal string (strictly > 0) — the shape every operator cap must have. */
const POSITIVE_DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

interface ParsedDecimal {
  digits: bigint;
  scale: number;
}

function parseUnsignedDecimalString(value: string): ParsedDecimal | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!UNSIGNED_DECIMAL_PATTERN.test(trimmed)) return null;
  const [intPart, fracPart = ''] = trimmed.split('.');
  return { digits: BigInt(`${intPart}${fracPart}`), scale: fracPart.length };
}

function formatScaledDecimal(digits: bigint, scale: number): string {
  const text = digits.toString().padStart(scale + 1, '0');
  if (scale === 0) return text;
  return `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
}

function rescaleDecimal(parsed: ParsedDecimal, targetScale: number): ParsedDecimal {
  if (parsed.scale === targetScale) return parsed;
  if (parsed.scale < targetScale) {
    return {
      digits: parsed.digits * 10n ** BigInt(targetScale - parsed.scale),
      scale: targetScale,
    };
  }
  return { digits: parsed.digits / 10n ** BigInt(parsed.scale - targetScale), scale: targetScale };
}

function multiplyDecimals(a: ParsedDecimal, b: ParsedDecimal): ParsedDecimal {
  return { digits: a.digits * b.digits, scale: a.scale + b.scale };
}

/** floor(a / b) rendered at targetScale (BigInt truncation = floor for positives). */
function divideDecimalsFloor(
  a: ParsedDecimal,
  b: ParsedDecimal,
  targetScale: number,
): ParsedDecimal {
  const numerator = a.digits * 10n ** BigInt(b.scale + targetScale);
  const denominator = b.digits * 10n ** BigInt(a.scale);
  return { digits: numerator / denominator, scale: targetScale };
}

/** Exact comparison: -1 (a < b), 0, 1 (a > b). */
function compareDecimals(a: ParsedDecimal, b: ParsedDecimal): number {
  const scale = Math.max(a.scale, b.scale);
  const da = rescaleDecimal(a, scale).digits;
  const db = rescaleDecimal(b, scale).digits;
  if (da === db) return 0;
  return da > db ? 1 : -1;
}

// ─── Minimum-safe-order canary sizing (gate 3, hardcoded policy) ──────────────

/**
 * The per-provider HARDCODED minimum-safe-order safety factor. The canary is
 * EXACTLY the provider's own instrument minimum (factor 1 — the smallest REAL
 * order the provider accepts). Any future change above 1 must be justified in
 * this file: the canary size is NEVER an AI signal, NEVER a manual input.
 */
export const LIVE_CANARY_SAFETY_FACTOR = 1n;

/** Precision (decimal places) at which the exposure cap is converted to lots. */
const CANARY_CAP_LOT_SCALE = 8;

export interface LiveCanarySizingInputs {
  /** The provider's own instrument minimum (BrokerInstrument.minLot). */
  providerMinimum: string;
  /** The instrument's lot step (BrokerInstrument.lotStep). */
  lotStep: string;
  /** The instrument's contract size (units per lot). */
  contractSize: string;
  /** Fresh reference price (the ask) for the canary instrument. */
  referencePrice: string;
  /** The operator's explicit maximum canary exposure (quote currency, decimal string). */
  maxCanaryExposure: string;
}

export interface LiveCanarySizing {
  requestedSize: string;
  actualSize: string;
  derivedLotCap: string;
}

function parsePositiveInput(source: string, value: string): ParsedDecimal {
  const parsed = parseUnsignedDecimalString(value);
  if (!parsed || parsed.digits <= 0n) {
    throw new LiveCanaryExposureRefusalError(
      `Cannot derive the canary size: ${source} must be a positive decimal string (received ` +
        `"${sanitizeVerificationDetail(String(value))}") — refusing to size a LIVE order.`,
    );
  }
  return parsed;
}

/**
 * Derives the minimum-safe canary size — the ONLY sizing path in the LIVE
 * certification (gate 3):
 *
 *   requestedSize = providerMinimum × LIVE_CANARY_SAFETY_FACTOR
 *   derivedLotCap = floor(maxCanaryExposure / (contractSize × referencePrice))
 *                   floored to a whole multiple of the provider's lotStep
 *   actualSize    = min(requestedSize, derivedLotCap)
 *
 * REFUSALS (typed, fail-closed, zero orders):
 * - any input not a positive decimal string;
 * - the cap converts to less than ONE lot step;
 * - the provider's own minimum exceeds the operator's cap.
 */
export function deriveMinimumSafeCanarySize(inputs: LiveCanarySizingInputs): LiveCanarySizing {
  const providerMinimum = parsePositiveInput('providerMinimum', inputs.providerMinimum);
  const lotStep = parsePositiveInput('lotStep', inputs.lotStep);
  const contractSize = parsePositiveInput('contractSize', inputs.contractSize);
  const referencePrice = parsePositiveInput('referencePrice', inputs.referencePrice);
  const maxCanaryExposure = parsePositiveInput('maxCanaryExposure', inputs.maxCanaryExposure);

  // Quote-currency value of one lot — the exposure unit the operator's cap is
  // expressed in (documented: the canary instrument's quote currency).
  const notionalPerLot = multiplyDecimals(contractSize, referencePrice);

  // Cap converted to lots, then floored to a WHOLE MULTIPLE of the provider's
  // own lot step (a partial step is not a placeable size).
  const capInLots = divideDecimalsFloor(maxCanaryExposure, notionalPerLot, CANARY_CAP_LOT_SCALE);
  const capSteps = divideDecimalsFloor(capInLots, lotStep, 0);
  if (capSteps.digits < 1n) {
    throw new LiveCanaryExposureRefusalError(
      `LIVE certification canary refusal: the operator cap ${inputs.maxCanaryExposure} converts to ` +
        `less than one lot step (${inputs.lotStep}) at contract size ${inputs.contractSize} and ` +
        `reference price ${inputs.referencePrice} — no safe canary order exists under this cap. ` +
        'Zero orders were placed.',
    );
  }
  const derivedLotCap = multiplyDecimals(capSteps, lotStep);

  if (compareDecimals(derivedLotCap, providerMinimum) < 0) {
    throw new LiveCanaryExposureRefusalError(
      `LIVE certification canary refusal: the provider minimum ${inputs.providerMinimum} lots ` +
        `exceeds the operator cap ${inputs.maxCanaryExposure} (derived lot cap ` +
        `${formatScaledDecimal(derivedLotCap.digits, derivedLotCap.scale)}) — the canary can ` +
        `never be sized below the provider's own minimum. Zero orders were placed.`,
    );
  }

  const requested = multiplyDecimals(providerMinimum, {
    digits: LIVE_CANARY_SAFETY_FACTOR,
    scale: 0,
  });
  const actual = compareDecimals(requested, derivedLotCap) <= 0 ? requested : derivedLotCap;

  return {
    requestedSize: formatScaledDecimal(requested.digits, requested.scale),
    actualSize: formatScaledDecimal(actual.digits, actual.scale),
    derivedLotCap: formatScaledDecimal(derivedLotCap.digits, derivedLotCap.scale),
  };
}

// ─── Operator / target inputs (gate 2) ────────────────────────────────────────

/** The explicit certification target — WHAT is being certified. */
export interface CertificationTarget {
  brokerId: string;
  /** The provider account id being certified (e.g. MetaAPI account UUID, OANDA account id, ctidTraderAccountId). */
  accountId: string;
  /**
   * DESCRIPTION of where the credential came from (e.g.
   * 'env:OANDA_LIVE_CERT_TOKEN (operator-supplied personal access token)') —
   * NEVER the credential itself. Refused when it looks like an opaque secret.
   */
  credentialSource: string;
}

/** The explicit operator identity — WHO is certifying and WHERE evidence goes. */
export interface LiveCertificationOperator {
  operatorId: string;
  /** Directory for the evidence artifact (default: current working directory). */
  evidenceDir?: string;
}

// ─── Adapter optional-surface narrowing ───────────────────────────────────────

/**
 * Structural narrowing for the account-discovery surface. No adapter in the
 * current registry exposes listAccounts() on IBrokerAdapter — the
 * ACCOUNT_DISCOVERY stage SKIPS honestly for them and PASSes (target account
 * found among the discovered ids) for any adapter that does.
 */
interface AdapterWithAccountDiscovery {
  listAccounts(): Promise<readonly { accountId: string }[]>;
}

export function hasAccountDiscovery(
  adapter: IBrokerAdapter,
): adapter is IBrokerAdapter & AdapterWithAccountDiscovery {
  return (
    'listAccounts' in adapter &&
    typeof (adapter as { listAccounts?: unknown }).listAccounts === 'function'
  );
}

/** Decimal-string fields asserted on provider position payloads. */
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
const ACCOUNT_INFO_DECIMAL_FIELDS = ['balance', 'equity', 'margin', 'freeMargin', 'marginLevel'];
const ORDER_STATE_REQUIRED_DECIMAL_FIELDS = ['requestedQuantity', 'filledQuantity'];
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

function describeError(err: unknown): string {
  if (err instanceof BrokerAdapterError) {
    return `${err.code}: ${err.message.slice(0, 120)}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 120)}`;
  return String(err).slice(0, 120);
}

/** High-entropy opaque-secret heuristic for the credentialSource guard. */
const OPAQUE_SECRET_RUN_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;

function looksLikeOpaqueSecret(value: string): boolean {
  for (const match of value.matchAll(OPAQUE_SECRET_RUN_PATTERN)) {
    const run = match[0] ?? '';
    if (/[A-Za-z]/.test(run) && /\d/.test(run)) return true;
  }
  return false;
}

// ─── Certification options ────────────────────────────────────────────────────

export interface LiveCertificationOptions {
  /** Gate 1 input — the resolved IREXPRO_ALLOW_LIVE_CERTIFICATION state. */
  gate: LiveCertificationGate;
  /** Gate 2 input — the explicit certification target. */
  target: CertificationTarget;
  /** Gate 2 input — the explicit operator identity. */
  operator: LiveCertificationOperator;
  /**
   * Gate 3 input — the operator's explicit maximum canary exposure: a
   * POSITIVE decimal string in the canary instrument's QUOTE currency (≈ the
   * account currency for USD-denominated accounts).
   */
  maxCanaryExposure: string;
  /**
   * Credentials for the harness's own connect calls — memory-only, NEVER
   * recorded in evidence.
   */
  credentials: DecryptedBrokerCredentials;
  /**
   * Adapter override for tests/stubs. When omitted the harness constructs the
   * REAL provider adapter for the target brokerId (oanda / ctrader family;
   * metatrader5 through buildMetaTraderCertificationHarness).
   */
  adapter?: IBrokerAdapter;
  /**
   * Optional operator-requested canary instrument (must exist in the
   * provider's own catalog). Default: the first catalog instrument.
   */
  instrument?: string;
}

// ─── Gate evaluation (before ANY provider call, before adapter construction) ──

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LiveCertificationConfigurationError(
      `LIVE certification requires an explicit ${field} — refusing to run (zero provider calls).`,
    );
  }
  return value;
}

/**
 * Evaluates certification gates 1–3 (and the shape of the credentials) BEFORE
 * any provider call and before adapter construction. Every refusal is a typed
 * error: LiveCertificationGateDisabledError / LiveCertificationConfigurationError.
 */
export function assertLiveCertificationGates(options: LiveCertificationOptions): void {
  if (!options || options.gate?.allowLiveCertification !== true) {
    throw new LiveCertificationGateDisabledError(
      'LIVE certification is DISABLED: IREXPRO_ALLOW_LIVE_CERTIFICATION must be explicitly ' +
        "set to the exact string 'true' (see src/config/configuration.ts → broker.allowLiveCertification; " +
        'fail-closed, never a default-true). Zero provider calls were made.',
    );
  }
  if (!options.target) {
    throw new LiveCertificationConfigurationError(
      'LIVE certification requires an explicit CertificationTarget ' +
        '{ brokerId, accountId, credentialSource } — refusing to run (zero provider calls).',
    );
  }
  assertNonEmptyString(options.target.brokerId, 'target.brokerId');
  assertNonEmptyString(options.target.accountId, 'target.accountId');
  const credentialSource = assertNonEmptyString(
    options.target.credentialSource,
    'target.credentialSource (a DESCRIPTION of the credential source — never the credential itself)',
  );
  if (looksLikeOpaqueSecret(credentialSource)) {
    throw new LiveCertificationConfigurationError(
      'target.credentialSource looks like credential MATERIAL (opaque high-entropy run) — ' +
        'it must be a human-readable description of where the credential came from, never ' +
        'the credential itself. Refusing to run (zero provider calls).',
    );
  }
  if (!options.operator) {
    throw new LiveCertificationConfigurationError(
      'LIVE certification requires an explicit operator identity ' +
        '{ operatorId, evidenceDir? } — refusing to run (zero provider calls).',
    );
  }
  assertNonEmptyString(options.operator.operatorId, 'operator.operatorId');
  if (
    typeof options.maxCanaryExposure !== 'string' ||
    !POSITIVE_DECIMAL_PATTERN.test(options.maxCanaryExposure.trim())
  ) {
    throw new LiveCertificationConfigurationError(
      `LIVE certification requires an explicit maximum canary exposure as a POSITIVE decimal ` +
        `string in the canary instrument's quote currency (received ` +
        `"${typeof options.maxCanaryExposure === 'string' ? options.maxCanaryExposure : String(options.maxCanaryExposure)}") — ` +
        'refusing to run (zero provider calls).',
    );
  }
  const exposure = parseUnsignedDecimalString(options.maxCanaryExposure);
  if (!exposure || exposure.digits <= 0n) {
    throw new LiveCertificationConfigurationError(
      'LIVE certification requires maxCanaryExposure to be strictly positive — refusing to ' +
        'run (zero provider calls).',
    );
  }
  if (
    !options.credentials ||
    typeof options.credentials.accountId !== 'string' ||
    !options.credentials.accountId
  ) {
    throw new LiveCertificationConfigurationError(
      'LIVE certification requires credentials (with an accountId) — refusing to run ' +
        '(zero provider calls).',
    );
  }
  if (options.instrument !== undefined) {
    assertNonEmptyString(options.instrument, 'instrument (optional, but never empty)');
  }
}

// ─── Checklist engine (pure — every provider interaction goes through the adapter) ──

interface LiveChecklistContext {
  adapter: IBrokerAdapter;
  credentials: DecryptedBrokerCredentials;
  connectionReference?: string;
  instrument?: BrokerInstrument;
  digits: number;
  askPrice?: string;
  canary?: LiveCanarySizing;
  canaryOrderId?: string;
  canaryEntryPrice?: string;
  freeMargin?: string;
  accountCurrency?: string | null;
  baselinePositionIds: Set<string>;
  baselineOrderIds: Set<string>;
  baselineFingerprint?: LiveExposureFingerprint;
  postFingerprint?: LiveExposureFingerprint;
}

function fingerprintExposure(
  positions: readonly BrokerPosition[],
  workingOrders: readonly BrokerOrderState[],
): LiveExposureFingerprint {
  return {
    capturedAt: new Date().toISOString(),
    positions: {
      count: positions.length,
      maskedIds: positions.map((p) => maskProviderId(p.externalOrderId)),
    },
    workingOrders: {
      count: workingOrders.length,
      maskedIds: workingOrders.map((o) => maskProviderId(o.providerOrderId)),
    },
  };
}

/** Asserts a provider order-result payload for the LIVE canary lifecycle steps. */
function assertCanaryOrderResult(
  source: string,
  result: BrokerOrderResult,
  expectedStatus: BrokerOrderResult['status'],
  expectedId: boolean,
): string[] {
  const violations: string[] = [];
  if (!result.success) violations.push(`${source}.success === false`);
  if (result.status !== expectedStatus) {
    violations.push(`${source}.status "${result.status}" !== "${expectedStatus}"`);
  }
  if (expectedId && !result.externalOrderId) violations.push(`${source}.externalOrderId missing`);
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
}

/** Typed-error codes that mean "this provider surface does not exist". */
const NOT_APPLICABLE_ERROR_CODES: readonly BrokerErrorCode[] = [
  BrokerErrorCode.INVALID_ORDER_TYPE,
  BrokerErrorCode.INVALID_REQUEST,
  BrokerErrorCode.POSITION_NOT_FOUND,
];

/**
 * Runs the LIVE certification sequence against an adapter and returns
 * sanitized evidence. The engine sets BrokerMode.LIVE BEFORE any connect call
 * and refuses non-LIVE provider classifications. The canary sizing refusal
 * (provider minimum > operator cap) PROPAGATES as a typed
 * LiveCanaryExposureRefusalError — it happens before any state-changing step,
 * so zero orders are placed.
 */
export async function runLiveCertificationChecklist(
  adapter: IBrokerAdapter,
  options: LiveCertificationOptions,
): Promise<LiveCertificationRunRecord> {
  assertLiveCertificationGates(options);
  const startedAt = new Date();
  // Round 7.1 (P0-2): the run identity exists BEFORE the first stage — the
  // unique reference for every log line, artifact name and catalog record
  // this run can ever produce.
  const runId = randomUUID();
  console.log(
    `[live-certification] run started: runId=${runId} broker=${options.target.brokerId} ` +
      `operator=${sanitizeVerificationDetail(options.operator.operatorId)}`,
  );

  const steps: LiveCertificationStep[] = [];
  const statuses = new Map<string, VerificationStepStatus>();

  const ctx: LiveChecklistContext = {
    adapter,
    credentials: options.credentials,
    connectionReference: options.credentials.accountId,
    digits: 5,
    baselinePositionIds: new Set(),
    baselineOrderIds: new Set(),
  };

  const pushStep = (
    name: string,
    status: VerificationStepStatus,
    detail?: string,
    providerOrderId?: string,
  ): void => {
    const step: LiveCertificationStep = { name, status };
    if (detail) step.detail = sanitizeVerificationDetail(detail);
    if (providerOrderId) step.providerOrderId = providerOrderId;
    steps.push(step);
    statuses.set(name, status);
  };

  const passed = (name: string): boolean => statuses.get(name) === 'PASS';

  const runStep = async (
    name: string,
    run: () => Promise<{
      status: VerificationStepStatus;
      detail?: string;
      providerOrderId?: string;
    }>,
  ): Promise<void> => {
    let outcome: { status: VerificationStepStatus; detail?: string; providerOrderId?: string };
    try {
      outcome = await run();
    } catch (err) {
      outcome = { status: 'FAIL', detail: describeError(err) };
    }
    pushStep(name, outcome.status, outcome.detail, outcome.providerOrderId);
  };

  /** Converts a typed "surface not supported" rejection into an honest SKIPPED. */
  const notApplicable = (err: unknown): { status: 'SKIPPED'; detail: string } | null => {
    if (err instanceof BrokerAdapterError && NOT_APPLICABLE_ERROR_CODES.includes(err.code)) {
      return {
        status: 'SKIPPED',
        detail: `adapter reported ${err.code} — step not applicable on this provider surface`,
      };
    }
    return null;
  };

  // ── Stage: connect (LIVE mode, provider classification enforced) ──────────
  await runStep('connect', async () => {
    // Gate 4: the adapter is a LIVE adapter for the whole certification —
    // set BEFORE any connect call (mirror of the app's connect path).
    adapter.setMode(BrokerMode.LIVE);
    const result = await adapter.connect(options.credentials);
    if (!result.success) {
      return {
        status: 'FAIL',
        detail: `connect() reported failure${result.error ? `: ${result.error}` : ''}`,
      };
    }
    if (result.accountType !== BrokerMode.LIVE) {
      return {
        status: 'FAIL',
        detail:
          `provider reports a ${result.accountType} account under a LIVE certification — ` +
          'refusing to certify (environment mismatch, mirror of broker.service connect enforcement)',
      };
    }
    return {
      status: 'PASS',
      detail:
        `connected to LIVE account ${maskProviderId(result.accountId)}` +
        `${result.currency ? ` (${result.currency})` : ''}`,
    };
  });

  const connectFailed = statuses.get('connect') === 'FAIL';
  // Fail-closed cascade: without a LIVE connection nothing else can be certified.
  for (const name of LIVE_CERTIFICATION_STAGES) {
    if (name === 'connect' || statuses.get(name) !== undefined) continue;
    if (connectFailed) {
      pushStep(name, 'SKIPPED', 'connect failed — step not attempted');
    }
  }

  // ── Stage: account-discovery (where the adapter supports it) ──────────────
  if (!connectFailed) {
    await runStep('account-discovery', async () => {
      if (!hasAccountDiscovery(adapter)) {
        return {
          status: 'SKIPPED',
          detail:
            'adapter does not expose an account-discovery surface (listAccounts) — ' +
            'step not applicable on this provider',
        };
      }
      const accounts = await adapter.listAccounts();
      const found = accounts.some((a) => a.accountId === options.target.accountId);
      if (!found) {
        return {
          status: 'FAIL',
          detail:
            `certification target ${maskProviderId(options.target.accountId)} not present among ` +
            `${accounts.length} discoverable account(s) — the credential cannot access the target`,
        };
      }
      return {
        status: 'PASS',
        detail:
          `certification target ${maskProviderId(options.target.accountId)} present among ` +
          `${accounts.length} discoverable account(s)`,
      };
    });
  }

  // ── Stage: account-state (money fields + LIVE classification re-verified) ─
  if (!connectFailed) {
    await runStep('account-state', async () => {
      const info = await adapter.getAccountInfo();
      const violations = decimalStringViolations(
        'accountInfo',
        info as unknown as Record<string, unknown>,
        ACCOUNT_INFO_DECIMAL_FIELDS,
      );
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      if (info.currency === null || info.currency === undefined || info.currency === '') {
        return {
          status: 'FAIL',
          detail: 'provider reports NO account currency — cannot certify exposure accounting',
        };
      }
      // Classification re-verification through the independent
      // testConnection() surface — a DEMO-classified account under a LIVE
      // certification is an immediate FAIL.
      const classification = await adapter.testConnection(options.credentials);
      if (!classification.success || classification.accountType !== BrokerMode.LIVE) {
        return {
          status: 'FAIL',
          detail:
            `provider classifies the account as ${classification.accountType ?? 'UNKNOWN'} ` +
            '— LIVE certification requires a LIVE-classified account (immediate FAIL)',
        };
      }
      ctx.accountCurrency = info.currency;
      ctx.freeMargin = info.freeMargin;
      return {
        status: 'PASS',
        detail:
          `LIVE account ${maskProviderId(info.accountId)} currency=${info.currency} ` +
          `equity=${info.equity} freeMargin=${info.freeMargin}`,
      };
    });
  }

  // ── Stage: symbol-metadata (instrument spec from the provider's catalog) ──
  if (!connectFailed) {
    await runStep('symbol-metadata', async () => {
      const instruments = await adapter.getInstrumentList();
      if (!Array.isArray(instruments) || instruments.length === 0) {
        return { status: 'FAIL', detail: 'getInstrumentList() returned no instruments' };
      }
      const instrument = options.instrument
        ? instruments.find((i) => i.symbol === options.instrument)
        : instruments[0]!;
      if (!instrument) {
        return {
          status: 'FAIL',
          detail:
            `operator-requested canary instrument "${options.instrument}" absent from the ` +
            `provider catalog (${instruments.length} instruments)`,
        };
      }
      const violations = decimalStringViolations(
        `instrument[${instrument.symbol}]`,
        instrument as unknown as Record<string, unknown>,
        INSTRUMENT_DECIMAL_FIELDS,
      );
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      if (!Number.isInteger(instrument.digits) || instrument.digits <= 0) {
        return {
          status: 'FAIL',
          detail: `instrument[${instrument.symbol}].digits must be a positive integer`,
        };
      }
      ctx.instrument = instrument;
      ctx.digits = instrument.digits;
      return {
        status: 'PASS',
        detail:
          `canary instrument ${instrument.symbol} (digits ${instrument.digits}, minLot ` +
          `${instrument.minLot}, lotStep ${instrument.lotStep}, contractSize ${instrument.contractSize})`,
      };
    });
  }

  // ── Stage: price (fresh quote, bid/ask/spread sanity) ─────────────────────
  if (!connectFailed) {
    await runStep('price', async () => {
      if (!passed('symbol-metadata') || !ctx.instrument) {
        return {
          status: 'SKIPPED',
          detail: 'symbol-metadata did not pass — no instrument context',
        };
      }
      const price = await adapter.getCurrentPrice(ctx.instrument.symbol);
      const violations = decimalStringViolations(
        'price',
        price as unknown as Record<string, unknown>,
        ['bid', 'ask', 'spread'],
      );
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      const bid = parseUnsignedDecimalString(price.bid);
      const ask = parseUnsignedDecimalString(price.ask);
      const spread = parseUnsignedDecimalString(price.spread);
      if (!bid || !ask || !spread || bid.digits <= 0n || ask.digits <= 0n) {
        return { status: 'FAIL', detail: 'bid/ask must be positive decimal strings' };
      }
      if (compareDecimals(ask, bid) < 0) {
        return { status: 'FAIL', detail: `ask ${price.ask} < bid ${price.bid} — inverted quote` };
      }
      if (compareDecimals(spread, { digits: 0n, scale: 0 }) < 0) {
        return { status: 'FAIL', detail: `spread ${price.spread} is negative` };
      }
      ctx.askPrice = price.ask;
      return {
        status: 'PASS',
        detail: `${ctx.instrument.symbol} bid=${price.bid} ask=${price.ask} spread=${price.spread}`,
      };
    });
  }

  // ── Gate 3 (runtime half): canary sizing — BEFORE any state-changing step ─
  // A refusal PROPAGATES as a typed LiveCanaryExposureRefusalError: zero
  // orders are placed (the run aborts before PLACE_MINIMUM_SAFE_ORDER).
  if (!connectFailed && passed('symbol-metadata') && passed('price') && ctx.instrument) {
    ctx.canary = deriveMinimumSafeCanarySize({
      providerMinimum: ctx.instrument.minLot,
      lotStep: ctx.instrument.lotStep,
      contractSize: ctx.instrument.contractSize,
      referencePrice: ctx.askPrice!,
      maxCanaryExposure: options.maxCanaryExposure,
    });
  }

  // ── Stage: margin-estimate (fail-closed when unprovable) ──────────────────
  if (!connectFailed) {
    await runStep('margin-estimate', async () => {
      if (!ctx.canary || !ctx.instrument) {
        return {
          status: 'SKIPPED',
          detail: 'no canary size derived (symbol-metadata/price did not pass)',
        };
      }
      const margin = await adapter.getRequiredMargin({
        instrument: ctx.instrument.symbol,
        lotSize: ctx.canary.actualSize,
        direction: 'BUY',
        connectionReference: ctx.connectionReference,
      });
      if (margin === null) {
        return {
          status: 'FAIL',
          detail:
            'getRequiredMargin returned null — cannot prove the canary margin on a LIVE ' +
            'account (fail-closed: the canary will not be placed)',
        };
      }
      const violations = decimalStringViolations('requiredMargin', { margin }, ['margin']);
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      const parsedMargin = parseUnsignedDecimalString(margin);
      const parsedFree = ctx.freeMargin ? parseUnsignedDecimalString(ctx.freeMargin) : null;
      if (parsedMargin && parsedFree && compareDecimals(parsedMargin, parsedFree) > 0) {
        return {
          status: 'FAIL',
          detail:
            `required margin ${margin} exceeds free margin ${ctx.freeMargin} — the canary ` +
            'is not safely placeable (fail-closed, zero orders)',
        };
      }
      return {
        status: 'PASS',
        detail: `required margin ${margin} for ${ctx.canary.actualSize} lots (free margin ${ctx.freeMargin})`,
      };
    });
  }

  // ── Stage: baseline-exposure-snapshot (BEFORE any state-changing step) ────
  if (!connectFailed) {
    await runStep('baseline-exposure-snapshot', async () => {
      const positions = await adapter.getOpenPositions();
      const workingOrders = await adapter.listOrders();
      for (const [index, position] of positions.entries()) {
        const violations = decimalStringViolations(
          `position[${position.externalOrderId ?? index}]`,
          position as unknown as Record<string, unknown>,
          POSITION_DECIMAL_FIELDS,
        );
        if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      }
      for (const [index, order] of workingOrders.entries()) {
        const violations = orderStateViolations(
          `orderState[${order.providerOrderId ?? index}]`,
          order,
        );
        if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      }
      for (const position of positions) ctx.baselinePositionIds.add(position.externalOrderId);
      for (const order of workingOrders) ctx.baselineOrderIds.add(order.providerOrderId);
      ctx.baselineFingerprint = fingerprintExposure(positions, workingOrders);
      return {
        status: 'PASS',
        detail:
          `baseline recorded before any state-changing step: ${positions.length} open ` +
          `position(s), ${workingOrders.length} working order(s)`,
      };
    });
  }

  // ── Stage: place-minimum-safe-order (the REAL-MONEY canary) ───────────────
  if (!connectFailed) {
    await runStep('place-minimum-safe-order', async () => {
      // A FAILed account-discovery (the credential cannot enumerate the
      // certification target) blocks the canary: contradiction about the
      // target account is never traded through. An honest SKIPPED discovery
      // (no listAccounts surface) does NOT block.
      if (statuses.get('account-discovery') === 'FAIL') {
        return {
          status: 'SKIPPED',
          detail:
            'account-discovery FAILED — the credential cannot enumerate the certification ' +
            'target; refusing to place the canary (fail-closed, zero orders)',
        };
      }
      const missing: string[] = [];
      for (const prereq of ['account-state', 'symbol-metadata', 'price', 'margin-estimate']) {
        if (!passed(prereq)) missing.push(prereq);
      }
      if (missing.length > 0) {
        return {
          status: 'SKIPPED',
          detail: `prerequisite stage(s) did not pass (${missing.join(', ')}) — no canary order`,
        };
      }
      const request: BrokerOrderRequest = {
        idempotencyKey: `live-cert-${randomUUID()}`,
        clientOrderId: `livecert-${randomUUID()}`,
        instrument: ctx.instrument!.symbol,
        direction: 'BUY',
        lotSize: ctx.canary!.actualSize,
        stopLoss: '0',
        takeProfit: '0',
        orderKind: 'MARKET',
        timeInForce: 'GTC',
        comment: 'live-certification-canary',
        connectionReference: ctx.connectionReference,
      };
      const result = await adapter.placeOrder(request);
      const violations = assertCanaryOrderResult('canaryOrder', result, 'FILLED', true);
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      ctx.canaryOrderId = result.externalOrderId;
      return {
        status: 'PASS',
        detail:
          `MARKET BUY ${ctx.canary!.actualSize} lots of ${ctx.instrument!.symbol} placed ` +
          `(id ${result.externalOrderId}) — provider-minimum canary under cap ` +
          `${options.maxCanaryExposure}`,
        providerOrderId: result.externalOrderId,
      };
    });
  }

  // ── Stage: verify-provider-ack (the fill acknowledgment is complete) ──────
  if (!connectFailed) {
    await runStep('verify-provider-ack', async () => {
      if (!passed('place-minimum-safe-order') || !ctx.canaryOrderId || !ctx.canary) {
        return {
          status: 'SKIPPED',
          detail: 'place-minimum-safe-order did not pass — no provider ack to verify',
        };
      }
      const result = await adapter.getOrderById(ctx.canaryOrderId);
      if (!result) {
        return {
          status: 'FAIL',
          detail: `provider cannot resolve its own acknowledgment for order ${ctx.canaryOrderId}`,
        };
      }
      const violations = orderStateViolations(`canaryOrderState[${ctx.canaryOrderId}]`, result);
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      const echoed = parseUnsignedDecimalString(result.filledQuantity);
      const actual = parseUnsignedDecimalString(ctx.canary.actualSize);
      if (!echoed || !actual || compareDecimals(echoed, actual) !== 0) {
        return {
          status: 'FAIL',
          detail:
            `provider ack filledQuantity ${result.filledQuantity} does not echo the requested ` +
            `canary size ${ctx.canary.actualSize}`,
        };
      }
      return {
        status: 'PASS',
        detail:
          `provider acknowledged the canary fill: ${result.filledQuantity} lots at ` +
          `${result.avgFillPrice ?? 'n/a'} (status ${result.status})`,
        providerOrderId: ctx.canaryOrderId,
      };
    });
  }

  // ── Stage: query-order (order-state reconciliation surface) ───────────────
  if (!connectFailed) {
    await runStep('query-order', async () => {
      if (!ctx.canaryOrderId) {
        return {
          status: 'SKIPPED',
          detail: 'no canary order to query (place-minimum-safe-order did not pass)',
        };
      }
      const state = await adapter.getOrderById(ctx.canaryOrderId);
      if (!state) {
        return {
          status: 'FAIL',
          detail: `getOrderById returned null for the placed canary order ${ctx.canaryOrderId}`,
        };
      }
      const violations = orderStateViolations(`orderState[${ctx.canaryOrderId}]`, state);
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      if (state.status !== 'FILLED') {
        return {
          status: 'FAIL',
          detail:
            `canary order ${ctx.canaryOrderId} is "${state.status}" — a filled market canary ` +
            'must read FILLED on the order-state surface',
        };
      }
      // The working-order listing (the reconciliation read surface) must not
      // carry the FILLED market canary as a working order.
      const working = await adapter.listOrders();
      if (working.some((o) => o.providerOrderId === ctx.canaryOrderId)) {
        return {
          status: 'FAIL',
          detail: `filled canary order ${ctx.canaryOrderId} still listed among ${working.length} working order(s)`,
        };
      }
      return {
        status: 'PASS',
        detail:
          `order ${ctx.canaryOrderId} reads ${state.status} ` +
          `(${state.filledQuantity}/${state.requestedQuantity} lots); absent from ` +
          `${working.length} working order(s)`,
        providerOrderId: ctx.canaryOrderId,
      };
    });
  }

  // ── Stage: query-position (the canary is live in the position surface) ────
  if (!connectFailed) {
    await runStep('query-position', async () => {
      if (!ctx.canaryOrderId) {
        return {
          status: 'SKIPPED',
          detail: 'no canary order to query (place-minimum-safe-order did not pass)',
        };
      }
      const position = await adapter.getPositionById(ctx.canaryOrderId);
      if (!position) {
        return {
          status: 'FAIL',
          detail: `canary position ${ctx.canaryOrderId} not found among the open positions`,
        };
      }
      const violations = decimalStringViolations(
        `canaryPosition[${position.externalOrderId}]`,
        position as unknown as Record<string, unknown>,
        POSITION_DECIMAL_FIELDS,
      );
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      ctx.canaryEntryPrice = position.openPrice;
      return {
        status: 'PASS',
        detail:
          `canary position ${position.externalOrderId} open at ${position.openPrice} ` +
          `(${position.lotSize} lots)`,
        providerOrderId: position.externalOrderId,
      };
    });
  }

  // ── Stage: modify-protective-levels (risk-REDUCING direction only) ───────
  if (!connectFailed) {
    await runStep('modify-protective-levels', async () => {
      if (!ctx.canaryOrderId || !passed('query-position') || !ctx.instrument) {
        return {
          status: 'SKIPPED',
          detail: 'query-position did not pass — no canary position whose levels to modify',
        };
      }
      // A fresh quote so the protective level is valid against the CURRENT
      // market (the level must be strictly below both entry and bid).
      const price = await adapter.getCurrentPrice(ctx.instrument.symbol);
      const priceViolations = decimalStringViolations(
        'price',
        price as unknown as Record<string, unknown>,
        ['bid', 'spread'],
      );
      if (priceViolations.length > 0) {
        return { status: 'FAIL', detail: priceViolations.join('; ') };
      }
      const entry = parseUnsignedDecimalString(ctx.canaryEntryPrice!);
      const bid = parseUnsignedDecimalString(price.bid);
      const spread = parseUnsignedDecimalString(price.spread);
      if (!entry || !bid || !spread) {
        return {
          status: 'FAIL',
          detail: 'could not parse entry/bid/spread for the protective level',
        };
      }
      // Risk-reducing-only policy: the stop is placed STRICTLY below BOTH the
      // entry and the current bid, minus one spread. The engine NEVER widens
      // an existing stop and NEVER extends the take profit (extending TP is
      // risk-increasing) — the TP stays untouched.
      const anchor = compareDecimals(entry, bid) <= 0 ? entry : bid;
      const anchorScale = Math.max(anchor.scale, spread.scale, ctx.digits);
      const stopDigits =
        rescaleDecimal(anchor, anchorScale).digits - rescaleDecimal(spread, anchorScale).digits;
      if (stopDigits <= 0n) {
        return { status: 'FAIL', detail: 'computed protective stop is not positive' };
      }
      const protectiveStop = formatScaledDecimal(
        rescaleDecimal({ digits: stopDigits, scale: anchorScale }, ctx.digits).digits,
        ctx.digits,
      );
      let result: BrokerOrderResult;
      try {
        result = await adapter.modifyOrder(ctx.canaryOrderId, { newStopLoss: protectiveStop });
      } catch (err) {
        const na = notApplicable(err);
        if (na) return na;
        throw err;
      }
      const violations = assertCanaryOrderResult('modifyProtectiveLevels', result, 'FILLED', false);
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      return {
        status: 'PASS',
        detail:
          `protective SL set to ${protectiveStop} (entry ${ctx.canaryEntryPrice}, bid ` +
          `${price.bid}) — risk-reducing direction only; TP intentionally untouched`,
      };
    });
  }

  // ── Stage: close-position (ALWAYS attempted once a canary exists) ─────────
  if (!connectFailed) {
    await runStep('close-position', async () => {
      if (!ctx.canaryOrderId) {
        return {
          status: 'SKIPPED',
          detail: 'no canary order to close (place-minimum-safe-order did not pass)',
        };
      }
      // Real-money safety: the close is attempted regardless of intermediate
      // step failures — the engine never leaves its own canary open because a
      // later verification step failed.
      const result = await adapter.closeOrder(ctx.canaryOrderId);
      const violations = assertCanaryOrderResult('closePosition', result, 'FILLED', false);
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      return {
        status: 'PASS',
        detail: `canary position ${ctx.canaryOrderId} closed`,
        providerOrderId: ctx.canaryOrderId,
      };
    });
  }

  // ── Stage: verify-closed (the canary is gone from the open positions) ─────
  if (!connectFailed) {
    await runStep('verify-closed', async () => {
      if (!passed('close-position') || !ctx.canaryOrderId) {
        return {
          status: 'SKIPPED',
          detail: 'close-position did not pass — cannot verify closure',
        };
      }
      const positions = await adapter.getOpenPositions();
      if (positions.some((p) => p.externalOrderId === ctx.canaryOrderId)) {
        return {
          status: 'FAIL',
          detail: `canary position ${ctx.canaryOrderId} still reported open after close`,
        };
      }
      let byId: Awaited<ReturnType<IBrokerAdapter['getPositionById']>> = null;
      try {
        byId = await adapter.getPositionById(ctx.canaryOrderId);
      } catch (err) {
        // A typed POSITION_NOT_FOUND for a just-closed position is the
        // provider confirming the closure — anything else fails honestly.
        if (
          !(err instanceof BrokerAdapterError) ||
          err.code !== BrokerErrorCode.POSITION_NOT_FOUND
        ) {
          throw err;
        }
      }
      if (byId) {
        return {
          status: 'FAIL',
          detail: `getPositionById still resolves the closed canary position ${ctx.canaryOrderId}`,
        };
      }
      return {
        status: 'PASS',
        detail: `canary position ${ctx.canaryOrderId} gone from the open-position surface`,
        providerOrderId: ctx.canaryOrderId,
      };
    });
  }

  // ── Stage: reconcile-history (the canary trade is terminal in history) ────
  if (!connectFailed) {
    await runStep('reconcile-history', async () => {
      if (!passed('close-position') || !ctx.canaryOrderId) {
        return {
          status: 'SKIPPED',
          detail: 'close-position did not pass — no closed trade to reconcile',
        };
      }
      // Run-relative window: wide enough for provider clock drift, narrow
      // enough to stay meaningful for a LIVE account with real history.
      const from = new Date(startedAt.getTime() - 5 * 60 * 1000);
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const trades = await adapter.getClosedTrades(from, to);
      const match = trades.find((t) => t.externalOrderId === ctx.canaryOrderId);
      if (!match) {
        return {
          status: 'FAIL',
          detail:
            `closed canary trade ${ctx.canaryOrderId} not found in the trade history ` +
            `(${trades.length} record(s) returned)`,
        };
      }
      const violations = decimalStringViolations(
        `closedTrade[${match.externalOrderId}]`,
        match as unknown as Record<string, unknown>,
        CLOSED_TRADE_DECIMAL_FIELDS,
      );
      if (violations.length > 0) return { status: 'FAIL', detail: violations.join('; ') };
      return {
        status: 'PASS',
        detail:
          `closed canary trade ${match.externalOrderId} present in history ` +
          `(closeReason ${match.closeReason})`,
        providerOrderId: match.externalOrderId,
      };
    });
  }

  // ── Stage: verify-zero-unexpected-open-exposure (the critical diff) ───────
  if (!connectFailed) {
    await runStep('verify-zero-unexpected-open-exposure', async () => {
      if (!passed('baseline-exposure-snapshot')) {
        return {
          status: 'SKIPPED',
          detail: 'baseline-exposure-snapshot did not pass — no baseline to diff against',
        };
      }
      const postPositions = await adapter.getOpenPositions();
      const postOrders = await adapter.listOrders();
      ctx.postFingerprint = fingerprintExposure(postPositions, postOrders);
      const unexpectedPositions = postPositions.filter(
        (p) => !ctx.baselinePositionIds.has(p.externalOrderId),
      );
      const unexpectedOrders = postOrders.filter(
        (o) => !ctx.baselineOrderIds.has(o.providerOrderId),
      );
      if (unexpectedPositions.length > 0 || unexpectedOrders.length > 0) {
        return {
          status: 'FAIL',
          detail:
            'CRITICAL: unexpected open exposure after certification — new position(s) [' +
            `${unexpectedPositions.map((p) => maskProviderId(p.externalOrderId)).join(', ')}], ` +
            'new working order(s) [' +
            `${unexpectedOrders.map((o) => maskProviderId(o.providerOrderId)).join(', ')}] ` +
            'not present in the baseline snapshot',
        };
      }
      const vanished = Array.from(ctx.baselinePositionIds).filter(
        (id) => !postPositions.some((p) => p.externalOrderId === id),
      );
      return {
        status: 'PASS',
        detail:
          `zero unexpected open exposure: ${postPositions.length} open position(s), ` +
          `${postOrders.length} working order(s) — no additions vs the baseline snapshot` +
          (vanished.length > 0
            ? ` (${vanished.length} baseline position(s) closed by others during the run — not harness-caused)`
            : ''),
      };
    });
  }

  const finishedAt = new Date();
  const summary: ProviderVerificationSummary = {
    passed: steps.filter((s) => s.status === 'PASS').length,
    failed: steps.filter((s) => s.status === 'FAIL').length,
    skipped: steps.filter((s) => s.status === 'SKIPPED').length,
  };
  const lifecycleComplete = LIVE_CERTIFICATION_REQUIRED_FOR_PASS.every(
    (name) => statuses.get(name) === 'PASS',
  );
  const overall: VerificationOverallStatus =
    summary.failed === 0 && summary.passed > 0 && lifecycleComplete ? 'PASS' : 'FAIL';

  return {
    runId,
    mode: 'LIVE',
    brokerId: options.target.brokerId,
    operatorId: sanitizeVerificationDetail(options.operator.operatorId),
    target: {
      brokerId: options.target.brokerId,
      accountIdMasked: maskProviderId(options.target.accountId),
      credentialSource: sanitizeVerificationDetail(options.target.credentialSource),
    },
    ...(ctx.canary && ctx.instrument
      ? {
          canary: {
            instrument: ctx.instrument.symbol,
            requestedSize: ctx.canary.requestedSize,
            providerMinimum: ctx.instrument.minLot,
            cap: {
              maxCanaryExposure: options.maxCanaryExposure,
              derivedLotCap: ctx.canary.derivedLotCap,
            },
            actualSize: ctx.canary.actualSize,
            direction: 'BUY' as const,
          },
        }
      : {}),
    ...(ctx.baselineFingerprint ? { baselineExposure: ctx.baselineFingerprint } : {}),
    ...(ctx.postFingerprint ? { postExposure: ctx.postFingerprint } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    steps,
    summary,
    overall,
  };
}

// ─── Durable evidence artifact (Round 7.1 P0-2 — fail-closed) ────────────────

/** `YYYYMMDD-HHmmss` (UTC) — deterministic artifact timestamp segment. */
export function liveCertificationArtifactTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Artifact file name: live-certification-<brokerId>-<runId>-<YYYYMMDD-HHmmss>.json
 *
 * Round 7.1 (P0-2): the runId segment makes every artifact name UNIQUE per
 * run — two same-broker runs inside the same UTC second can never silently
 * overwrite each other's evidence (writeFileSync truncates).
 */
export function liveCertificationArtifactFileName(
  brokerId: string,
  runId: string,
  date: Date,
): string {
  return `live-certification-${brokerId}-${runId}-${liveCertificationArtifactTimestamp(date)}.json`;
}

/**
 * Durability metadata fields excluded from the canonical evidence hash (they
 * describe the artifact write itself, not the run content).
 */
const EVIDENCE_DURABILITY_FIELDS: readonly string[] = [
  'evidenceSha256',
  'evidenceState',
  'certificationResult',
  'artifactPath',
];

/**
 * sha256 (hex) over the canonical run-record content: every evidence field in
 * insertion order EXCEPT the durability metadata. Stable across the in-memory
 * record, the written artifact, and any re-parse (JSON preserves document
 * order), so a read-back hash comparison proves the artifact content.
 */
export function computeLiveCertificationEvidenceSha256(
  source: LiveCertificationRunRecord | LiveCertificationEvidence,
): string {
  const canonical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (EVIDENCE_DURABILITY_FIELDS.includes(key)) continue;
    canonical[key] = value;
  }
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * Read-back verification of a written evidence artifact: the file must exist,
 * parse, carry the same run identity, and hash identically to the evidence it
 * claims to hold. ANY mismatch means the durability proof failed.
 */
export function verifyLiveCertificationArtifact(
  path: string,
  evidence: LiveCertificationEvidence,
): boolean {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as LiveCertificationEvidence;
    if (parsed.runId !== evidence.runId) return false;
    return computeLiveCertificationEvidenceSha256(parsed) === evidence.evidenceSha256;
  } catch {
    return false;
  }
}

/**
 * Round 7.1 (P0-2 — fail-closed evidence finalization): convert a checklist
 * run record into the FINAL evidence by persisting it durably and VERIFYING
 * the write. The returned object can only carry
 * `certificationResult === 'PASS'` when the artifact write succeeded AND the
 * read-back hash verified — a persistence failure (unwritable/missing
 * evidence dir, disk error, tampered content) locks the result to the
 * explicit `EVIDENCE_PERSISTENCE_FAILED` state, and the failure is printed
 * loudly. No ephemeral console PASS can ever be mistaken for certification.
 */
function finalizeLiveCertificationEvidence(
  record: LiveCertificationRunRecord,
  evidenceDir?: string,
): LiveCertificationEvidence {
  const evidenceSha256 = computeLiveCertificationEvidenceSha256(record);
  const evidence: LiveCertificationEvidence = {
    ...record,
    evidenceSha256,
    evidenceState: 'PERSISTENCE_FAILED',
    certificationResult: 'EVIDENCE_PERSISTENCE_FAILED',
  };
  try {
    const path = join(
      evidenceDir ?? '.',
      // The artifact is named from the RUN's own finishedAt (part of the
      // hashed record) — deterministic per run, unique via runId.
      liveCertificationArtifactFileName(
        evidence.brokerId,
        evidence.runId,
        new Date(record.finishedAt),
      ),
    );
    writeFileSync(path, JSON.stringify(evidence, null, 2), { encoding: 'utf8' });
    if (!verifyLiveCertificationArtifact(path, evidence)) {
      throw new Error('read-back verification failed (artifact missing, unparsable, or hash mismatch)');
    }
    evidence.evidenceState = 'PERSISTED';
    evidence.certificationResult = record.overall;
    evidence.artifactPath = path;
    console.log(
      `[live-certification] evidence artifact written + verified: ${path} ` +
        `(runId=${evidence.runId}, sha256=${evidenceSha256.slice(0, 16)}…, ` +
        `certificationResult=${evidence.certificationResult})`,
    );
    return evidence;
  } catch (err) {
    console.error(
      '[live-certification] EVIDENCE PERSISTENCE FAILED — this run is NOT certifiable: ' +
        `certificationResult=EVIDENCE_PERSISTENCE_FAILED (checklist outcome ` +
        `'${record.overall}' exists only as ephemeral console output). Cause: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return evidence;
  }
}

// ─── Operator entry point ─────────────────────────────────────────────────────

/**
 * Operator-only REAL-MONEY LIVE certification (NEVER in CI: the spec entry
 * points are env-gated; CI sets no gate and no credentials).
 *
 * Evaluates the certification gates (typed refusals, zero provider calls),
 * builds (or takes) the REAL adapter, drives it in BrokerMode.LIVE through the
 * full certification sequence, disconnects in `finally`, writes the durable
 * sanitized evidence artifact, and returns the evidence.
 *
 * The ONLY legitimate use of a PASSING evidence object is the documented
 * operator process: record the artifact (evidenceRef + verifiedAt) against the
 * broker catalog entry + docs/brokers/provider-matrix.md to flip
 * productionLiveVerification to VERIFIED. Tests never flip it.
 */
export async function runLiveProviderCertification(
  options: LiveCertificationOptions,
): Promise<LiveCertificationEvidence> {
  // Gates 1–3: typed refusals BEFORE any provider call / adapter construction.
  assertLiveCertificationGates(options);
  const built = options.adapter
    ? null
    : await buildLiveCertificationAdapter(options.target.brokerId);
  const adapter = options.adapter ?? built!.adapter;
  let record: LiveCertificationRunRecord;
  try {
    record = await runLiveCertificationChecklist(adapter, options);
  } finally {
    // Jest/CI hygiene + real-money hygiene: never leave a provider session
    // open behind the harness, whatever the outcome.
    try {
      await adapter.disconnect();
    } catch {
      // best-effort — the evidence already records the run outcome.
    }
    if (built?.dispose) {
      try {
        await built.dispose();
      } catch {
        // best-effort cleanup (client transport teardown)
      }
    }
  }
  // Round 7.1 (P0-2): the checklist outcome is only HALF the certification
  // decision — the evidence must also be durably persisted and read-back
  // verified before the result may be PASS. Persistence failure locks the
  // result to EVIDENCE_PERSISTENCE_FAILED (never a certifiable PASS).
  return finalizeLiveCertificationEvidence(record, options.operator.evidenceDir);
}

// ─── Adapter factories (real adapters, harness-owned lifecycles) ─────────────

export interface BuiltLiveCertificationAdapter {
  adapter: IBrokerAdapter;
  /** Optional teardown for harness-owned platform clients (cTrader WS, MetaApi SDK). */
  dispose?: () => Promise<void>;
}

/**
 * Constructs the REAL adapter for a LIVE-certification-supported broker:
 * - 'oanda' — OANDA v20 REST (per-operator token; LIVE base URL api-fxtrade
 *   is selected by the adapter once the engine sets BrokerMode.LIVE);
 * - 'ctrader' family — cTrader Open API (platform app credentials from
 *   CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET env; LIVE host
 *   wss://live.ctraderapi.com:5036 selected by the engine's LIVE mode).
 *
 * 'paper-broker' and unknown ids are REFUSED: the paper simulation is
 * DEMO-only and can never be LIVE-certified; MT5 goes through
 * buildMetaTraderCertificationHarness (it needs the platform MetaAPI token).
 */
export async function buildLiveCertificationAdapter(
  brokerId: string,
): Promise<BuiltLiveCertificationAdapter> {
  switch (brokerId) {
    case 'oanda':
      return { adapter: new OandaAdapter() };
    case 'ctrader':
    case 'pepperstone-ctrader':
    case 'icmarkets-ctrader': {
      // The cTrader suite is loaded via DYNAMIC import (the same discipline as
      // the DEMO harness factory): it must stay off this module's static
      // dependency path so paper/oanda certification runs never load it.
      const [{ CTraderAdapter }, { CTraderClientService }] = await Promise.all([
        import('../adapters/ctrader/ctrader.adapter'),
        import('../adapters/ctrader/ctrader-client.service'),
      ]);
      const client = new CTraderClientService(
        new LiveHarnessConfigService() as unknown as ConfigService,
      );
      return {
        adapter: new CTraderAdapter(client, brokerId),
        dispose: () => client.onModuleDestroy(),
      };
    }
    default:
      throw new LiveCertificationConfigurationError(
        `No LIVE certification adapter factory for broker "${brokerId}" ` +
          '(supported: metatrader5 via buildMetaTraderCertificationHarness, oanda, ctrader family). ' +
          'paper-broker is DEMO-only and can never be LIVE-certified.',
      );
  }
}

/**
 * Builds the REAL MetaTrader 5 certification stack the way broker.module does
 * (MetaApiClientService + MetaTraderAdapter) so the MT5 live-certification
 * spec can drive it with the operator's MetaAPI platform token
 * (METAAPI_LIVE_CERT_TOKEN) + the target MetaAPI account UUID.
 *
 * The MetaApi SDK is loaded via DYNAMIC import: it stays off the static
 * dependency path so non-MT5 certification runs never load the cloud SDK.
 * The token is passed to the client service through a minimal read-only
 * ConfigService view — never logged, never persisted, never in evidence.
 */
export async function buildMetaTraderCertificationHarness(
  metaApiToken?: string,
): Promise<BuiltLiveCertificationAdapter> {
  const token = metaApiToken ?? process.env.METAAPI_LIVE_CERT_TOKEN ?? process.env.METAAPI_TOKEN;
  if (!token || typeof token !== 'string') {
    throw new LiveCertificationConfigurationError(
      'MetaTrader 5 LIVE certification requires the MetaAPI platform token — pass it explicitly ' +
        'or set METAAPI_LIVE_CERT_TOKEN (fallback: METAAPI_TOKEN).',
    );
  }
  const [{ MetaTraderAdapter }, { MetaApiClientService }] = await Promise.all([
    import('../adapters/metatrader.adapter'),
    import('../services/metaapi-client.service'),
  ]);
  const client = new MetaApiClientService(
    new StaticTokenConfigService(token) as unknown as ConfigService,
  );
  return {
    adapter: new MetaTraderAdapter(client),
    dispose: () => client.onModuleDestroy(),
  };
}

/**
 * Minimal read-only ConfigService view for harness-constructed adapters (the
 * DEMO harness's HarnessConfigService pattern). Maps the same env vars the
 * application configuration maps (src/config/configuration.ts `broker.*`).
 */
class LiveHarnessConfigService {
  get(key: string, defaultValue?: string): string | undefined {
    if (key === 'broker.ctraderClientId') return process.env.CTRADER_CLIENT_ID ?? defaultValue;
    if (key === 'broker.ctraderClientSecret') {
      return process.env.CTRADER_CLIENT_SECRET ?? defaultValue;
    }
    return defaultValue;
  }
}

/** Read-only view that answers ONLY 'METAAPI_TOKEN' (the key the client reads). */
class StaticTokenConfigService {
  constructor(private readonly metaApiToken: string) {}
  get(key: string, defaultValue?: string): string | undefined {
    if (key === 'METAAPI_TOKEN') return this.metaApiToken;
    return defaultValue;
  }
}
