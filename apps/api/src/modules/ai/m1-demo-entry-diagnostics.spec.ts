import type { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import { toDemoFocusedEntryDiagnostic } from './m1-demo-entry-diagnostics';

describe('user-scoped, fail-closed focused DEMO no-trade evidence', () => {
  it('treats a missing current cTrader DEMO session as no current-session evidence', () => {
    const output = toDemoFocusedEntryDiagnostic({
      active_session_count: '0',
      evaluated_decisions: '981',
      candidate_decisions: '75',
      broker_authorized_decisions: '12',
      execution_succeeded: '11',
      session_inactive_decisions: '4',
      leading_blockers: [{ code: 'DRIFT_OUT_OF_DISTRIBUTION', count: 101 }],
    });
    expect(output).toEqual({
      scope: 'NO_ACTIVE_CTRADER_DEMO_SESSION',
      windowMinutes: 60,
      evaluatedDecisions: 0,
      candidateDecisions: 0,
      brokerAuthorizedDecisions: 0,
      executionSucceeded: 0,
      sessionInactiveDecisions: 0,
      leadingBlockers: [],
      onlyCurrentSession: true,
    });
  });

  it('preserves exact counts and only three named, supported reasons', () => {
    expect(
      toDemoFocusedEntryDiagnostic({
        active_session_count: '1',
        evaluated_decisions: '300',
        candidate_decisions: 45,
        broker_authorized_decisions: '0',
        execution_succeeded: '0',
        session_inactive_decisions: '0',
        leading_blockers: [
          { code: 'ENSEMBLE_NOT_PROMOTABLE_ADMISSION', count: 240 },
          { code: 'MULTIMODEL_CONTINUATION_TIMING_NOT_READY', count: '200' },
          { code: 'DRIFT_OUT_OF_DISTRIBUTION', count: 105 },
          { code: 'UNKNOWN', count: 999 },
        ],
      }),
    ).toMatchObject({
      scope: 'ACTIVE_CTRADER_DEMO',
      evaluatedDecisions: 300,
      candidateDecisions: 45,
      brokerAuthorizedDecisions: 0,
      executionSucceeded: 0,
      sessionInactiveDecisions: 0,
      onlyCurrentSession: true,
      leadingBlockers: [
        {
          code: 'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
          count: 240,
          label: 'Primary model admission not met',
        },
        {
          code: 'MULTIMODEL_CONTINUATION_TIMING_NOT_READY',
          count: 200,
          label: 'M1 continuation timing not ready',
        },
        {
          code: 'DRIFT_OUT_OF_DISTRIBUTION',
          count: 105,
          label: 'Market outside validated model conditions',
        },
      ],
    });
  });

  it('rejects non-finite and negative counts instead of showing distorted evidence', () => {
    const output = toDemoFocusedEntryDiagnostic({
      active_session_count: 1,
      evaluated_decisions: '-4',
      candidate_decisions: 'NaN',
      broker_authorized_decisions: Infinity,
      execution_succeeded: null as unknown as number,
      session_inactive_decisions: '2',
      leading_blockers: [{ code: 'PAPER_NET_EXPECTED_R', count: 'NaN' }],
    });
    expect(output.evaluatedDecisions).toBe(0);
    expect(output.candidateDecisions).toBe(0);
    expect(output.brokerAuthorizedDecisions).toBe(0);
    expect(output.leadingBlockers).toEqual([]);
  });

  it('queries only the exact current user, active validated cTrader DEMO session and three allowed pairs', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        active_session_count: '1',
        evaluated_decisions: '42',
        candidate_decisions: '6',
        broker_authorized_decisions: '0',
        execution_succeeded: '0',
        session_inactive_decisions: '0',
        leading_blockers: [{ code: 'PAPER_NET_EXPECTED_R', count: 22 }],
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const evidence = await service.loadFocusedDemoEntryDiagnostic('user-12');
    expect(evidence.evaluatedDecisions).toBe(42);
    expect(evidence.leadingBlockers[0]).toEqual({
      code: 'PAPER_NET_EXPECTED_R',
      label: 'Modeled expectancy below required floor',
      count: 22,
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['user-12', ['AUDUSD', 'GBPUSD', 'EURUSD']]);
    expect(sql).toContain('s.user_id = $1');
    expect(sql).toContain('d.user_id = $1');
    expect(sql).toContain('b.user_id = s.user_id');
    expect(sql).toContain("s.execution_mode = 'FULL_AUTO'");
    expect(sql).toContain("s.status = 'ACTIVE'");
    expect(sql).toContain("b.account_type = 'DEMO'");
    expect(sql).toContain("b.broker_id = 'ctrader'");
    expect(sql).toContain('d.broker_connection_id');
    expect(sql).toContain("GREATEST(s.started_at, NOW() - interval '60 minutes')");
    expect(sql).toContain('d.instrument = ANY($2::text[])');
    expect(sql).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bEXECUTE\b/i);
  });
});
