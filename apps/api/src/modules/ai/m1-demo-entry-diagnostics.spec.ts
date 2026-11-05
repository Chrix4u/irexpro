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
      session_age_minutes: '396',
      last_decision_age_seconds: '15',
      planb_admitted_decisions: '2',
      primary_path_decisions: '1',
      primary_reliability_veto_decisions: '1',
      eligible_fallback_probation_veto_decisions: '0',
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
      sessionAgeMinutes: 0,
      lastDecisionAgeSeconds: null,
      planBAdmittedDecisions: 0,
      primaryPathDecisions: 0,
      primaryReliabilityVetoDecisions: 0,
      eligibleFallbackProbationVetoDecisions: 0,
      operatingState: 'NO_ACTIVE_SESSION',
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
        session_age_minutes: '396',
        last_decision_age_seconds: '15',
        planb_admitted_decisions: '8',
        primary_path_decisions: '2',
        primary_reliability_veto_decisions: '2',
        eligible_fallback_probation_veto_decisions: '3',
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
      sessionAgeMinutes: 396,
      lastDecisionAgeSeconds: 15,
      planBAdmittedDecisions: 8,
      primaryPathDecisions: 2,
      primaryReliabilityVetoDecisions: 2,
      eligibleFallbackProbationVetoDecisions: 3,
      operatingState: 'SCANNING_NO_APPROVED_ENTRY',
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
      session_age_minutes: 'NaN',
      last_decision_age_seconds: '15',
      planb_admitted_decisions: '-3',
      primary_path_decisions: Infinity,
      primary_reliability_veto_decisions: null as unknown as number,
      eligible_fallback_probation_veto_decisions: 'invalid',
      leading_blockers: [{ code: 'PAPER_NET_EXPECTED_R', count: 'NaN' }],
    });
    expect(output.evaluatedDecisions).toBe(0);
    expect(output.candidateDecisions).toBe(0);
    expect(output.brokerAuthorizedDecisions).toBe(0);
    expect(output.leadingBlockers).toEqual([]);
  });

  it('distinguishes live scans, no setups, and actual recent broker authority', () => {
    const row = {
      active_session_count: 1,
      evaluated_decisions: 180,
      candidate_decisions: 20,
      broker_authorized_decisions: 0,
      execution_succeeded: 0,
      session_inactive_decisions: 0,
      session_age_minutes: 400,
      last_decision_age_seconds: '15',
      planb_admitted_decisions: 1,
      primary_path_decisions: 1,
      primary_reliability_veto_decisions: 1,
      eligible_fallback_probation_veto_decisions: 0,
      leading_blockers: [],
    };
    expect(toDemoFocusedEntryDiagnostic(row).operatingState).toBe('SCANNING_NO_APPROVED_ENTRY');
    expect(toDemoFocusedEntryDiagnostic({ ...row, candidate_decisions: 0 }).operatingState).toBe(
      'NO_RECENT_CANDIDATES',
    );
    expect(
      toDemoFocusedEntryDiagnostic({ ...row, evaluated_decisions: 0, candidate_decisions: 0 })
        .operatingState,
    ).toBe('NO_RECENT_SCANS');
    expect(
      toDemoFocusedEntryDiagnostic({ ...row, broker_authorized_decisions: 1 }).operatingState,
    ).toBe('RECENT_ENTRY_AUTHORIZATION');
  });

  it('reports stale scanner evidence even when old candidates or broker approvals exist', () => {
    const row = {
      active_session_count: 1,
      evaluated_decisions: 150,
      candidate_decisions: 18,
      broker_authorized_decisions: 1,
      execution_succeeded: 1,
      session_inactive_decisions: 0,
      session_age_minutes: 520,
      last_decision_age_seconds: '601',
      planb_admitted_decisions: 4,
      primary_path_decisions: 1,
      primary_reliability_veto_decisions: 0,
      eligible_fallback_probation_veto_decisions: 0,
      leading_blockers: [],
    };
    expect(toDemoFocusedEntryDiagnostic(row)).toMatchObject({
      operatingState: 'STALE_SCAN_EVIDENCE',
      lastDecisionAgeSeconds: 601,
      brokerAuthorizedDecisions: 1,
    });
    expect(
      toDemoFocusedEntryDiagnostic({ ...row, last_decision_age_seconds: '239' }).operatingState,
    ).toBe('RECENT_ENTRY_AUTHORIZATION');
    expect(
      toDemoFocusedEntryDiagnostic({ ...row, last_decision_age_seconds: 'broken' })
        .lastDecisionAgeSeconds,
    ).toBeNull();
    expect(toDemoFocusedEntryDiagnostic({ ...row, evaluated_decisions: 0 }).operatingState).toBe(
      'NO_RECENT_SCANS',
    );
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
        session_age_minutes: '32',
        last_decision_age_seconds: '15',
        planb_admitted_decisions: '2',
        primary_path_decisions: '1',
        primary_reliability_veto_decisions: '1',
        eligible_fallback_probation_veto_decisions: '0',
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
    expect(sql).toContain("WHERE c.route <> 'ABSTAIN'");
    expect(sql).toContain('AS session_age_minutes');
    expect(sql).toContain('AS last_decision_age_seconds');
    expect(sql).toContain('MAX(evaluated_at)');
    expect(sql).toContain('AS planb_admitted_decisions');
    expect(sql).toContain('AS primary_path_decisions');
    expect(sql).toContain('AS primary_reliability_veto_decisions');
    expect(sql).toContain('AS eligible_fallback_probation_veto_decisions');
    expect(sql).toContain("governance->'multimodelAuthority'->>'authorityPath' = 'PRIMARY_PLAN_B'");
    expect(sql).toContain("blockers ? 'M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED'");
    expect(sql).toContain("'M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION'");
    expect(sql).toContain("'chosenAuthorityPath'");
    expect(sql).toContain("IN ('BLOCKED', 'UNKNOWN')");
    expect(sql).toContain("'M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED'");
    expect(sql).toContain("'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK'");
    expect(sql).toContain("'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'");
    expect(sql).toContain("'EVENT_RISK_HIGH_IMPACT_BLOCK'");
    expect(sql).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bEXECUTE\b/i);
  });
});
