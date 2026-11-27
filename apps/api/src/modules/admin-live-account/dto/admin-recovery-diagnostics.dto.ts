import type { ReconciliationRun } from '../../execution/reconciliation/entities/reconciliation-run.entity';

const OUTCOMES = [
  'COMPETING_CLOSE_ORDERS',
  'TERMINAL_TRADE_OR_TIME_UNAVAILABLE',
  'POSITION_STILL_OPEN',
  'SCOPE_OR_TERMINAL_TRADE_UNVERIFIED',
  'TIME_PROVENANCE_UNVERIFIED',
  'CLOSE_DISPATCH_TIME_UNPROVEN',
  'PROVIDER_POSITION_ID_UNPROVEN',
  'CLOSE_ORDER_ECONOMICS_UNPROVEN',
  'CLOSE_REQUEST_QUANTITY_INVALID',
  'CLOSE_FILLED_QUANTITY_INVALID',
  'CLOSE_TRADE_LOT_SIZE_INVALID',
  'CLOSE_TRADE_EXIT_PRICE_INVALID',
  'CLOSE_TRADE_GROSS_PNL_INVALID',
  'CLOSE_REQUEST_QUANTITY_NONPOSITIVE',
  'CLOSE_FILL_ALREADY_RECORDED',
  'CLOSE_AVERAGE_FILL_PRICE_PRESENT',
  'CLOSE_QUANTITY_LOT_MISMATCH',
  'CLOSE_TRADE_EXIT_PRICE_NONPOSITIVE',
  'PROVIDER_DEAL_NOT_UNIQUE',
  'EXACT_BROKER_CLOSE_DEAL_ECONOMICS_MISMATCH',
  'FILLED_WITH_PROOF',
  'RECOVERY_ERROR',
  'RECOVERY_TRADE_LOOKUP_ERROR',
  'RECOVERY_POSITION_EVIDENCE_ERROR',
  'RECOVERY_PROVIDER_HISTORY_ERROR',
  'RECOVERY_SETTLEMENT_BACKFILL_ERROR',
  'RECOVERY_PROOF_EVALUATION_ERROR',
  'RECOVERY_FILL_ACCOUNTING_ERROR',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function scope(value: unknown) {
  const data = record(value);
  const outcomes = record(data?.outcomes);
  if (!data || !count(data.selected) || !outcomes) return null;
  const safe: Record<string, number> = {};
  let total = 0;
  for (const key of OUTCOMES) {
    if (!Object.prototype.hasOwnProperty.call(outcomes, key)) continue;
    const n = outcomes[key];
    if (!count(n)) return null;
    safe[key] = n;
    total += n;
  }
  if (Object.keys(outcomes).length !== Object.keys(safe).length || total !== data.selected) {
    return null;
  }
  return { selected: data.selected, outcomes: safe };
}

/** Project only allowlisted diagnostic counts, never arbitrary run metadata. */
export function toAdminRecoveryDiagnostics(run: ReconciliationRun | undefined) {
  if (!run) return null;
  const data = record(run.metadata?.demoCloseRecovery);
  const recent = scope(data?.recent);
  const aged = scope(data?.aged);
  return {
    status: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    diagnostics: recent && aged ? { recent, aged } : null,
  };
}
