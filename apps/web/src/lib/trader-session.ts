import type {
  BrokerConnectionView,
  BrokerRegistryEntry,
  LiveReadinessBlockedReason,
} from '@irexpro/types';
import type {
  ExecutionConfirmationFailure,
  ExecutionConfirmationView,
  TradingSessionView,
} from '@irexpro/types/execution';
import {
  describeExecutionConfirmationFailure,
  EXECUTION_MODES,
  type ExecutionMode,
} from '@irexpro/types/execution';
import { assessProviderVerification } from '@irexpro/types/provider-verification';
import { deriveProviderCertificationState } from '@irexpro/types';
import { ApiClientError } from '@irexpro/api-client';
import { api } from '@/lib/api';

/**
 * Sprint 56 correction round 5 (issues #292/#293/#298) — execution authority
 * UI logic for the trading workspace.
 *
 * Truthfulness rules enforced here:
 * - The session executionMode/status/authorityGeneration ARE the current
 *   trading state; `liveTradingEnabled` is only a compatibility mirror.
 * - SEMI_AUTO confirmations are listed from the SERVER and confirmed via the
 *   server endpoint. The ONLY success state rendered is the server-consumed
 *   `{ status: 'CONSUMED' }` result; every rejection is the server's typed
 *   failure (expired / consumed / revoked / mismatched-generation).
 * - "Execution blocked" reasons are derived from server-reported state only
 *   (session status, risk gate, kill switch, broker connectivity, and the
 *   server-computed executable gate) — never re-derived from authorization
 *   taxonomy in the browser.
 */

// ── Session authority actions ───────────────────────────────────────────────

/** Available selector values (shared contract constant, re-exported for UI). */
export { EXECUTION_MODES };
export type { ExecutionMode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === 'PAPER_ONLY' || value === 'SEMI_AUTO' || value === 'FULL_AUTO';
}

function isTradingSessionStatus(value: unknown): value is TradingSessionView['status'] {
  return (
    value === 'ACTIVE' ||
    value === 'PAUSED' ||
    value === 'SUSPENDED_RISK_LIMIT' ||
    value === 'SUSPENDED_BROKER' ||
    value === 'ENDED'
  );
}

function isTradingSession(value: unknown): value is TradingSessionView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.brokerConnectionId === 'string' &&
    isExecutionMode(value.executionMode) &&
    typeof value.authorityGeneration === 'number' &&
    Number.isInteger(value.authorityGeneration) &&
    value.authorityGeneration >= 1 &&
    isTradingSessionStatus(value.status) &&
    // Display-only financial snapshot fields: null, absent (older payloads
    // omit them), or a decimal string — never any other type.
    typeof value.startedAt === 'string'
  );
}

/**
 * The API returns the session DTO directly (bare object, no envelope) —
 * guard it as the session view itself.
 */
function isSessionPayload(value: unknown): value is TradingSessionView {
  return isTradingSession(value);
}

/**
 * POST /trading/sessions/:id/mode — audited execution-mode change. The
 * RETURNED session (bumped authorityGeneration included) becomes the
 * displayed state; the UI never optimistically re-labels the mode.
 */
export async function changeSessionExecutionMode(
  sessionId: string,
  executionMode: ExecutionMode,
): Promise<TradingSessionView> {
  const payload = await api.changeTradingSessionMode(sessionId, { executionMode });
  if (!isSessionPayload(payload)) {
    throw new Error('Trading session mode-change contract mismatch');
  }
  return payload;
}

/**
 * POST /trading/sessions/start — start a session bound to the exact
 * brokerConnectionId + executionMode (server-validated fail-closed).
 */
export async function startTradingSessionForConnection(
  brokerConnectionId: string,
  executionMode: ExecutionMode,
): Promise<TradingSessionView> {
  const payload = await api.startTradingSession({ brokerConnectionId, executionMode });
  if (!isSessionPayload(payload)) {
    throw new Error('Trading session start contract mismatch');
  }
  return payload;
}

// ── SEMI_AUTO confirmation inbox ────────────────────────────────────────────

function isDirection(value: unknown): value is ExecutionConfirmationView['direction'] {
  return value === 'BUY' || value === 'SELL';
}

function isExecutionConfirmation(value: unknown): value is ExecutionConfirmationView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.signalId === 'string' &&
    typeof value.instrument === 'string' &&
    isDirection(value.direction) &&
    typeof value.quantity === 'string' &&
    (value.stopLoss === null || typeof value.stopLoss === 'string') &&
    (value.takeProfit === null || typeof value.takeProfit === 'string') &&
    typeof value.expiresAt === 'string' &&
    !Number.isNaN(new Date(value.expiresAt).getTime()) &&
    typeof value.orderPayloadDigest === 'string'
  );
}

