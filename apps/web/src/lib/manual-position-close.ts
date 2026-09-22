import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createExecutionApi } from '@irexpro/api-client/execution';
import { isManualCloseOutcome } from '@irexpro/types/execution';
import type {
  ManualPositionCloseOutcome,
  ManualPositionCloseResponseView,
} from '@irexpro/types/execution';
import type { LivePositionRowView } from '@irexpro/types/live-account';
import { api } from '@/lib/api';
import { mapApiError } from '@/lib/error-mapping';
import { isTradeExecutionView } from '@/lib/trader-execution';

/**
 * Manual single-position close (October UAT hardening, WS1-WEB).
 *
 * The user-facing close of ONE open position. The request routes through the
 * server-side execution domain via the shared api client
 * (POST /execution/positions/:tradeId/close) — the browser NEVER calls a
 * provider directly and never fabricates a close result:
 * - the response shape is runtime-validated fail-closed (a contract mismatch
 *   throws, mirroring trader-execution.ts / live-account.ts);
 * - every one of the five honest outcomes maps to an explicit toast kind and
 *   label — an unknown outcome fails closed instead of rendering a success;
 * - the confirmation copy names the exact position and states the blast
 *   radius: one position only, other positions and AI Trading untouched.
 *
 * Start/Stop AI Trading semantics are NOT touched here: Stop still closes all
 * AI-owned positions after its own confirmation (see the trade page).
 */

const executionApi = createExecutionApi(api);

// ── Runtime contract validation (fail-closed) ───────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Runtime guard for the manual-close response view. `position` is either null
 * or a fully valid TradeExecutionView (reusing the shared fail-closed guard);
 * a partial or over-broad position object is a contract mismatch.
 */
export function isManualPositionCloseResponseView(
  value: unknown,
): value is ManualPositionCloseResponseView {
  if (!isRecord(value)) return false;
  return (
    isManualCloseOutcome(value.outcome) &&
    typeof value.message === 'string' &&
    (value.position === null || isTradeExecutionView(value.position)) &&
    isNullableString(value.providerErrorClass)
  );
}

/**
 * Close ONE open position and return the validated honest outcome.
 * Throws 'Manual position close contract mismatch' on any shape drift — the
 * caller then shows the mapped error, never an invented close result.
 */
export async function closeManualPosition(
  tradeId: string,
): Promise<ManualPositionCloseResponseView> {
  const payload: unknown = await executionApi.closePosition(tradeId);
  if (!isManualPositionCloseResponseView(payload)) {
    throw new Error('Manual position close contract mismatch');
  }
  return payload;
}

// ── Honest outcome presentation (typed, never fabricated) ───────────────────

export type ManualCloseToastKind = 'success' | 'info' | 'warning' | 'error';

export interface ManualCloseOutcomePresentation {
  /** Which notify.* channel the outcome must use. */
  kind: ManualCloseToastKind;
  /** Short honest title naming the outcome (never just "Done"). */
  title: string;
  /** The server-provided message, rendered verbatim (never invented). */
  message: string;
}

/**
 * Compile-time-exhaustive, runtime-fail-closed outcome table. Adding a new
 * outcome to the union breaks this Record until a presentation is defined.
 */
const MANUAL_CLOSE_OUTCOME_PRESENTATIONS: Record<
  ManualPositionCloseOutcome,
  { kind: ManualCloseToastKind; title: string }
> = {
  CLOSED: { kind: 'success', title: 'Position closed' },
  ALREADY_CLOSED: { kind: 'info', title: 'Already closed' },
  CLOSE_IN_PROGRESS: { kind: 'info', title: 'Close already in flight' },
  RECONCILIATION_REQUIRED: {
    kind: 'warning',
    title: 'Provider confirmation pending — reconciliation will resolve the final state',
  },
  PROVIDER_REFUSED: { kind: 'error', title: 'Close failed' },
};

/**
 * Map one manual-close outcome onto its toast presentation.
 * Pure; fails closed (throws) on an unknown outcome value — the UI never
 * renders an unmapped outcome as a success.
 */
export function describeManualCloseOutcome(
  outcome: ManualPositionCloseOutcome,
  serverMessage: string,
): ManualCloseOutcomePresentation {
  if (!isManualCloseOutcome(outcome)) {
    throw new Error(`Unknown manual close outcome: ${String(outcome)}`);
  }
  const presentation = MANUAL_CLOSE_OUTCOME_PRESENTATIONS[outcome];
  return { kind: presentation.kind, title: presentation.title, message: serverMessage };
}

/** Compose the single toast line: honest title + the server's own message. */
export function manualCloseToastText(presentation: ManualCloseOutcomePresentation): string {
  return presentation.message
    ? `${presentation.title}. ${presentation.message}`
    : presentation.title;
}

