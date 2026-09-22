'use client';

/**
 * ClosePositionButton — per-position manual close affordance
 * (October UAT hardening, WS1-WEB).
 *
 * Behaviour:
 * - OPEN positions render a small danger "Close Position" button; clicking it
 *   asks the shared page controller for confirmation (exactly one
 *   ConfirmDialog is open at any time, owned by the target position).
 * - RECONCILIATION_PENDING positions never render an active close control:
 *   the server owns that state, so a muted note explains the close is
 *   unavailable while the state is being reconciled (fail-closed UX).
 * - While a close request for THIS position is in flight, the button is
 *   disabled with a loading state — every close button for the same position
 *   disables via the controller's shared pending set (no duplicate clicks).
 * - The confirmation dialog names the exact symbol, direction and lot size
 *   and warns that only this position closes; other open positions and AI
 *   Trading are not affected. Start/Stop AI Trading semantics are untouched.
 */

import type { LivePositionRowView } from '@irexpro/types/live-account';
import { ConfirmDialog } from '@/components/notifications/ConfirmDialog';
import { Button } from '@/components/ui';
import {
  manualCloseConfirmationDescription,
  manualCloseTargetForPosition,
} from '@/lib/manual-position-close';
import type { ManualPositionCloseController } from '@/lib/manual-position-close';

/** The position fields the close affordance needs (structural, fixture-friendly). */
export type ClosePositionSubject = Pick<
  LivePositionRowView,
  'id' | 'instrument' | 'direction' | 'lotSize' | 'status'
>;

export interface ClosePositionButtonProps {
  position: ClosePositionSubject;
  controller: ManualPositionCloseController;
}

export function ClosePositionButton({ position, controller }: ClosePositionButtonProps) {
  const target = manualCloseTargetForPosition(position);
  const pending = controller.isClosePending(position.id);
  const isConfirmTarget = controller.confirmTarget?.tradeId === position.id;

  // Reconciliation-owned positions never offer an active close: the server
  // must resolve the position state first.
  if (position.status === 'RECONCILIATION_PENDING') {
    return (
      <p className="close-position-note">
        Close unavailable — state being reconciled
      </p>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="danger"
        size="sm"
        loading={pending}
        disabled={pending}
        aria-label={`Close ${position.direction} ${position.instrument} position (${position.lotSize} lot)`}
        onClick={() => controller.requestClose(target)}
      >
        {pending ? 'Closing…' : 'Close Position'}
      </Button>
      <ConfirmDialog
        open={isConfirmTarget}
        title="Close this position?"
        description={manualCloseConfirmationDescription(target)}
        confirmLabel={pending ? 'Closing…' : 'Close Position'}
        cancelLabel="Keep Position Open"
        tone="danger"
        onConfirm={() => void controller.confirmClose()}
        onCancel={() => {
          if (!pending) controller.cancelClose();
        }}
      />
    </>
  );
}
