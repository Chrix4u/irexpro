/**
 * Round 6 live-execution completion (§10) — the AI EXIT decision contract.
 *
 * An exit signal is the AI engine's decision to REDUCE RISK: close one open
 * position (by tradeId) or every open position on an instrument. Exits are
 * risk-REDUCING operations:
 *   - they do NOT pass the Risk Engine's NEW-exposure pipeline (no grant, no
 *     sizing, no allocation — there is nothing to approve: closing never
 *     increases exposure);
 *   - they are NOT blocked by emergency execution controls (the close path's
 *     CLOSE_POSITION operation class is deliberately control-exempt);
 *   - they are NOT gated by the §5/§18 market-safety gate (NEW-EXPOSURE PLACE
 *     only — de-risking must remain possible during market anomalies).
 *
 * Every other guarantee of the entry pipeline applies with the same strength:
 * signal identity (exactly-once per (userId, signalId) — the FIRST
 * delivery's durable outcome is the truth), generatedAt freshness, session
 * binding, full audit, and §10 SERIALIZATION: exits for one user process
 * strictly one-at-a-time inside the orchestrator.
 */
export interface AiExitSignal {
  /** Unique exit-decision id (UUID, provided by the AI service). */
  signalId: string;

  /** Target user. */
  userId: string;

  /** The trading session this exit decision belongs to. */
  tradingSessionId: string;

  /** Instrument to exit (required even when tradeId targets one position). */
  instrument: string;

  /**
   * Optional: close exactly this trade. When omitted, EVERY open position on
   * the instrument for this user is closed (flatten-instrument).
   */
  tradeId?: string | null;

  /** Decision timestamp — freshness is enforced (stale/future rejected). */
  generatedAt: Date | string;

  /** Model confidence score (0–1) — same threshold as entry signals. */
  confidenceScore: number;

  /** Strategy provenance (audit + identity digest material). */
  strategyCode?: string | null;

  /** Model provenance (audit + identity digest material). */
  modelVersion?: string | null;

  /** Free-text rationale (audit only — never parsed for control flow). */
  rationale?: string | null;
}

/** Stable §26-style machine outcomes for the exit pipeline. */
export type AiExitOutcome =
  | 'EXIT_INVALID'
  | 'LOW_CONFIDENCE'
  | 'SESSION_INACTIVE'
  | 'SIGNAL_IDENTITY_REJECTED'
  | 'DUPLICATE_RECOVERED'
  | 'EXIT_TARGET_NOT_FOUND'
  | 'NO_OPEN_POSITION'
  | 'EXIT_SUCCEEDED'
  | 'EXIT_PARTIAL'
  | 'EXIT_FAILED';

export interface AiExitTradeResult {
  tradeId: string;
  closed: boolean;
  /** Machine reason for a non-closed target (typed, stable). */
  reason?: string;
}

export interface AiExitResult {
  outcome: AiExitOutcome;
  signalId: string;
  /** Per-target close results (empty for pre-target failures). */
  trades: AiExitTradeResult[];
  reason?: string;
  /** Present on DUPLICATE_RECOVERED — the durable outcome of the FIRST delivery. */
  recoveredAs?: AiExitOutcome;
}