// ── Confirmation copy ───────────────────────────────────────────────────────

/** The exact position a manual close targets (built from a position row). */
export interface ManualPositionCloseTarget {
  tradeId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;
}

/** Project the frontend-safe position row onto the close target. */
export function manualCloseTargetForPosition(
  position: Pick<LivePositionRowView, 'id' | 'instrument' | 'direction' | 'lotSize'>,
): ManualPositionCloseTarget {
  return {
    tradeId: position.id,
    instrument: position.instrument,
    direction: position.direction,
    lotSize: position.lotSize,
  };
}

/**
 * Confirmation-modal copy: names the exact symbol, direction and lot size,
 * and states the blast radius explicitly — only THIS position closes; other
 * open positions and AI Trading are not affected.
 */
export function manualCloseConfirmationDescription(target: ManualPositionCloseTarget): string {
  return (
    `Close the ${target.direction} ${target.instrument} position (${target.lotSize} lot) now? ` +
    'This closes only this position. Other open positions and AI Trading are not affected.'
  );
}

// ── Shared per-page close controller (hook) ─────────────────────────────────

/** Structural subset of the notification hook the controller needs. */
export interface ManualCloseNotifier {
  success: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
}

export interface ManualPositionCloseController {
  /** Trade ids with a close request currently in flight. */
  pendingTradeIds: ReadonlySet<string>;
  /** True while a close request is in flight for the given trade id. */
  isClosePending(tradeId: string): boolean;
  /** The position awaiting explicit user confirmation, if any. */
  confirmTarget: ManualPositionCloseTarget | null;
  /** Ask for confirmation before closing the given position. */
  requestClose(target: ManualPositionCloseTarget): void;
  /** Dismiss the open confirmation without closing anything. */
  cancelClose(): void;
  /** Execute the confirmed close: request → honest toast → page refresh. */
  confirmClose(): Promise<void>;
}

/**
 * One close controller per page: shared pending-state across every position
 * card/tile, exactly one confirmation dialog at a time, honest outcome toasts
 * and an immediate refresh of the page's read models after ANY completed
 * attempt (including failures) so position state reconciles right away.
 *
 * Duplicate dispatch is prevented synchronously via an in-flight ref — React
 * state updates batch asynchronously, so the guard must not read the state
 * snapshot.
 */
export function useManualPositionClose(options: {
  notify: ManualCloseNotifier;
  onSettled: () => void | Promise<void>;
}): ManualPositionCloseController {
  const { notify } = options;

  const [pendingTradeIds, setPendingTradeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmTarget, setConfirmTarget] = useState<ManualPositionCloseTarget | null>(null);

  // Latest-ref for the page refresh callback: keeps the controller stable
  // across the page's own refresh-cycle identity churn.
  const onSettledRef = useRef(options.onSettled);
  useEffect(() => {
    onSettledRef.current = options.onSettled;
  }, [options.onSettled]);

  const inFlightRef = useRef<Set<string>>(new Set());

  const isClosePending = useCallback(
    (tradeId: string) => pendingTradeIds.has(tradeId),
    [pendingTradeIds],
  );

  const requestClose = useCallback((target: ManualPositionCloseTarget) => {
    setConfirmTarget(target);
  }, []);

  const cancelClose = useCallback(() => {
    setConfirmTarget(null);
  }, []);

  const confirmClose = useCallback(async () => {
    const target = confirmTarget;
    if (!target) return;
    if (inFlightRef.current.has(target.tradeId)) return;

    inFlightRef.current.add(target.tradeId);
    setPendingTradeIds((current) => new Set(current).add(target.tradeId));
    try {
      const response = await closeManualPosition(target.tradeId);
      const presentation = describeManualCloseOutcome(response.outcome, response.message);
      notify[presentation.kind](manualCloseToastText(presentation));
    } catch (closeError) {
      // Transport/HTTP failure (the typed outcomes above never throw): show
      // the safe mapped message — never a fabricated close result.
      notify.error(mapApiError(closeError).message);
    } finally {
      inFlightRef.current.delete(target.tradeId);
      setPendingTradeIds((current) => {
        const next = new Set(current);
        next.delete(target.tradeId);
        return next;
      });
      setConfirmTarget(null);
      // Reconcile the page's read models immediately after any completed
      // attempt. The page refresh reports its own failures — never surface a
      // second error toast from the same close attempt.
      try {
        await onSettledRef.current();
      } catch {
        // ignored: the owning page owns refresh-error reporting
      }
    }
  }, [confirmTarget, notify]);

  return useMemo(
    () => ({
      pendingTradeIds,
      isClosePending,
      confirmTarget,
      requestClose,
      cancelClose,
      confirmClose,
    }),
    [pendingTradeIds, isClosePending, confirmTarget, requestClose, cancelClose, confirmClose],
  );
}