/** GET /execution/confirmations/pending — server-queued confirmations only. */
export async function loadPendingExecutionConfirmations(): Promise<
  ExecutionConfirmationView[]
> {
  const payload = await api.listPendingExecutionConfirmations();
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.confirmations) ||
    !payload.confirmations.every(isExecutionConfirmation)
  ) {
    throw new Error('Pending execution confirmations contract mismatch');
  }
  return payload.confirmations;
}

/** Result of one confirm attempt: either the server CONSUMED result or the typed server failure. */
export type ConfirmConfirmationResult =
  | { outcome: 'CONSUMED' }
  | { outcome: 'FAILED'; failure: ExecutionConfirmationFailure };

/**
 * POST /execution/confirmations/:id/confirm — relay the user's explicit
 * confirm to the server. NEVER resolves to a locally-fabricated approval:
 * only the server's `{ status: 'CONSUMED' }` counts as consumed, and every
 * rejection is classified from the server's error surface.
 */
export async function confirmPendingConfirmation(
  confirmationId: string,
): Promise<ConfirmConfirmationResult> {
  try {
    const payload = await api.confirmExecutionConfirmation(confirmationId);
    if (isRecord(payload) && payload.status === 'CONSUMED') {
      return { outcome: 'CONSUMED' };
    }
    // 200 with an unexpected body is a contract violation — fail closed as a
    // server rejection; it is never treated as approval.
    return {
      outcome: 'FAILED',
      failure: {
        kind: 'unknown',
        message: 'The server response did not confirm consumption.',
      },
    };
  } catch (err) {
    if (err instanceof ApiClientError) {
      const raw = err.raw as { message?: string; code?: string } | null;
      return {
        outcome: 'FAILED',
        failure: describeExecutionConfirmationFailure({
          statusCode: err.statusCode,
          message: err.message,
          code: raw?.code,
        }),
      };
    }
    return {
      outcome: 'FAILED',
      failure: describeExecutionConfirmationFailure({
        message: err instanceof Error ? err.message : undefined,
      }),
    };
  }
}

