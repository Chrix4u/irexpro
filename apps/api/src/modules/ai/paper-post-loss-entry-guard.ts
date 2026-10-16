export const PAPER_POST_LOSS_ENTRY_GUARD_ARTIFACT = 'paper-post-loss-confirmation-v1';
const CLOSED_M5_BAR_MS = 5 * 60_000;
export const PAPER_POST_LOSS_MULTI_EVIDENCE_MIN_NET_R = 0.12;

export interface PaperPostLossEntryState {
  available: boolean;
  lastClosedTrade: {
    id: string;
    closeReason: string | null;
    closedAt: Date | null;
    reconfirmed: boolean;
  } | null;
}
export type PaperPostLossEntryReason =
  | 'NO_PREVIOUS_CLOSE'
  | 'LAST_CLOSE_NOT_STOP_LOSS'
  | 'HISTORY_UNAVAILABLE'
  | 'INVALID_MARKET_EVIDENCE'
  | 'INVALID_CLOSE_EVIDENCE'
  | 'WAITING_FOR_POST_LOSS_BAR'
  | 'DIRECTION_NOT_RECONFIRMED'
  | 'DIRECTION_RECONFIRMED'
  | 'MULTI_EVIDENCE_RECONFIRMED'
  | 'DIRECTION_ALREADY_RECONFIRMED';
export interface PaperPostLossEntryDecision {
  artifact: typeof PAPER_POST_LOSS_ENTRY_GUARD_ARTIFACT;
  eligible: boolean;
  reason: PaperPostLossEntryReason;
  lastClosedTradeId: string | null;
  lastClosedAt: string | null;
}

/** A stopped-out setup must obtain a wholly post-loss closed bar and renewed direction.
 * An executed confirmation releases the condition durably until another stop-loss.
 * This imposes no fixed cooldown, trade count, or open-position cap.
 */
export function evaluatePaperPostLossEntryGuard(input: {
  state: PaperPostLossEntryState;
  marketBarOpenedAt: Date;
  evaluatedAt: Date;
  /** Direction-aligned momentum, positive for renewed support on either side. */
  alignedMomentumAtr: number;
  /** Existing authoritative post-cost edge before adding this guard's blocker. */
  netExpectedR?: number;
  driftState?: string;
  consensusPassed?: number;
  consensusRequired?: number;
  eventRisk?: string;
  executionCostUsable?: boolean;
}): PaperPostLossEntryDecision {
  const previous = input.state.lastClosedTrade;
  const closedAtMs = previous?.closedAt?.getTime() ?? Number.NaN;
  const decision = (
    eligible: boolean,
    reason: PaperPostLossEntryReason,
  ): PaperPostLossEntryDecision => ({
    artifact: PAPER_POST_LOSS_ENTRY_GUARD_ARTIFACT,
    eligible,
    reason,
    lastClosedTradeId: previous?.id ?? null,
    lastClosedAt: Number.isFinite(closedAtMs) ? new Date(closedAtMs).toISOString() : null,
  });
  const barMs = input.marketBarOpenedAt.getTime();
  const evaluatedMs = input.evaluatedAt.getTime();
  if (
    !Number.isFinite(barMs) ||
    !Number.isFinite(evaluatedMs) ||
    barMs + CLOSED_M5_BAR_MS > evaluatedMs ||
    !Number.isFinite(input.alignedMomentumAtr)
  ) {
    return decision(false, 'INVALID_MARKET_EVIDENCE');
  }
  if (!input.state.available) return decision(false, 'HISTORY_UNAVAILABLE');
  if (!previous) return decision(true, 'NO_PREVIOUS_CLOSE');
  if (
    !previous.id ||
    !previous.closeReason ||
    !Number.isFinite(closedAtMs) ||
    closedAtMs > evaluatedMs
  ) {
    return decision(false, 'INVALID_CLOSE_EVIDENCE');
  }
  if (previous.closeReason !== 'STOP_LOSS_HIT' && previous.closeReason !== 'SL') {
    return decision(true, 'LAST_CLOSE_NOT_STOP_LOSS');
  }
  if (barMs < closedAtMs) return decision(false, 'WAITING_FOR_POST_LOSS_BAR');
  if (previous.reconfirmed) return decision(true, 'DIRECTION_ALREADY_RECONFIRMED');
  if (input.alignedMomentumAtr > 0) return decision(true, 'DIRECTION_RECONFIRMED');

  const netExpectedR = Number(input.netExpectedR);
  const consensusPassed = Number(input.consensusPassed);
  const consensusRequired = Number(input.consensusRequired);
  const multiEvidenceReconfirmed =
    Number.isFinite(netExpectedR) &&
    netExpectedR >= PAPER_POST_LOSS_MULTI_EVIDENCE_MIN_NET_R &&
    input.driftState === 'NORMAL' &&
    Number.isFinite(consensusPassed) &&
    Number.isFinite(consensusRequired) &&
    consensusRequired > 0 &&
    consensusPassed >= consensusRequired &&
    input.eventRisk === 'CLEAR' &&
    input.executionCostUsable === true;
  if (multiEvidenceReconfirmed) return decision(true, 'MULTI_EVIDENCE_RECONFIRMED');
  return decision(false, 'DIRECTION_NOT_RECONFIRMED');
}
