/**
 * Reconciliation enums — Sprint 50 PR-4 (Directive PHASE G + §25).
 *
 * The discrepancy taxonomy is EXACTLY the directive's list — every category
 * the directive names must be detectable and persisted:
 *
 *   missing internal order / unknown provider order / missing provider order /
 *   unknown provider position / stale order state / position closed
 *   externally / duplicate provider ID / unresolved execution result /
 *   account-state mismatch
 */

/** Discrepancy type — one entry per directive §25 detection category. */
export enum ReconciliationDiscrepancyType {
  /** Provider has an order/position that internal state has NO record of. */
  MISSING_INTERNAL_ORDER = 'MISSING_INTERNAL_ORDER',
  /** Provider data references an order we cannot correlate to anything. */
  UNKNOWN_PROVIDER_ORDER = 'UNKNOWN_PROVIDER_ORDER',
  /** Internal non-terminal order the provider reports nothing about. */
  MISSING_PROVIDER_ORDER = 'MISSING_PROVIDER_ORDER',
  /** Provider open position with no matching internal position record. */
  UNKNOWN_PROVIDER_POSITION = 'UNKNOWN_PROVIDER_POSITION',
  /** Internal order state lags the provider-reported order state. */
  STALE_ORDER_STATE = 'STALE_ORDER_STATE',
  /** Internal position OPEN but the provider no longer holds it. */
  POSITION_CLOSED_EXTERNALLY = 'POSITION_CLOSED_EXTERNALLY',
  /** More than one internal record claims the same provider identifier. */
  DUPLICATE_PROVIDER_ID = 'DUPLICATE_PROVIDER_ID',
  /** RECONCILIATION_PENDING record that could not be resolved. */
  UNRESOLVED_EXECUTION_RESULT = 'UNRESOLVED_EXECUTION_RESULT',
  /** Internal account snapshot diverges from the provider's account info. */
  ACCOUNT_STATE_MISMATCH = 'ACCOUNT_STATE_MISMATCH',
}

/** All directive §25 categories — used for exhaustiveness assertions. */
export const RECONCILIATION_DISCREPANCY_TYPES: readonly ReconciliationDiscrepancyType[] =
  Object.freeze([
    ReconciliationDiscrepancyType.MISSING_INTERNAL_ORDER,
    ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_ORDER,
    ReconciliationDiscrepancyType.MISSING_PROVIDER_ORDER,
    ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION,
    ReconciliationDiscrepancyType.STALE_ORDER_STATE,
    ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY,
    ReconciliationDiscrepancyType.DUPLICATE_PROVIDER_ID,
    ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT,
    ReconciliationDiscrepancyType.ACCOUNT_STATE_MISMATCH,
  ]);

export enum ReconciliationDiscrepancySeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

export enum ReconciliationDiscrepancyStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

/** Which internal aggregate a discrepancy refers to. */
export enum ReconciliationRefType {
  ORDER = 'ORDER',
  TRADE = 'TRADE',
  ACCOUNT = 'ACCOUNT',
}

export enum ReconciliationRunStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  /** Run finished but discrepancies remain OPEN (surfaced, awaiting action). */
  COMPLETED_WITH_WARNINGS = 'COMPLETED_WITH_WARNINGS',
  FAILED = 'FAILED',
}