/** `mm:ss` remaining until expiry ('Expired' once past — server still rejects). */
export function formatExpiryCountdown(
  expiresAt: string,
  now: Date = new Date(),
): string {
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return 'Unavailable';
  const remainingMs = expiry.getTime() - now.getTime();
  if (remainingMs <= 0) return 'Expired';
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ── Execution-blocked reasons (server-state fed, never guessed) ─────────────

/** Server-reported facts the blocked-reason area is allowed to consume. */
export interface ExecutionAuthorityFacts {
  session: TradingSessionView | null;
  killSwitchActive: boolean;
  canTrade: boolean;
  brokerConnected: boolean;
  /** Authorization status is display taxonomy only; it is not reinterpreted as execution authority. */
  sessionAuthorizationStatus: BrokerConnectionView['authorizationStatus'] | null;
  /** Server-computed fail-closed executable gate for that connection (null if unknown). */
  sessionConnectionExecutable: boolean | null;
}

/**
 * Derive the "execution blocked" reasons from server-reported state.
 * Empty array ⇒ nothing server-reported is blocking right now. The browser
 * deliberately does NOT infer executability from authorizationStatus because
 * authorization taxonomy is broker-specific (for example, the built-in
 * paper simulator is executable while AUTHORIZED). The server executable gate
 * is the sole connection-level authority here.
 */
export function executionBlockedReasons(facts: ExecutionAuthorityFacts): string[] {
  const reasons: string[] = [];

  if (facts.killSwitchActive) {
    reasons.push('Kill switch engaged — the risk engine halted trading server-side.');
  }
  if (!facts.canTrade) {
    reasons.push('Risk gate blocked — the server reports trading is not permitted.');
  }
  if (!facts.brokerConnected) {
    reasons.push('No broker connection is currently reported by the server.');
  }

  if (!facts.session) {
    reasons.push('No active trading session — execution authority is not started.');
    return reasons;
  }

  if (facts.session.status === 'ENDED') {
    reasons.push('The trading session has ENDED.');
  } else if (facts.session.status === 'PAUSED') {
    reasons.push('The trading session is PAUSED.');
  } else if (facts.session.status === 'SUSPENDED_RISK_LIMIT') {
    reasons.push('The trading session is SUSPENDED by a risk limit.');
  } else if (facts.session.status === 'SUSPENDED_BROKER') {
    reasons.push('The trading session is SUSPENDED by the broker.');
  }

  if (facts.sessionConnectionExecutable === false) {
    reasons.push('The server reports this broker connection as not executable.');
  }

  return reasons;
}

// ── Truthful LIVE start gating (production-LIVE completion round) ───────────

/**
 * The four canonical human reason lines (identical wording to the onboarding
 * broker page so a user meets the SAME explanation everywhere LIVE is blocked).
 */
const LIVE_READINESS_REASON_LINES: Record<LiveReadinessBlockedReason, string> = {
  LIVE_UNSUPPORTED: 'This provider does not offer LIVE accounts',
  ADAPTER_UNAVAILABLE: 'Provider integration is not currently available',
  PARTNER_APPROVAL_REQUIRED: 'Partner approval required before LIVE is possible',
  CERTIFICATION_REQUIRED: 'LIVE requires a current provider certification',
};

/** Server-reported facts the LIVE start gate may consume. */
export interface LiveStartGateFacts {
  /** The connection the user would start automation on. */
  accountType: 'DEMO' | 'LIVE';
  /**
   * The registry entry for the selected connection's provider, or null when
   * the registry could not be loaded (degraded mode).
   */
  registryEntry: BrokerRegistryEntry | null;
}

/**
 * Truthful Start-button gating for LIVE accounts (audit P15): when the
 * selected connection is LIVE (and would therefore start FULL_AUTO) and the
 * server registry reports the provider as not production-LIVE ready, the
 * Start button must be disabled BEFORE click and the server's ordered
 * blockedReasons rendered as human lines — a user never discovers LIVE is
 * impossible only by clicking Start.
 *
 * DEGRADED MODE (registry unreachable / no matching entry): returns [] — the
 * button keeps its existing behavior because the server STILL enforces the
 * production-LIVE gate on POST /trading/sessions/start. This is a UI
 * truthfulness aid, never the enforcement point.
 *
 * Region availability is deliberately NOT gated here: it is user-scoped (the
 * user's country vs the provider's liveUnavailableRegions) and enforced
 * server-side at the LIVE gates with the user's profile in hand.
 */
export function liveStartBlockedReasons(facts: LiveStartGateFacts): string[] {
  // Paper/DEMO starts never take the production-LIVE path.
  if (facts.accountType !== 'LIVE') return [];
  // Degraded mode: no registry truth available client-side → existing
  // behavior (server still enforces).
  if (!facts.registryEntry) return [];

  const readiness = facts.registryEntry.liveReadiness;
  if (readiness) {
    if (readiness.eligible) return [];
    // Server-ordered blockers (resolution order) mapped to the canonical
    // human lines; an eligible=false entry with no reasons is still blocked —
    // never rendered as available.
    const lines = readiness.blockedReasons
      .map((reason) => LIVE_READINESS_REASON_LINES[reason])
      .filter((line): line is string => typeof line === 'string');
    return lines.length > 0 ? lines : ['LIVE is not currently available for this provider'];
  }

  // Older cached payloads without liveReadiness: fail-closed on the derived
  // certification state (LEGACY_VERIFIED never counts as a current protocol
  // certification — mirrors deriveProviderCertificationState semantics).
  const certificationState =
    facts.registryEntry.certificationState ??
    deriveProviderCertificationState(facts.registryEntry.productionLiveVerification);
  return certificationState === 'CERTIFIED'
    ? []
    : ['LIVE requires a current provider certification'];
}

// ── Provider verification label (fixed taxonomy) ────────────────────────────

/**
 * Connection facts the label assessment may consume (structural so both the
 * broker-connection view and the live-account connection view fit).
 */
export interface ConnectionVerificationFacts {
  accountType: 'DEMO' | 'LIVE';
  authorizationStatus?: BrokerConnectionView['authorizationStatus'] | null;
  executable?: boolean | null;
  providerBrokerIdentity?: string | null;
  logicalAccountKey?: string | null;
}

/**
 * Verification label for a broker connection card, from the EXACT six-label
 * taxonomy (`LIVE-capable` | `Production LIVE Verified` |
 * `Production LIVE Unverified` | `Ineligible` | `DEMO only` |
 * `execution disabled`). Facts come from the connection view joined with the
 * server registry entry; a missing registry entry degrades fail-closed
 * (never toward a "Live"-sounding claim).
 */
export function connectionVerificationLabel(
  connection: ConnectionVerificationFacts,
  registryEntry: BrokerRegistryEntry | null,
): ReturnType<typeof assessProviderVerification> {
  return assessProviderVerification({
    environments: registryEntry?.environments ?? null,
    implementationStatus: registryEntry?.status ?? null,
    adapterAvailable: registryEntry?.adapterAvailable ?? null,
    productionLiveVerification: registryEntry?.productionLiveVerification ?? null,
    // Production-LIVE completion round (Phase 2): the server-derived
    // certification state is authoritative — legacy attestation (MT5 today)
    // never renders as a current protocol certification.
    certificationState: registryEntry?.certificationState ?? null,
    accountType: connection.accountType,
    logicalAccountKey: connection.logicalAccountKey ?? null,
    authorizationStatus: connection.authorizationStatus ?? null,
    executable: connection.executable ?? null,
  });
}
