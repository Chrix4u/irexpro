/**
 * Execution Authority domain — shared contract for the Round-5
 * NEW-EXPOSURE EXECUTION AUTHORITY chain (architect issues #295/#298/#299/
 * #300/#301/#302/#312/#361).
 *
 * The immutable chain is:
 *
 *   Signal → exact TradingSession → executionMode → exact
 *   brokerConnectionId → user/KYC/jurisdiction authority → provider
 *   identity/LIVE verification → fresh versioned account snapshot →
 *   exact-decimal risk evaluation → immutable expiring RiskGrant →
 *   final authority recheck → provider dispatch → reconciliation.
 *
 * NO stage may rediscover or substitute "the latest active
 * BrokerConnection". The exact connection is chosen at session start and
 * bound through sessionId + sessionGeneration + brokerConnectionId.
 */

/** Durable execution modes for a TradingSession (issue #298). */
export enum ExecutionMode {
  /** NEW exposure routes exclusively to the paper/simulator path. */
  PAPER_ONLY = 'PAPER_ONLY',
  /** Every NEW exposure requires an explicit server-verifiable user
   *  confirmation bound to the exact order (one-time use). */
  SEMI_AUTO = 'SEMI_AUTO',
  /** Automatic NEW exposure permitted only while ALL current authority
   *  conditions hold at the final dispatch boundary. */
  FULL_AUTO = 'FULL_AUTO',
}

/** RiskGrant lifecycle (issue #301). */
export enum RiskGrantStatus {
  ACTIVE = 'ACTIVE',
  CONSUMED = 'CONSUMED',
  EXPIRED = 'EXPIRED',
  INVALIDATED = 'INVALIDATED',
}

/** SEMI_AUTO one-time confirmation lifecycle (issue #298). */
export enum ExecutionConfirmationStatus {
  PENDING = 'PENDING',
  CONSUMED = 'CONSUMED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

/** Durable signal-identity lifecycle (issue #302). */
export enum AiSignalIdentityStatus {
  RECEIVED = 'RECEIVED',
  PROCESSED = 'PROCESSED',
}

/** How the final dispatch boundary classifies provider operations. */
export enum ProviderOperationClass {
  NEW_EXPOSURE = 'NEW_EXPOSURE',
  INCREASE_EXPOSURE = 'INCREASE_EXPOSURE',
  REDUCE_EXPOSURE = 'REDUCE_EXPOSURE',
  CLOSE_POSITION = 'CLOSE_POSITION',
  CANCEL_PENDING = 'CANCEL_PENDING',
  RECONCILE_READ = 'RECONCILE_READ',
  RISK_REDUCING_MODIFY = 'RISK_REDUCING_MODIFY',
  RISK_INCREASING_MODIFY = 'RISK_INCREASING_MODIFY',
}

/** Material order fields covered by the order-payload digest. */
export interface AuthoritativeOrderPayload {
  instrument: string;
  direction: string;
  quantity: string;
  orderType: string;
  requestedPrice?: string | null;
  stopLoss?: string | null;
  takeProfit?: string | null;
  marketRegime?: string | null;
}

/**
 * One immutable routing/authority context flowing Strategy → Risk →
 * Execution → Provider (architect section 22). Built once from the exact
 * TradingSession + connection + authority state; never re-discovered.
 */
export interface ExecutionAuthorityContext {
  userId: string;
  signalId: string;
  operationType: ProviderOperationClass;
  sessionId: string;
  sessionGeneration: number;
  executionMode: ExecutionMode;
  /** EXACT connection chosen at session start — never substituted. */
  brokerConnectionId: string;
  brokerAccountId: string | null;
  providerTechnology: string;
  /** Server-derived persisted provider identity (fail-closed when NULL for LIVE). */
  providerBrokerIdentity: string | null;
  providerVerificationFingerprint: string | null;
  financialSnapshotGeneration: number | null;
  riskProfileId: string | null;
  riskProfileVersion: number | null;
  riskGrantId: string | null;
  authorityGeneration: number;
  validatedOrderDigest: string | null;
}

/**
 * Canonical JSON canonicalization for digests — stable key order, no
 * whitespace. Used for signal payload digests and order payload digests so
 * that "same material payload" is byte-identical everywhere.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return `"${value.toString()}"`;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type: ${typeof value}`);
}

/** SHA-256 hex digest (64 chars) of the canonical JSON of a payload. */
export async function digestCanonicalPayload(payload: unknown): Promise<string> {
  const canonical = canonicalJson(payload);
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Normalize a quantity/price string for digest stability (ExactDecimal canonical). */
export function normalizeDecimalStringForDigest(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  // strip trailing fractional zeros and trailing dot ("1.500" -> "1.5", "2.0" -> "2")
  const normalized = trimmed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return normalized === '-0' ? '0' : normalized;
}
