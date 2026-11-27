import type { ReconciliationRun } from '../../execution/reconciliation/entities/reconciliation-run.entity';
import { ReconciliationRunStatus } from '../../execution/reconciliation/reconciliation.enums';
import { toAdminRecoveryDiagnostics } from './admin-recovery-diagnostics.dto';

function run(metadata: Record<string, unknown> | null): ReconciliationRun {
  return {
    status: ReconciliationRunStatus.COMPLETED_WITH_WARNINGS,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: new Date('2026-01-01T00:00:01Z'),
    metadata,
  } as ReconciliationRun;
}

describe('admin recovery diagnostics projection', () => {
  const empty = { selected: 0, outcomes: {} };
  it('returns null for no run and unknown diagnostics for legacy runs', () => {
    expect(toAdminRecoveryDiagnostics(undefined)).toBeNull();
    expect(toAdminRecoveryDiagnostics(run(null))?.diagnostics).toBeNull();
  });

  it('exposes only validated counts, not arbitrary metadata', () => {
    const recent = { selected: 1, outcomes: { PROVIDER_DEAL_NOT_UNIQUE: 1 } };
    const output = toAdminRecoveryDiagnostics(
      run({ demoCloseRecovery: { recent, aged: empty }, privateValue: 'not-for-response' }),
    );
    expect(output?.diagnostics).toEqual({ recent, aged: empty });
    expect(JSON.stringify(output)).not.toContain('not-for-response');
  });

  it('reports historical stage errors without exposing provider messages', () => {
    const aged = {
      selected: 2,
      outcomes: { RECOVERY_PROVIDER_HISTORY_ERROR: 1, RECOVERY_FILL_ACCOUNTING_ERROR: 1 },
    };
    const output = toAdminRecoveryDiagnostics(run({ demoCloseRecovery: { recent: empty, aged } }));
    expect(output?.diagnostics).toEqual({ recent: empty, aged });
  });

  it.each([
    { selected: 2, outcomes: { FILLED_WITH_PROOF: 1 } },
    { selected: 1, outcomes: { unknown: 1 } },
    { selected: 0, outcomes: { RECOVERY_ERROR: -1 } },
  ])('rejects malformed or incomplete counts', (recent) => {
    expect(
      toAdminRecoveryDiagnostics(run({ demoCloseRecovery: { recent, aged: empty } }))?.diagnostics,
    ).toBeNull();
  });
});
