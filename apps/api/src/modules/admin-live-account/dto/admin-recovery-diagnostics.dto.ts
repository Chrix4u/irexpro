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
  'PROVIDER_DEAL_NOT_UNIQUE',
  'EXACT_BROKER_CLOSE_DEAL_ECONOMICS_MISMATCH',
  'FILLED_WITH_PROOF',
  'RECOVERY_ERROR',
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
