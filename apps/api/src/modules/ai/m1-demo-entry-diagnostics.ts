/**
 * Read-only DEMO entry-diagnostic presentation contract.
 * Counts are persisted M1 decisions, not distinct trades or profitable setups.
 * No function in this module can submit or approve an order.
 */
export const DEMO_ENTRY_BLOCKER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ENSEMBLE_NOT_PROMOTABLE_ADMISSION: 'Primary model admission not met',
  MULTIMODEL_CONTINUATION_TIMING_NOT_READY: 'M1 continuation timing not ready',
  DRIFT_OUT_OF_DISTRIBUTION: 'Market outside validated model conditions',
  PAPER_NET_EXPECTED_R: 'Modeled expectancy below required floor',
  MULTIMODEL_PLAN_B_NOT_ADMITTED: 'Primary Plan B not admitted',
  M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION: 'Eligible fallback entries held in probation',
  M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED: 'Recent early-transition results too weak',
  M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK: 'Recent consecutive losing trades',
  MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED: 'M1 timing has not confirmed reversal',
  M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE: 'Account-wide recent net losses',
  M1_MULTIMODEL_LOSS_STREAK_BRAKE: 'Model loss-streak protection',
  M1_FAST_STOP_REGIME_BRAKE: 'Fast stop-loss pattern protection',
  EVENT_RISK_HIGH_IMPACT_BLOCK: 'High-impact news risk',

  M1_DEMO_INSTRUMENT_RESEARCH_ONLY: 'Pair is research-only',
  M1_DEMO_BROKER_COMMISSION_NET_EDGE_BELOW_FLOOR: 'Broker costs exceed expected edge',
});

/** Plan B rejection causes are overlapping per-candidate checks, not risk overrides. */
export const DEMO_PLANB_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  DIRECTION_QUALITY: 'Direction quality below threshold',
  EXIT_FEASIBILITY: 'Exit feasibility check failed',
  TRADE_QUALITY: 'Trade-quality score below threshold',
  REGIME_TREND_EXTENDED: 'Trend extended beyond permitted regime',
  REGIME_TREND_WEAK: 'Trend too weak for this route',
  META_EXPECTED_VALUE: 'Meta-model expected value too low',
  EXPECTED_R: 'Expected reward-to-risk too low',
  REGIME_ROLLOVER_RISK: 'Rollover regime unsuitable',
  SESSION_QUALITY: 'Session quality below requirement',
});

export interface DemoFocusedEntryDiagnostic {
  scope: 'ACTIVE_CTRADER_DEMO' | 'NO_ACTIVE_CTRADER_DEMO_SESSION';
  windowMinutes: 60;
  evaluatedDecisions: number;
  candidateDecisions: number;
  brokerAuthorizedDecisions: number;
  executionSucceeded: number;
  sessionInactiveDecisions: number;
  /** Minutes since the exact active session began (not since app startup). */
  sessionAgeMinutes: number;
  /** Null when no current-session focused-pair decision was recorded. */
  lastDecisionAgeSeconds: number | null;
  /** Observed execution funnel; counts can overlap, never confer authority. */
  planBAdmittedDecisions: number;
  /** All Plan B reversal admissions held by independent M1 timing, including abstentions. */
  planBReversalTimingHeldDecisions: number;
  /** Subset of reversal timing holds where M1 never proposed a trade. */
  planBReversalM1AbstainedDecisions: number;
  /** Same-side, Plan B reversal/transition admissions held when M1 labels continuation. */
  planBAdmittedM1ContinuationRouteMismatchDecisions: number;
  /** All evaluated decisions in a rollover-classified regime, not orders. */
  rolloverRegimeDecisions: number;
  primaryPathDecisions: number;
  primaryReliabilityVetoDecisions: number;
  eligibleFallbackProbationVetoDecisions: number;
  operatingState:
    | 'NO_ACTIVE_SESSION'
    | 'NO_RECENT_SCANS'
    | 'STALE_SCAN_EVIDENCE'
    | 'NO_RECENT_CANDIDATES'
    | 'SCANNING_NO_APPROVED_ENTRY'
    | 'RECENT_ENTRY_AUTHORIZATION';
  leadingBlockers: Array<{ code: string; label: string; count: number }>;
  /** Reasons from rejected Plan B model admissions; overlaps are possible. */
  leadingPlanBReasons: Array<{ code: string; label: string; count: number }>;
  /** True if the count window is bounded by the current session start. */
  onlyCurrentSession: true;
}

export interface DemoFocusedEntryDiagnosticRow {
  active_session_count: number | string;
  evaluated_decisions: number | string;
  candidate_decisions: number | string;
  broker_authorized_decisions: number | string;
  execution_succeeded: number | string;
  session_inactive_decisions: number | string;
  session_age_minutes: number | string;
  last_decision_age_seconds: number | string | null;
  planb_admitted_decisions: number | string;
  planb_reversal_timing_held_decisions?: number | string;
  planb_reversal_m1_abstained_decisions?: number | string;
  planb_admitted_m1_continuation_route_mismatch_decisions?: number | string;
  rollover_regime_decisions?: number | string;
  primary_path_decisions: number | string;
  primary_reliability_veto_decisions: number | string;
  eligible_fallback_probation_veto_decisions: number | string;
  leading_blockers: unknown;
  leading_planb_reasons?: unknown;
}

function safeCount(raw: unknown): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function safeAgeSeconds(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function toDemoFocusedEntryDiagnostic(
  row: DemoFocusedEntryDiagnosticRow | undefined,
): DemoFocusedEntryDiagnostic {
  const active = safeCount(row?.active_session_count) === 1;
  const reasons = Array.isArray(row?.leading_blockers) ? row.leading_blockers : [];
  const planBReasons = Array.isArray(row?.leading_planb_reasons) ? row.leading_planb_reasons : [];
  const evaluated = active ? safeCount(row?.evaluated_decisions) : 0;
  const candidates = active ? safeCount(row?.candidate_decisions) : 0;
  const approved = active ? safeCount(row?.broker_authorized_decisions) : 0;
  const lastDecisionAgeSeconds = active ? safeAgeSeconds(row?.last_decision_age_seconds) : null;
  const operatingState: DemoFocusedEntryDiagnostic['operatingState'] = !active
    ? 'NO_ACTIVE_SESSION'
    : evaluated === 0
      ? 'NO_RECENT_SCANS'
      : lastDecisionAgeSeconds !== null && lastDecisionAgeSeconds >= 240
        ? 'STALE_SCAN_EVIDENCE'
        : candidates === 0
          ? 'NO_RECENT_CANDIDATES'
          : approved > 0
            ? 'RECENT_ENTRY_AUTHORIZATION'
            : 'SCANNING_NO_APPROVED_ENTRY';
  return {
    scope: active ? 'ACTIVE_CTRADER_DEMO' : 'NO_ACTIVE_CTRADER_DEMO_SESSION',
    windowMinutes: 60,
    evaluatedDecisions: evaluated,
    candidateDecisions: candidates,
    brokerAuthorizedDecisions: approved,
    executionSucceeded: active ? safeCount(row?.execution_succeeded) : 0,
    sessionInactiveDecisions: active ? safeCount(row?.session_inactive_decisions) : 0,
    sessionAgeMinutes: active ? safeCount(row?.session_age_minutes) : 0,
    lastDecisionAgeSeconds,
    planBAdmittedDecisions: active ? safeCount(row?.planb_admitted_decisions) : 0,
    planBReversalTimingHeldDecisions: active
      ? safeCount(row?.planb_reversal_timing_held_decisions)
      : 0,
    planBReversalM1AbstainedDecisions: active
      ? safeCount(row?.planb_reversal_m1_abstained_decisions)
      : 0,
    planBAdmittedM1ContinuationRouteMismatchDecisions: active
      ? safeCount(row?.planb_admitted_m1_continuation_route_mismatch_decisions)
      : 0,
    rolloverRegimeDecisions: active ? safeCount(row?.rollover_regime_decisions) : 0,
    primaryPathDecisions: active ? safeCount(row?.primary_path_decisions) : 0,
    primaryReliabilityVetoDecisions: active
      ? safeCount(row?.primary_reliability_veto_decisions)
      : 0,
    eligibleFallbackProbationVetoDecisions: active
      ? safeCount(row?.eligible_fallback_probation_veto_decisions)
      : 0,
    operatingState,
    leadingBlockers: active
      ? reasons
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === 'object' && !Array.isArray(item),
          )
          .filter((item) => typeof item.code === 'string' && item.code in DEMO_ENTRY_BLOCKER_LABELS)
          .map((item) => ({
            code: String(item.code),
            label: DEMO_ENTRY_BLOCKER_LABELS[String(item.code)],
            count: safeCount(item.count),
          }))
          .filter((item) => item.count > 0)
          .slice(0, 3)
      : [],
    leadingPlanBReasons: active
      ? planBReasons
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === 'object' && !Array.isArray(item),
          )
          .filter((item) => typeof item.code === 'string' && item.code in DEMO_PLANB_REASON_LABELS)
          .map((item) => ({
            code: String(item.code),
            label: DEMO_PLANB_REASON_LABELS[String(item.code)],
            count: safeCount(item.count),
          }))
          .filter((item) => item.count > 0 && item.count <= candidates)
          .slice(0, 3)
      : [],
    onlyCurrentSession: true,
  };
}
