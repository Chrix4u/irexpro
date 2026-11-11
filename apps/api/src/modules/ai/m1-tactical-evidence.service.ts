import { Injectable } from '@nestjs/common';
import { CTRADER_FAMILY_BROKER_IDS } from '../broker/registry/broker-catalog';
import { DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2 } from './demo-focused-instruments';
import {
  toDemoFocusedEntryDiagnostic,
  type DemoFocusedEntryDiagnostic,
  type DemoFocusedEntryDiagnosticRow,
} from './m1-demo-entry-diagnostics';

import { DataSource } from 'typeorm';
import type { M1ReliabilityRoute, M1RoutePairSideEvidenceRow } from './m1-tactical-reliability';
import type { M1FailedMoveRescueDecision } from './m1-failed-move-rescue';
import type { M1DriftCounterfactualResult } from './m1-drift-counterfactual';
import type { M1ShadowPairSideOutcome } from './m1-shadow-pair-side-reliability';
import { m1UsdRiskAtStop } from './m1-tactical-currency-exposure';
import type { M5EarlyTransitionEvidence } from './m5-early-transition-handoff';
import { EXTENSION_EXHAUSTION_SHADOW_ARTIFACT } from './extension-exhaustion-shadow';
import {
  LOW_VOL_RANGE_EPISODE_MINUTES,
  LOW_VOL_RANGE_SHADOW_ARTIFACT,
} from './low-vol-range-shadow';
import type { LowVolRangeShadowOutcome } from './low-vol-range-shadow-outcome';
import type { ExtensionExhaustionShadowReliability } from './extension-exhaustion-demo-scout';
import {
  evaluateM1PortfolioNetLossBrake,
  M1_PORTFOLIO_NET_LOSS_BRAKE_LOOKBACK_HOURS,
  M1_PORTFOLIO_NET_LOSS_BRAKE_REQUIRED_LOSSES,
} from './m1-portfolio-net-loss-brake';

export type M1TacticalDecisionRoute = M1ReliabilityRoute | 'ABSTAIN';
export type M1TacticalDecisionAuthority = 'NONE' | 'PAPER_ONLY_RESEARCH' | 'BROKER_NATIVE';

export interface M1TacticalDecisionInput {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: M1TacticalDecisionRoute;
  barTime: Date;
  evaluatedAt?: Date;
  policyVersion: string;
  executionAuthority: M1TacticalDecisionAuthority;
  candidate: Record<string, unknown>;
  governance: Record<string, unknown>;
  blockers: string[];
}

export interface M1TacticalLatestDecisionState {
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: M1TacticalDecisionRoute;
  barTime: string;
  confidence: number;
  netExpectedR: number;
  executionAuthority: M1TacticalDecisionAuthority;
  blockers: string[];
  outcomeState: string | null;
  primaryEngineCode: string | null;
  primaryConfidence: number | null;
  primaryNetExpectedR: number | null;
  planBRoute: string | null;
  planBRegime: string | null;
  planBRegimeAllowed: boolean | null;
  planBPaperAdmitted: boolean | null;
  multimodelExecutable: boolean | null;
  multimodelAuthorityPath: string | null;
  multimodelRescueVolumeCap: number | null;
  trainedExpertState: string | null;
  trainedExpertReason: string | null;
  trainedExpertDirection: 'BUY' | 'SELL' | null;
  trainedExpertConfidence: number | null;
  trainedExpertLongVotes: number | null;
  trainedExpertShortVotes: number | null;
  m1TacticalRole: string | null;
  m1TimingRoute: M1TacticalDecisionRoute;
  /** Exact persisted M1 route-classifier cause; display-only and non-authoritative. */
  m1TimingReason: string | null;
  /** DEMO-only explanatory telemetry; never grants execution. */
  primaryBlockerGroup?: string | null;
  primaryBlockerCode?: string | null;
  /** Read-only model drift provenance; never overrides hard risk vetoes. */
  modelDriftState?: string | null;
  modelDriftDiagnostics?: string[];
  /** As-of broker commission research on already blocked DEMO decisions. */
  brokerCommissionResearchReason?: string | null;
  brokerCommissionSampleCount?: number | null;
  brokerCommissionP90CostR?: number | null;
  m1EstimatedNetAfterCommissionR?: number | null;
  planBEstimatedNetAfterCommissionR?: number | null;
  demoCostBreakEvenStopPrice?: number | null;
  demoAlternativeCostR?: number | null;
}

export interface M1TacticalDecisionRecord {
  id: string;
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: M1TacticalDecisionRoute;
  barTime: Date;
  policyVersion: string;
  executionAuthority: M1TacticalDecisionAuthority;
  blockers: string[];
  signalId: string | null;
  tradeIntentId: string | null;
  outcomeState: string | null;
  outcomeReason: string | null;
  outcomeObservedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const M1_SHADOW_OUTCOME_15M_ARTIFACT = 'm1-shadow-outcome-15m-v1' as const;

export interface M1ShadowEpisodeLeaderQuery {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  policyVersion: string;
  asOf: Date;
}

export interface M1ShadowEpisodeLeader {
  id: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: M1ReliabilityRoute;
  barTime: Date;
  evaluatedAt: Date;
  policyVersion: string;
  stopDistance: number;
  targetDistance: number;
  estimatedExecutionCostR: number;
  executionCostSource: string | null;
  rolloutPhase: string | null;
}

export interface M1ShadowOutcome15mV1 {
  artifact: typeof M1_SHADOW_OUTCOME_15M_ARTIFACT;
  modifiesExecution: false;
  episodeLeaderDecisionId: string;
  episodeStartBarTime: string;
  route: M1ReliabilityRoute;
  instrument: string;
  direction: 'BUY' | 'SELL';
  policyVersion: string;
  source: 'COMPLETED_M1_OHLC' | 'UNOBSERVABLE_DATA_GAP';
  executionCostSource: string | null;
  rolloutPhase: string | null;
  outcome: 'TP' | 'SL' | 'MTM' | 'AMBIGUOUS' | 'UNOBSERVABLE_DATA_GAP';
  entryBarOpenTime: string | null;
  observedAt: string;
  terminalBarOpenTime: string | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  terminalPrice: number | null;
  estimatedExecutionCostR: number;
  grossRMultiple: number | null;
  netRMultiple: number | null;
}

export const M1_FAST_STOP_REGIME_BRAKE_ARTIFACT = 'm1-fast-stop-regime-brake-v1' as const;
export const M1_FAST_STOP_MAX_DURATION_MINUTES = 2;
export const M1_FAST_STOP_COOLDOWN_MINUTES = 5;
export const M1_MULTIMODEL_LOSS_STREAK_BRAKE_ARTIFACT =
  'm1-multimodel-loss-streak-brake-v1' as const;
export const M1_MULTIMODEL_LOSS_STREAK_MIN_CLOSED_TRADES = 3;
export const M1_MULTIMODEL_LOSS_STREAK_WINDOW_HOURS = 24;
export const M1_MULTIMODEL_LOSS_STREAK_COOLDOWN_HOURS = 12;
export const M1_MULTIMODEL_PAYOFF_WINDOW_TRADES = 8;
export const M1_MULTIMODEL_NEGATIVE_PAYOFF_MIN_TRADES = 5;
export const M1_MULTIMODEL_NEGATIVE_PAYOFF_MAX_PROFIT_FACTOR = 0.7;
export const M1_MULTIMODEL_PAYOFF_LOOKBACK_DAYS = 14;
export const M1_MULTIMODEL_PERSISTENT_NEGATIVE_PAYOFF_MIN_TRADES = 8;
export const M1_MULTIMODEL_PERSISTENT_NEGATIVE_PAYOFF_MAX_PROFIT_FACTOR = 0.65;
export const M1_MULTIMODEL_CONFIRMED_REVERSAL_PERSISTENT_NEGATIVE_PAYOFF_MIN_TRADES = 4;
export const M1_MULTIMODEL_CONFIRMED_REVERSAL_PERSISTENT_NEGATIVE_PAYOFF_MAX_PROFIT_FACTOR = 0.5;
export const M1_MULTIMODEL_PERSISTENT_NEGATIVE_PAYOFF_MAX_AGE_HOURS = 96;

export type M1MultimodelStrategyRoute =
  | 'TREND_CONTINUATION'
  | 'CONFIRMED_REVERSAL'
  | 'EARLY_TRANSITION';

export interface M1MultimodelLossStreakBrakeQuery {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategyRoute: M1MultimodelStrategyRoute;
  evaluatedAt: Date;
}

export interface M1MultimodelLossStreakBrakeDecision {
  artifact: typeof M1_MULTIMODEL_LOSS_STREAK_BRAKE_ARTIFACT;
  active: boolean;
  reason:
    | 'CLEAR'
    | 'RECENT_MULTIMODEL_LOSS_STREAK'
    | 'RECENT_NEGATIVE_PAYOFF'
    | 'PERSISTENT_NEGATIVE_PAYOFF';
  strategyRoute: M1MultimodelStrategyRoute;
  recentClosedTrades: number;
  payoffClosedTrades: number;
  recentLosses: number;
  recentWins: number;
  cumulativeRealisedPnl: number;
  profitFactor?: number | null;
  negativePayoff?: boolean;
  persistentNegativePayoff: boolean;
  latestClosedAt: Date | null;
  cooldownHours: number;
  cooldownRemainingSeconds: number;
}

export interface M1FastStopRegimeBrakeQuery {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  evaluatedAt: Date;
}

export interface M1FastStopRegimeBrakeDecision {
  artifact: typeof M1_FAST_STOP_REGIME_BRAKE_ARTIFACT;
  active: boolean;
  reason: 'CLEAR' | 'RECENT_FAST_STOP';
  latestFastStopClosedAt: Date | null;
  latestFastStopDurationMinutes: number | null;
  cooldownMinutes: number;
  maxStopDurationMinutes: number;
  cooldownRemainingSeconds: number;
}

export interface M1RoutePairSideEvidenceQuery {
  userId: string;
  brokerConnectionId: string;
  route: M1ReliabilityRoute;
  instrument: string;
  direction: 'BUY' | 'SELL';
  currentPolicyVersion: string;
  compatiblePolicyVersions: string[];
  evaluatedAt: Date;
}

export interface M1OpenPaperPositionQuery {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
}

export interface M1OpenPaperRiskPositionQuery {
  userId: string;
  brokerConnectionId: string;
}

export interface M1OpenPaperRiskPositionSnapshot {
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: number;
  riskAtStop: number | null;
}

export interface M1ActiveIntentQuery {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
}

export type M1ActiveOppositeIntentQuery = M1ActiveIntentQuery;

export interface M1OpenPaperPositionSnapshot {
  tradeId: string;
  tradeIntentId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  openedAt: Date;
  decisionId: string;
  route: M1ReliabilityRoute;
  policyVersion: string;
  originalNetExpectedR: number;
}

export interface M1RescueObservationInput {
  openTradeId: string;
  openDecisionId: string;
  observedAt: Date;
  rescue: M1FailedMoveRescueDecision;
}

export interface M1PendingDriftCounterfactualQuery {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  asOf: Date;
  policyVersion: string;
}

export interface M1PendingDriftCounterfactual {
  id: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: M1ReliabilityRoute;
  evaluatedAt: Date;
  stopDistance: number;
  targetDistance: number;
  estimatedExecutionCostR: number;
  driftState: string | null;
  driftDiagnostics: string[];
  /** Other vetoes persist independently of the drift counterfactual. */
  nonDriftBlockers: string[];
  driftEvidenceSource: 'MULTIMODEL' | 'GENERIC';
}

export interface M1TacticalOutcomeMetricsFilter {
  userId: string;
  brokerConnectionId: string;
  route?: M1ReliabilityRoute;
  instrument?: string;
  direction?: 'BUY' | 'SELL';
  policyVersion?: string;
  from: Date;
  to: Date;
}

export interface M1TacticalOutcomeMetrics {
  closedTrades: number;
  wins: number;
  losses: number;
  realisedPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
}

export interface M1ShadowOutcomeMetricsFilter {
  userId: string;
  brokerConnectionId: string;
  route?: M1ReliabilityRoute;
  instrument?: string;
  direction?: 'BUY' | 'SELL';
  policyVersion?: string;
  from: Date;
  to: Date;
}

export interface M1ShadowOutcomeMetrics {
  totalEpisodeLeaders: number;
  evaluableEpisodes: number;
  ambiguousEpisodes: number;
  unobservableEpisodes: number;
  positiveEpisodes: number;
  negativeEpisodes: number;
  flatEpisodes: number;
  cumulativeNetR: number;
  averageNetR: number;
  grossPositiveR: number;
  grossNegativeR: number;
  profitFactor: number | null;
  maximumDrawdownR: number;
}

export interface M1ShadowPairSideOutcomeQuery {
  userId: string;
  brokerConnectionId: string;
  route: M1ReliabilityRoute;
  instrument: string;
  direction: 'BUY' | 'SELL';
  policyVersion: string;
  evaluatedAt: Date;
}

interface DecisionRow {
  id: string;
  user_id: string;
  broker_connection_id: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: M1TacticalDecisionRoute;
  bar_time: string | Date;
  policy_version: string;
  execution_authority: M1TacticalDecisionAuthority;
  blockers: unknown;
  signal_id: string | null;
  trade_intent_id: string | null;
  outcome_state: string | null;
  outcome_reason: string | null;
  outcome_observed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function date(value: string | Date): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function nullableDate(value: string | Date | null): Date | null {
  if (value == null) return null;
  const parsed = date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function blockers(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

@Injectable()
export class M1TacticalEvidenceService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Bounded, read-only, account-scoped explanation of why the six focused
   * DEMO pairs are not opening trades. A currently ACTIVE, exact-user cTrader
   * family DEMO FULL_AUTO session is required; historical/suspended sessions never
   * inherit newer decisions. Never changes execution authority or risk.
   *
   * The most common reasons are overlapping reasons PER DECISION (not trades).
   * No account IDs, raw trade data, or session IDs leave this service.
   * Called by a separately polled 30-second diagnostic endpoint, not the
   * four-second core trading control/status refresh.
   */
  async loadFocusedDemoEntryDiagnostic(userId: string): Promise<DemoFocusedEntryDiagnostic> {
    const rows = (await this.dataSource.query(
      `
      WITH active_scope AS (
        SELECT s.broker_connection_id, s.started_at,
          GREATEST(s.started_at, NOW() - interval '60 minutes') AS from_time
        FROM trading.trading_sessions s
        JOIN broker.broker_connections b
          ON b.id = s.broker_connection_id AND b.user_id = s.user_id
          AND b.broker_id = ANY($3::text[]) AND b.account_type = 'DEMO'
        WHERE s.user_id = $1
          AND s.execution_mode = 'FULL_AUTO'
          AND s.status = 'ACTIVE'
        ORDER BY s.authority_generation DESC, s.started_at DESC
        LIMIT 1
      ), cohort AS (
        SELECT d.evaluated_at, d.route, d.execution_authority, d.outcome_state,
          d.blockers, d.governance
        FROM trading.m1_tactical_decisions d
        JOIN active_scope s ON s.broker_connection_id = d.broker_connection_id
        WHERE d.user_id = $1
          AND d.instrument = ANY($2::text[])
          AND d.evaluated_at >= s.from_time
          AND d.evaluated_at <= NOW()
      ), top_reasons AS (
        SELECT b.value AS code, COUNT(*) AS frequency
        FROM cohort c
        CROSS JOIN LATERAL jsonb_array_elements_text(c.blockers) AS b(value)
        -- Do not count ABSTAIN scans as rejected order proposals. This
        -- reveals the actual reason distribution among potential M1 entries.
        WHERE c.route <> 'ABSTAIN'
          AND b.value IN (
          'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
          'MULTIMODEL_CONTINUATION_TIMING_NOT_READY',
          'DRIFT_OUT_OF_DISTRIBUTION',
          'PAPER_NET_EXPECTED_R',
          'MULTIMODEL_PLAN_B_NOT_ADMITTED',
          'M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION',
          'M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED',
          'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK',
          'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED',
          'M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE',
          'M1_MULTIMODEL_LOSS_STREAK_BRAKE',
          'M1_FAST_STOP_REGIME_BRAKE',
          'EVENT_RISK_HIGH_IMPACT_BLOCK',
          'M1_DEMO_BROKER_COMMISSION_NET_EDGE_BELOW_FLOOR'
        )
        -- Previous revisions attached the probation blocker even when
        -- Plan-B itself was BLOCKED and there was no fallback to veto.
        -- Retrospectively exclude those misleading historical observations.
        AND NOT (
          b.value = 'M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION'
          AND COALESCE(
            c.governance->'demoPrimaryOnlyProbation'->>'chosenAuthorityPath',
            'UNKNOWN'
          ) IN ('BLOCKED', 'UNKNOWN')
        )
        GROUP BY b.value ORDER BY frequency DESC, code ASC LIMIT 3
      ), top_planb_reasons AS (
        SELECT r.value AS code, COUNT(*) AS frequency
        FROM cohort c
        CROSS JOIN LATERAL (
          SELECT DISTINCT item.value
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(c.governance->'multimodelEnsemble'->'reasons') = 'array'
              THEN c.governance->'multimodelEnsemble'->'reasons'
              ELSE '[]'::jsonb
            END
          ) AS item(value)
        ) AS r(value)
        WHERE c.route <> 'ABSTAIN'
          AND COALESCE(c.governance->'multimodelEnsemble'->>'paperAdmitted', 'false') <> 'true'
          AND r.value IN (
            'DIRECTION_QUALITY', 'EXIT_FEASIBILITY', 'TRADE_QUALITY',
            'REGIME_TREND_EXTENDED', 'REGIME_TREND_WEAK',
            'META_EXPECTED_VALUE', 'EXPECTED_R',
            'REGIME_ROLLOVER_RISK', 'SESSION_QUALITY'
          )
        -- DISTINCT in the lateral block ensures each reason counts
        -- at most once per candidate, even if the source repeats a code.
        GROUP BY r.value ORDER BY frequency DESC, code ASC LIMIT 3
      )
      SELECT
        (SELECT COUNT(*) FROM active_scope) AS active_session_count,
        COALESCE((
          SELECT GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))
          FROM active_scope
        ), 0) AS session_age_minutes,
        -- An active session with old decisions is not an actively scanning engine.
        -- This is observation-only and cannot grant broker entry authority.
        (SELECT GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(evaluated_at)))))
           FROM cohort) AS last_decision_age_seconds,
        (SELECT COUNT(*) FROM cohort) AS evaluated_decisions,
        (SELECT COUNT(*) FROM cohort WHERE route <> 'ABSTAIN') AS candidate_decisions,
        (SELECT COUNT(*) FROM cohort WHERE execution_authority = 'BROKER_NATIVE')
          AS broker_authorized_decisions,
        (SELECT COUNT(*) FROM cohort WHERE outcome_state = 'EXECUTION_SUCCEEDED')
          AS execution_succeeded,
        (SELECT COUNT(*) FROM cohort WHERE outcome_state = 'SESSION_INACTIVE')
          AS session_inactive_decisions,
        (SELECT COUNT(*) FROM cohort
          WHERE route <> 'ABSTAIN'
            AND governance->'multimodelEnsemble'->>'paperAdmitted' = 'true'
        ) AS planb_admitted_decisions,
        -- Unlike the usual M1 candidate funnel, include ABSTAIN scans here:
        -- Plan B may admit a reversal that the independent M1 system rejects.
        (SELECT COUNT(*) FROM cohort
          WHERE governance->'multimodelEnsemble'->>'paperAdmitted' = 'true'
            AND blockers ? 'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'
        ) AS planb_reversal_timing_held_decisions,
        (SELECT COUNT(*) FROM cohort
          WHERE route = 'ABSTAIN'
            AND governance->'multimodelEnsemble'->>'paperAdmitted' = 'true'
            AND blockers ? 'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'
        ) AS planb_reversal_m1_abstained_decisions,
        -- These are the SAME proposed side: M1 has a valid continuation route,
        -- but Plan B independently labels the same candidate as a reversal
        -- or early transition. Do not confuse semantic mismatch with M1 ABSTAIN,
        -- and do not grant permission to trade via this diagnostic.
        (SELECT COUNT(*) FROM cohort
          WHERE route = 'M1_TREND_CONTINUATION'
            AND governance->'multimodelEnsemble'->>'paperAdmitted' = 'true'
            AND (
              (governance->'multimodelEnsemble'->>'strategyRoute' = 'CONFIRMED_REVERSAL'
                AND blockers ? 'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED')
              OR
              (governance->'multimodelEnsemble'->>'strategyRoute' = 'EARLY_TRANSITION'
                AND blockers ? 'MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED')
            )
        ) AS planb_admitted_m1_continuation_route_mismatch_decisions,
        -- Rollover counts describe the model's observed regime, not a broker halt.
        (SELECT COUNT(*) FROM cohort
          WHERE governance->'multimodelEnsemble'->>'regime' = 'ROLLOVER_RISK'
        ) AS rollover_regime_decisions,
        (SELECT COUNT(*) FROM cohort
          WHERE route <> 'ABSTAIN'
            AND governance->'multimodelAuthority'->>'authorityPath' = 'PRIMARY_PLAN_B'
        ) AS primary_path_decisions,
        (SELECT COUNT(*) FROM cohort
          WHERE route <> 'ABSTAIN'
            AND governance->'multimodelAuthority'->>'authorityPath' = 'PRIMARY_PLAN_B'
            AND blockers ? 'M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED'
        ) AS primary_reliability_veto_decisions,
        (SELECT COUNT(*) FROM cohort
          WHERE route <> 'ABSTAIN'
            AND blockers ? 'M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION'
            AND COALESCE(
              governance->'demoPrimaryOnlyProbation'->>'chosenAuthorityPath', 'UNKNOWN'
            ) NOT IN ('BLOCKED', 'UNKNOWN')
        ) AS eligible_fallback_probation_veto_decisions,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('code', code, 'count', frequency))
          FROM top_reasons
        ), '[]'::jsonb) AS leading_blockers,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('code', code, 'count', frequency))
          FROM top_planb_reasons
        ), '[]'::jsonb) AS leading_planb_reasons
      `,
      [userId, [...DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2], [...CTRADER_FAMILY_BROKER_IDS]],
    )) as DemoFocusedEntryDiagnosticRow[];
    return toDemoFocusedEntryDiagnostic(rows[0]);
  }

  /**
   * Research-only as-of fee evidence. The current M1/Plan-B governance cost
   * includes spread/slippage, but not broker commission. Nothing returned here
   * may grant execution authority.
   */
  async loadPriorClosedCommissionRiskR(input: {
    userId: string;
    brokerConnectionId: string;
    instrument: string;
    asOf: Date;
  }): Promise<{ sampleCount: number; p90FeeR: number | null }> {
    const instrument = input.instrument.trim().toUpperCase();
    if (!/^[A-Z]{6}$/.test(instrument) || !Number.isFinite(input.asOf.getTime())) {
      return { sampleCount: 0, p90FeeR: null };
    }
    const rows = (await this.dataSource.query(
      `
        SELECT count(*)::int AS sample_count,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY fee_r) AS p90_fee_r
        FROM (
          SELECT (abs(t.commission) + greatest(0, -coalesce(t.swap, 0))) /
            nullif(coalesce(
              CASE WHEN a.sizing_inputs->>'finalRiskAtStop' ~ '^[0-9]+([.][0-9]+)?$'
                THEN (a.sizing_inputs->>'finalRiskAtStop')::numeric END,
              CASE WHEN a.sizing_inputs->>'riskAmount' ~ '^[0-9]+([.][0-9]+)?$'
                THEN (a.sizing_inputs->>'riskAmount')::numeric END
            ), 0) AS fee_r
          FROM trading.trades t
          JOIN trading.trading_sessions s
            ON s.id = t.trading_session_id
            AND s.user_id = t.user_id
            AND s.broker_connection_id = t.broker_connection_id
            AND s.execution_mode = 'FULL_AUTO'
            AND s.account_currency = t.account_currency
          JOIN broker.broker_connections b ON b.id = t.broker_connection_id
            AND b.user_id = $1 AND b.id = $2
            AND b.broker_id = 'ctrader' AND b.account_type = 'DEMO'
            AND b.account_currency = t.account_currency
          LEFT JOIN LATERAL (
            SELECT sizing_inputs FROM trading.capital_allocations ca
            WHERE ca.trade_intent_id = t.trade_intent_id
            ORDER BY ca.created_at DESC LIMIT 1
          ) a ON true
          WHERE t.user_id = $1 AND t.broker_connection_id = $2
            AND t.instrument = $3 AND t.status = 'CLOSED'
            AND t.commission IS NOT NULL
            AND t.swap IS NOT NULL
            AND t.closed_at < $4::timestamptz
            AND t.closed_at >= $4::timestamptz - interval '21 days'
          ORDER BY t.closed_at DESC, t.id DESC LIMIT 40
        ) historical
        WHERE fee_r IS NOT NULL AND fee_r >= 0
      `,
      [input.userId, input.brokerConnectionId, instrument, input.asOf.toISOString()],
    )) as Array<{ sample_count: number | string; p90_fee_r: number | string | null }>;
    const count = Number(rows[0]?.sample_count ?? 0);
    const p90 = nullableNumber(rows[0]?.p90_fee_r);
    return {
      sampleCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
      p90FeeR: p90 !== null && p90 >= 0 ? p90 : null,
    };
  }

  async loadLatestM5EarlyTransitionEvidence(input: {
    userId: string;
    instrument: string;
    direction: 'BUY' | 'SELL';
    asOf: Date;
  }): Promise<M5EarlyTransitionEvidence | null> {
    const instrument = input.instrument.trim().toUpperCase();
    const rows = (await this.dataSource.query(
      `
        SELECT
          instrument, direction, market_bar_time, evaluated_at,
          components ->> 'strategyRoute' AS strategy_route,
          COALESCE((components ->> 'paperAdmitted')::boolean, false) AS paper_admitted,
          COALESCE(
            (components -> 'governance' ->> 'paperExecutionEligible')::boolean,
            false
          ) AS paper_execution_eligible,
          COALESCE(components -> 'governance' ->> 'eventRisk', 'UNVERIFIED') AS event_risk,
          COALESCE(components -> 'governance' ->> 'driftState', 'UNKNOWN') AS drift_state,
          COALESCE(
            NULLIF(components -> 'governance' ->> 'netExpectedR', '')::numeric,
            expected_r
          ) AS net_expected_r,
          ensemble_score, consensus_passed, consensus_required
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND instrument = $2
          AND direction = $3
          AND components ->> 'strategyRoute' = 'EARLY_TRANSITION'
          AND evaluated_at <= $4::timestamptz
        ORDER BY evaluated_at DESC, created_at DESC
        LIMIT 1
      `,
      [input.userId, instrument, input.direction, input.asOf.toISOString()],
    )) as Array<{
      instrument: string;
      direction: 'BUY' | 'SELL';
      market_bar_time: string | Date;
      evaluated_at: string | Date;
      strategy_route: string;
      paper_admitted: boolean;
      paper_execution_eligible: boolean;
      event_risk: string;
      drift_state: string;
      net_expected_r: string | number;
      ensemble_score: string | number;
      consensus_passed: string | number;
      consensus_required: string | number;
    }>;
    const row = rows[0];
    if (!row) return null;
    const eventRisk =
      row.event_risk === 'CLEAR' ||
      row.event_risk === 'HIGH_IMPACT_BLOCK' ||
      row.event_risk === 'UNVERIFIED'
        ? row.event_risk
        : 'UNVERIFIED';
    return {
      instrument: String(row.instrument).trim().toUpperCase(),
      direction: row.direction,
      marketBarTime: date(row.market_bar_time),
      evaluatedAt: date(row.evaluated_at),
      strategyRoute: row.strategy_route,
      paperAdmitted: row.paper_admitted === true,
      paperExecutionEligible: row.paper_execution_eligible === true,
      eventRisk,
      driftState: row.drift_state,
      netExpectedR: number(row.net_expected_r),
      ensembleScore: number(row.ensemble_score),
      consensusPassed: number(row.consensus_passed),
      consensusRequired: number(row.consensus_required),
    };
  }

  async loadExtensionExhaustionShadowReliability(input: {
    userId: string;
    instrument: string;
    direction: 'BUY' | 'SELL';
    asOf: Date;
  }): Promise<ExtensionExhaustionShadowReliability> {
    const instrument = input.instrument.trim().toUpperCase();
    const rows = (await this.dataSource.query(
      `
        WITH candidates AS (
          SELECT
            evaluated_at,
            components -> 'outcome' ->> 'status' AS status,
            NULLIF(components -> 'outcome' ->> 'netR', '')::numeric AS net_r,
            FLOOR(EXTRACT(EPOCH FROM evaluated_at) / 900)::bigint AS episode_15m
          FROM trading.ensemble_shadow_decisions
          WHERE user_id = $1
            AND instrument = $2
            AND direction = $3
            AND evaluated_at <= $4::timestamptz
            AND evaluated_at >= $4::timestamptz - INTERVAL '7 days'
            AND components -> 'extensionExhaustionShadow' ->> 'artifact' = $5
            AND COALESCE(
              (components -> 'extensionExhaustionShadow' ->> 'candidate')::boolean,
              false
            ) = true
            AND components ? 'outcome'
            AND components -> 'outcome' ->> 'status' IN ('WIN', 'LOSS')
            AND NULLIF(components -> 'outcome' ->> 'netR', '') IS NOT NULL
        ), deduplicated AS (
          SELECT evaluated_at, status, net_r
          FROM (
            SELECT
              candidates.*,
              ROW_NUMBER() OVER (
                PARTITION BY episode_15m
                ORDER BY evaluated_at ASC
              ) AS episode_rank
            FROM candidates
          ) ranked
          WHERE episode_rank = 1
        )
        SELECT evaluated_at, status, net_r
        FROM deduplicated
        ORDER BY evaluated_at DESC
      `,
      [input.userId, instrument, input.direction, input.asOf, EXTENSION_EXHAUSTION_SHADOW_ARTIFACT],
    )) as Array<{
      evaluated_at: string | Date;
      status: 'WIN' | 'LOSS';
      net_r: string | number;
    }>;

    const netRs = rows.map((row) => Number(row.net_r)).filter((value) => Number.isFinite(value));
    if (netRs.length === 0) {
      return {
        samples: 0,
        wins: 0,
        losses: 0,
        totalNetR: 0,
        averageNetR: 0,
        profitFactor: null,
        recent3R: 0,
      };
    }
    const round = (value: number) => Number(value.toFixed(12));
    const wins = rows.filter(
      (row) => row.status === 'WIN' && Number.isFinite(Number(row.net_r)),
    ).length;
    const losses = rows.filter(
      (row) => row.status === 'LOSS' && Number.isFinite(Number(row.net_r)),
    ).length;
    const totalNetR = round(netRs.reduce((sum, value) => sum + value, 0));
    const grossProfitR = netRs.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLossR = Math.abs(
      netRs.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
    );
    return {
      samples: netRs.length,
      wins,
      losses,
      totalNetR,
      averageNetR: round(totalNetR / netRs.length),
      profitFactor: grossLossR > 0 ? round(grossProfitR / grossLossR) : null,
      recent3R: round(netRs.slice(0, 3).reduce((sum, value) => sum + value, 0)),
    };
  }

  async loadLatestDecisionStateForUser(
    userId: string,
    demoEntryInstruments: readonly string[] = [],
  ): Promise<M1TacticalLatestDecisionState | null> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          instrument, direction, route, bar_time, candidate, governance, blockers,
          execution_authority, outcome_state
        FROM trading.m1_tactical_decisions
        WHERE user_id = $1
        ORDER BY
          bar_time DESC,
          -- Always show real authorization first. Among same-bar
          -- nonexecuted decisions, prefer entry-eligible DEMO pairs.
          -- Research-only USDJPY/USDCAD/USDCHF must not displace an
          -- actionable same-minute AUDUSD/EURUSD/GBPUSD diagnosis.
          CASE WHEN execution_authority <> 'NONE' THEN 0 ELSE 1 END ASC,
          CASE
            WHEN CARDINALITY($2::text[]) > 0 AND NOT (instrument = ANY($2::text[]))
              THEN 1 ELSE 0
          END ASC,
          CASE WHEN route <> 'ABSTAIN' THEN 0 ELSE 1 END ASC,
          COALESCE((candidate ->> 'confidence')::numeric, 0) DESC,
          COALESCE((governance ->> 'netExpectedR')::numeric, -999999) DESC,
          created_at DESC
        LIMIT 1
      `,
      [userId, [...demoEntryInstruments]],
    )) as Array<{
      instrument: string;
      direction: 'BUY' | 'SELL';
      route: M1TacticalDecisionRoute;
      bar_time: string | Date;
      candidate: unknown;
      governance: unknown;
      blockers: unknown;
      execution_authority: M1TacticalDecisionAuthority;
      outcome_state: string | null;
    }>;
    const row = rows[0];
    if (!row) return null;
    const candidate = jsonObject(row.candidate);
    const governance = jsonObject(row.governance);
    const multimodelEnsemble = jsonObject(governance.multimodelEnsemble);
    const multimodelGovernance = jsonObject(governance.multimodelGovernance);
    const trainedExpert = jsonObject(governance.multimodelTrainedExpert);
    const multimodelAuthority = jsonObject(governance.multimodelAuthority);
    const zaiDemoDiagnostics = jsonObject(governance.zaiDemoDiagnostics);
    const blockerAttribution = jsonObject(zaiDemoDiagnostics.blockerAttribution);
    const costGeometry = jsonObject(zaiDemoDiagnostics.costGeometry);
    const costResearch = jsonObject(zaiDemoDiagnostics.historicalCommissionCostShadow);
    const m1Commission = jsonObject(costResearch.m1);
    const planBCommission = jsonObject(costResearch.planB);
    // Only accept the immutable blocked-DEMO shadow result; it cannot grant
    // execution authority and is never generated for an executable order.
    const trustedCostResearch =
      row.execution_authority === 'NONE' &&
      m1Commission.mode === 'SHADOW_ONLY' &&
      m1Commission.noTradeAuthority === true &&
      m1Commission.modifiesExecution === false;
    const validCostReason = new Set([
      'CAUSAL_FEE_EVIDENCE_READY',
      'INSUFFICIENT_PRIOR_CLOSED_TRADES',
      'INVALID_FEE_EVIDENCE',
      'FEE_LOOKUP_UNAVAILABLE',
      'INVALID_SPREAD_ONLY_EXPECTANCY',
    ]);
    const commissionReason = trustedCostResearch ? nullableString(m1Commission.reason) : null;
    const commissionReady = commissionReason === 'CAUSAL_FEE_EVIDENCE_READY';
    const commissionCount = nullableNumber(m1Commission.sampleCount);
    const trainedDirection = nullableString(trainedExpert.direction);
    return {
      instrument: String(row.instrument).trim().toUpperCase(),
      direction: row.direction,
      route: row.route,
      barTime: date(row.bar_time).toISOString(),
      confidence: number(candidate.confidence),
      netExpectedR: number(governance.netExpectedR),
      executionAuthority: row.execution_authority,
      blockers: blockers(row.blockers),
      outcomeState: row.outcome_state ?? null,
      primaryEngineCode: nullableString(governance.primaryEngineCode),
      primaryConfidence: nullableNumber(multimodelEnsemble.ensembleScore),
      primaryNetExpectedR: nullableNumber(multimodelGovernance.netExpectedR),
      planBRoute: nullableString(multimodelEnsemble.strategyRoute),
      planBRegime: nullableString(multimodelEnsemble.regime),
      planBRegimeAllowed:
        typeof multimodelEnsemble.regimeAllowed === 'boolean'
          ? multimodelEnsemble.regimeAllowed
          : null,
      planBPaperAdmitted:
        typeof multimodelEnsemble.paperAdmitted === 'boolean'
          ? multimodelEnsemble.paperAdmitted
          : null,
      multimodelExecutable:
        typeof multimodelAuthority.executable === 'boolean' ? multimodelAuthority.executable : null,
      multimodelAuthorityPath: nullableString(multimodelAuthority.authorityPath),
      multimodelRescueVolumeCap: nullableNumber(multimodelAuthority.rescueVolumeCap),
      trainedExpertState: nullableString(trainedExpert.state),
      trainedExpertReason: nullableString(trainedExpert.reason),
      trainedExpertDirection:
        trainedDirection === 'BUY' || trainedDirection === 'SELL' ? trainedDirection : null,
      trainedExpertConfidence: nullableNumber(trainedExpert.ensembleConfidence),
      trainedExpertLongVotes: nullableNumber(trainedExpert.longVotes),
      trainedExpertShortVotes: nullableNumber(trainedExpert.shortVotes),
      m1TacticalRole: nullableString(governance.m1TacticalRole),
      m1TimingRoute: row.route,
      m1TimingReason: nullableString(jsonObject(governance.routeDecision).reason),
      primaryBlockerGroup: nullableString(blockerAttribution.primaryGroup),
      primaryBlockerCode: nullableString(blockerAttribution.primaryCode),
      modelDriftState: nullableString(multimodelGovernance.driftState),
      modelDriftDiagnostics: blockers(multimodelGovernance.driftDiagnostics)
        .filter((item) =>
          /^(confidence|extensionAtr|volatilityScore|emaSeparation|mtfStrength|rsi14|directionalMomentumAtr):(INVALID|HARD_LOW|HARD_HIGH|STRESSED_LOW|STRESSED_HIGH)$/.test(
            item,
          ),
        )
        .slice(0, 8),
      brokerCommissionResearchReason:
        commissionReason && validCostReason.has(commissionReason) ? commissionReason : null,
      brokerCommissionSampleCount:
        trustedCostResearch &&
        commissionCount !== null &&
        Number.isInteger(commissionCount) &&
        commissionCount >= 0 &&
        commissionCount <= 40
          ? commissionCount
          : null,
      brokerCommissionP90CostR: commissionReady
        ? nullableNumber(m1Commission.p90AdditionalCommissionAndAdverseFinancingR)
        : null,
      m1EstimatedNetAfterCommissionR: commissionReady
        ? nullableNumber(m1Commission.estimatedNetAfterFeeR)
        : null,
      planBEstimatedNetAfterCommissionR:
        commissionReady &&
        planBCommission.mode === 'SHADOW_ONLY' &&
        planBCommission.noTradeAuthority === true &&
        planBCommission.modifiesExecution === false &&
        planBCommission.reason === 'CAUSAL_FEE_EVIDENCE_READY'
          ? nullableNumber(planBCommission.estimatedNetAfterFeeR)
          : null,
      demoCostBreakEvenStopPrice: nullableNumber(costGeometry.costBreakEvenStopPriceAt010R),
      demoAlternativeCostR: nullableNumber(costGeometry.hypotheticalCostR),
    };
  }

  async recordDecision(input: M1TacticalDecisionInput): Promise<M1TacticalDecisionRecord> {
    const instrument = input.instrument.trim().toUpperCase();
    const evaluatedAt = input.evaluatedAt ?? new Date();
    const rows = (await this.dataSource.query(
      `
        INSERT INTO trading.m1_tactical_decisions (
          user_id, broker_connection_id, instrument, direction, route,
          bar_time, policy_version, execution_authority,
          candidate, governance, blockers, evaluated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)
        ON CONFLICT (
          user_id, broker_connection_id, instrument, direction, route, bar_time, policy_version
        ) DO UPDATE SET updated_at = trading.m1_tactical_decisions.updated_at
        RETURNING
          id, user_id, broker_connection_id, instrument, direction, route, bar_time,
          policy_version, execution_authority, blockers, signal_id, trade_intent_id,
          outcome_state, outcome_reason, outcome_observed_at, created_at, updated_at
      `,
      [
        input.userId,
        input.brokerConnectionId,
        instrument,
        input.direction,
        input.route,
        input.barTime.toISOString(),
        input.policyVersion,
        input.executionAuthority,
        JSON.stringify(input.candidate),
        JSON.stringify(input.governance),
        JSON.stringify(input.blockers),
        evaluatedAt.toISOString(),
      ],
    )) as DecisionRow[];
    const row = rows[0];
    if (!row) throw new Error('M1 tactical decision persistence returned no row');
    return this.toRecord(row);
  }

  async loadRoutePairSideEvidence(
    input: M1RoutePairSideEvidenceQuery,
  ): Promise<M1RoutePairSideEvidenceRow[]> {
    const instrument = input.instrument.trim().toUpperCase();
    const policies = [...new Set(input.compatiblePolicyVersions.filter(Boolean))];
    if (!policies.includes(input.currentPolicyVersion))
      policies.unshift(input.currentPolicyVersion);
    const rows = (await this.dataSource.query(
      `
        SELECT
          d.route,
          d.instrument,
          d.direction,
          d.policy_version,
          t.realised_pnl,
          t.lot_size,
          t.fill_price,
          t.stop_loss,
          COALESCE(
            t.max_favorable_pnl,
            NULLIF(ti.metadata->'reconstructed_path_v1'->>'maxFavorablePnl', '')::numeric
          ) AS max_favorable_pnl,
          COALESCE(
            t.profit_giveback,
            NULLIF(ti.metadata->'reconstructed_path_v1'->>'profitGiveback', '')::numeric
          ) AS profit_giveback,
          NULLIF(ca.sizing_inputs->>'finalRiskAtStop', '') AS risk_at_stop_account,
          t.closed_at
        FROM trading.m1_tactical_decisions d
        JOIN trading.trade_intents ti
          ON ti.user_id = d.user_id
         AND ti.broker_connection_id = d.broker_connection_id
         AND (
           ti.id = d.trade_intent_id
           OR (d.trade_intent_id IS NULL AND d.signal_id IS NOT NULL AND ti.signal_id = d.signal_id)
         )
        JOIN trading.trades t
          ON t.trade_intent_id = ti.id
         AND t.user_id = d.user_id
         AND t.broker_connection_id = d.broker_connection_id
        LEFT JOIN LATERAL (
          SELECT ca0.sizing_inputs
          FROM trading.capital_allocations ca0
          WHERE ca0.trade_intent_id = t.trade_intent_id
          ORDER BY ca0.created_at DESC
          LIMIT 1
        ) ca ON true
        WHERE d.user_id = $1
          AND d.broker_connection_id = $2
          AND d.route = $3
          AND d.instrument = $4
          AND d.direction = $5
          AND d.policy_version = ANY($6::text[])
          AND t.status = 'CLOSED'
          AND t.realised_pnl IS NOT NULL
          AND t.realised_pnl <> 0
          AND t.closed_at IS NOT NULL
          AND t.closed_at <= $7::timestamptz
          AND t.closed_at > ($7::timestamptz - interval '7 days')
        ORDER BY (d.policy_version = $8) DESC, t.closed_at DESC
        LIMIT 20
      `,
      [
        input.userId,
        input.brokerConnectionId,
        input.route,
        instrument,
        input.direction,
        policies,
        input.evaluatedAt.toISOString(),
        input.currentPolicyVersion,
      ],
    )) as Array<{
      route: M1ReliabilityRoute;
      instrument: string;
      direction: 'BUY' | 'SELL';
      policy_version: string;
      realised_pnl: string | number;
      lot_size: string | number | null;
      fill_price: string | number | null;
      stop_loss: string | number | null;
      max_favorable_pnl: string | number | null;
      profit_giveback: string | number | null;
      risk_at_stop_account: string | number | null;
      closed_at: string | Date;
    }>;
    return rows.map((row) => ({
      route: row.route,
      instrument: row.instrument,
      direction: row.direction,
      policyVersion: row.policy_version,
      realisedPnl: number(row.realised_pnl),
      riskAtStop:
        number(row.risk_at_stop_account) ??
        m1UsdRiskAtStop({
          instrument: row.instrument,
          lotSize: number(row.lot_size),
          entryPrice: number(row.fill_price),
          stopLoss: number(row.stop_loss),
        }),
      maxFavorablePnl: number(row.max_favorable_pnl),
      profitGiveback: number(row.profit_giveback),
      closedAt: date(row.closed_at),
    }));
  }

  /**
   * Additional FULL_AUTO DEMO entry protection: net results after broker
   * costs across *all instruments/routes* and recent FULL_AUTO sessions of
   * the exact same user, DEMO broker connection and account currency.
   * The current ACTIVE session is required as authority; a Stop/Start must
   * NOT reset a still-recent losing streak. Never mix different accounts.
   */
  async loadPortfolioNetLossStreakBrake(input: {
    userId: string;
    brokerConnectionId: string;
    tradingSessionId: string;
    evaluatedAt: Date;
  }) {
    const rows = (await this.dataSource.query(
      `
        SELECT
          t.realised_pnl,
          t.commission,
          t.swap,
          t.account_currency,
          active.account_currency AS session_currency,
          t.closed_at
        FROM trading.trades t
        JOIN trading.trading_sessions s
          ON s.id = t.trading_session_id
         AND s.user_id = t.user_id
         AND s.broker_connection_id = t.broker_connection_id
        JOIN trading.trading_sessions active
          ON active.id = $3
         AND active.user_id = t.user_id
         AND active.broker_connection_id = t.broker_connection_id
         AND active.status = 'ACTIVE'
         AND active.execution_mode = 'FULL_AUTO'
        JOIN broker.broker_connections bc
          ON bc.id = t.broker_connection_id
         AND bc.user_id = t.user_id
         AND bc.account_type = 'DEMO'
         AND bc.account_currency = active.account_currency
        WHERE t.user_id = $1
          AND t.broker_connection_id = $2
          AND s.execution_mode = 'FULL_AUTO'
          AND s.account_currency = active.account_currency
          AND t.status = 'CLOSED'
          AND t.closed_at IS NOT NULL
          AND t.closed_at <= $4::timestamptz
          AND t.closed_at > ($4::timestamptz - interval '${M1_PORTFOLIO_NET_LOSS_BRAKE_LOOKBACK_HOURS} hours')
        ORDER BY t.closed_at DESC, t.id DESC
        LIMIT ${M1_PORTFOLIO_NET_LOSS_BRAKE_REQUIRED_LOSSES}
      `,
      [
        input.userId,
        input.brokerConnectionId,
        input.tradingSessionId,
        input.evaluatedAt.toISOString(),
      ],
    )) as Array<{
      realised_pnl: string | null;
      commission: string | null;
      swap: string | null;
      account_currency: string | null;
      session_currency: string | null;
      closed_at: Date | string;
    }>;
    return evaluateM1PortfolioNetLossBrake({
      evaluatedAt: input.evaluatedAt,
      rows: rows.map((row) => ({
        realisedPnl: row.realised_pnl,
        commission: row.commission,
        swap: row.swap,
        accountCurrency: row.account_currency,
        sessionCurrency: row.session_currency,
        closedAt: new Date(row.closed_at),
      })),
    });
  }

  async loadMultimodelLossStreakBrake(
    input: M1MultimodelLossStreakBrakeQuery,
  ): Promise<M1MultimodelLossStreakBrakeDecision> {
    const instrument = input.instrument.trim().toUpperCase();
    const rows = (await this.dataSource.query(
      `
        SELECT t.realised_pnl, t.closed_at
        FROM trading.trades t
        JOIN trading.trade_intents ti
          ON ti.id = t.trade_intent_id
         AND ti.user_id = t.user_id
         AND ti.broker_connection_id = t.broker_connection_id
        JOIN trading.m1_tactical_decisions d
          ON d.trade_intent_id = ti.id
         AND d.user_id = t.user_id
         AND d.broker_connection_id = t.broker_connection_id
        WHERE t.user_id = $1
          AND t.broker_connection_id = $2
          AND t.instrument = $3
          AND t.direction = $4
          AND d.governance -> 'multimodelEnsemble' ->> 'strategyRoute' = $5
          AND ti.strategy_code = 'external-irexpro-multimodel-ensemble'
          AND ti.timeframe = 'M1'
          AND ti.metadata ->> 'external_provider_paper_only' = 'true'
          AND t.status = 'CLOSED'
          AND t.realised_pnl IS NOT NULL
          AND t.closed_at IS NOT NULL
          AND t.closed_at <= $6::timestamptz
          AND t.closed_at > ($6::timestamptz - interval '14 days')
        ORDER BY t.closed_at DESC
        LIMIT ${M1_MULTIMODEL_PAYOFF_WINDOW_TRADES}
      `,
      [
        input.userId,
        input.brokerConnectionId,
        instrument,
        input.direction,
        input.strategyRoute,
        input.evaluatedAt.toISOString(),
      ],
    )) as Array<{ realised_pnl: string | number; closed_at: string | Date }>;

    const payoffRows = rows.map((row) => ({
      pnl: number(row.realised_pnl),
      closedAt: date(row.closed_at),
    }));
    const recentCutoffMs =
      input.evaluatedAt.getTime() - M1_MULTIMODEL_LOSS_STREAK_WINDOW_HOURS * 60 * 60_000;
    const recentRows = payoffRows.filter((row) => row.closedAt.getTime() > recentCutoffMs);
    const recentPnlValues = recentRows.map((row) => row.pnl);
    const payoffPnlValues = payoffRows.map((row) => row.pnl);
    const recentLosses = recentPnlValues.filter((value) => value < 0).length;
    const recentWins = recentPnlValues.filter((value) => value > 0).length;
    const cumulativeRealisedPnl =
      Math.round(recentPnlValues.reduce((sum, value) => sum + value, 0) * 100) / 100;
    const recentGrossProfit = recentPnlValues
      .filter((value) => value > 0)
      .reduce((sum, value) => sum + value, 0);
    const recentGrossLoss = -recentPnlValues
      .filter((value) => value < 0)
      .reduce((sum, value) => sum + value, 0);
    const recentProfitFactor =
      recentGrossLoss > 0 ? recentGrossProfit / recentGrossLoss : recentGrossProfit > 0 ? null : 0;
    const negativePayoff =
      recentRows.length >= M1_MULTIMODEL_NEGATIVE_PAYOFF_MIN_TRADES &&
      cumulativeRealisedPnl < 0 &&
      recentProfitFactor !== null &&
      recentProfitFactor < M1_MULTIMODEL_NEGATIVE_PAYOFF_MAX_PROFIT_FACTOR;

    const payoffCumulativeRealisedPnl =
      Math.round(payoffPnlValues.reduce((sum, value) => sum + value, 0) * 100) / 100;
    const payoffGrossProfit = payoffPnlValues
      .filter((value) => value > 0)
      .reduce((sum, value) => sum + value, 0);
    const payoffGrossLoss = -payoffPnlValues
      .filter((value) => value < 0)
      .reduce((sum, value) => sum + value, 0);
    const profitFactor =
      payoffGrossLoss > 0 ? payoffGrossProfit / payoffGrossLoss : payoffGrossProfit > 0 ? null : 0;
    const latestClosedAt = payoffRows[0]?.closedAt ?? null;
    const persistentEvidenceAgeHours = latestClosedAt
      ? Math.max(0, (input.evaluatedAt.getTime() - latestClosedAt.getTime()) / (60 * 60_000))
      : Number.POSITIVE_INFINITY;
    const persistentNegativePayoffMinTrades =
      input.strategyRoute === 'CONFIRMED_REVERSAL'
        ? M1_MULTIMODEL_CONFIRMED_REVERSAL_PERSISTENT_NEGATIVE_PAYOFF_MIN_TRADES
        : M1_MULTIMODEL_PERSISTENT_NEGATIVE_PAYOFF_MIN_TRADES;
    const persistentNegativePayoffMaxProfitFactor =
      input.strategyRoute === 'CONFIRMED_REVERSAL'
        ? M1_MULTIMODEL_CONFIRMED_REVERSAL_PERSISTENT_NEGATIVE_PAYOFF_MAX_PROFIT_FACTOR
        : M1_MULTIMODEL_PERSISTENT_NEGATIVE_PAYOFF_MAX_PROFIT_FACTOR;
    const persistentNegativePayoff =
      payoffRows.length >= persistentNegativePayoffMinTrades &&
      payoffCumulativeRealisedPnl < 0 &&
      profitFactor !== null &&
      profitFactor < persistentNegativePayoffMaxProfitFactor &&
      persistentEvidenceAgeHours <= M1_MULTIMODEL_PERSISTENT_NEGATIVE_PAYOFF_MAX_AGE_HOURS;

    const cooldownUntilMs = latestClosedAt
      ? latestClosedAt.getTime() + M1_MULTIMODEL_LOSS_STREAK_COOLDOWN_HOURS * 60 * 60_000
      : 0;
    const cooldownRemainingSeconds = latestClosedAt
      ? Math.max(0, Math.ceil((cooldownUntilMs - input.evaluatedAt.getTime()) / 1000))
      : 0;
    const latestThree = recentPnlValues.slice(0, M1_MULTIMODEL_LOSS_STREAK_MIN_CLOSED_TRADES);
    const lossStreak =
      latestThree.length === M1_MULTIMODEL_LOSS_STREAK_MIN_CLOSED_TRADES &&
      latestThree.every((value) => value < 0);
    const recentBrakeActive = (lossStreak || negativePayoff) && cooldownRemainingSeconds > 0;
    const active = recentBrakeActive || persistentNegativePayoff;
    const reason: M1MultimodelLossStreakBrakeDecision['reason'] = !active
      ? 'CLEAR'
      : recentBrakeActive && lossStreak
        ? 'RECENT_MULTIMODEL_LOSS_STREAK'
        : recentBrakeActive && negativePayoff
          ? 'RECENT_NEGATIVE_PAYOFF'
          : 'PERSISTENT_NEGATIVE_PAYOFF';

    return {
      artifact: M1_MULTIMODEL_LOSS_STREAK_BRAKE_ARTIFACT,
      active,
      reason,
      strategyRoute: input.strategyRoute,
      recentClosedTrades: recentRows.length,
      payoffClosedTrades: payoffRows.length,
      recentLosses,
      recentWins,
      cumulativeRealisedPnl,
      profitFactor,
      negativePayoff,
      persistentNegativePayoff,
      latestClosedAt,
      cooldownHours: M1_MULTIMODEL_LOSS_STREAK_COOLDOWN_HOURS,
      cooldownRemainingSeconds,
    };
  }

  async loadFastStopRegimeBrake(
    input: M1FastStopRegimeBrakeQuery,
  ): Promise<M1FastStopRegimeBrakeDecision> {
    const instrument = input.instrument.trim().toUpperCase();
    const cooldownSeconds = M1_FAST_STOP_COOLDOWN_MINUTES * 60;
    const maxStopDurationSeconds = M1_FAST_STOP_MAX_DURATION_MINUTES * 60;
    const rows = (await this.dataSource.query(
      `
        SELECT
          t.closed_at,
          EXTRACT(EPOCH FROM (t.closed_at - t.opened_at)) / 60.0 AS duration_minutes
        FROM trading.trades t
        JOIN trading.trade_intents ti
          ON ti.id = t.trade_intent_id
         AND ti.user_id = t.user_id
         AND ti.broker_connection_id = t.broker_connection_id
        WHERE t.user_id = $1
          AND t.broker_connection_id = $2
          AND t.instrument = $3
          AND t.direction = $4
          AND ti.strategy_code IN ('external-irexpro-m1-tactical', 'external-irexpro-multimodel-ensemble')
          AND ti.timeframe = 'M1'
          AND ti.metadata ->> 'external_provider_paper_only' = 'true'
          AND t.status = 'CLOSED'
          AND t.close_reason = 'STOP_LOSS_HIT'
          AND t.opened_at IS NOT NULL
          AND t.closed_at IS NOT NULL
          AND t.closed_at <= $5::timestamptz
          AND t.closed_at > ($5::timestamptz - ($6::double precision * interval '1 second'))
          AND EXTRACT(EPOCH FROM (t.closed_at - t.opened_at)) >= 0
          AND EXTRACT(EPOCH FROM (t.closed_at - t.opened_at)) <= $7
        ORDER BY t.closed_at DESC
        LIMIT 1
      `,
      [
        input.userId,
        input.brokerConnectionId,
        instrument,
        input.direction,
        input.evaluatedAt.toISOString(),
        cooldownSeconds,
        maxStopDurationSeconds,
      ],
    )) as Array<{ closed_at: string | Date; duration_minutes: string | number }>;

    const row = rows[0];
    if (!row) {
      return {
        artifact: M1_FAST_STOP_REGIME_BRAKE_ARTIFACT,
        active: false,
        reason: 'CLEAR',
        latestFastStopClosedAt: null,
        latestFastStopDurationMinutes: null,
        cooldownMinutes: M1_FAST_STOP_COOLDOWN_MINUTES,
        maxStopDurationMinutes: M1_FAST_STOP_MAX_DURATION_MINUTES,
        cooldownRemainingSeconds: 0,
      };
    }

    const latestFastStopClosedAt = date(row.closed_at);
    const latestFastStopDurationMinutes = number(row.duration_minutes);
    const cooldownUntilMs =
      latestFastStopClosedAt.getTime() + M1_FAST_STOP_COOLDOWN_MINUTES * 60_000;
    const cooldownRemainingSeconds = Math.max(
      0,
      Math.ceil((cooldownUntilMs - input.evaluatedAt.getTime()) / 1000),
    );
    return {
      artifact: M1_FAST_STOP_REGIME_BRAKE_ARTIFACT,
      active: cooldownRemainingSeconds > 0,
      reason: cooldownRemainingSeconds > 0 ? 'RECENT_FAST_STOP' : 'CLEAR',
      latestFastStopClosedAt,
      latestFastStopDurationMinutes,
      cooldownMinutes: M1_FAST_STOP_COOLDOWN_MINUTES,
      maxStopDurationMinutes: M1_FAST_STOP_MAX_DURATION_MINUTES,
      cooldownRemainingSeconds,
    };
  }

  async loadOpenPaperRiskPositions(
    input: M1OpenPaperRiskPositionQuery,
  ): Promise<M1OpenPaperRiskPositionSnapshot[]> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          t.instrument,
          t.direction,
          t.lot_size,
          t.fill_price,
          t.stop_loss
        FROM trading.trades t
        JOIN trading.trade_intents ti
          ON ti.id = t.trade_intent_id
         AND ti.user_id = t.user_id
         AND ti.broker_connection_id = t.broker_connection_id
        WHERE t.user_id = $1
          AND t.broker_connection_id = $2
          AND t.status = 'OPEN'
          AND ti.strategy_code LIKE 'external-irexpro-%'
          AND ti.timeframe IN ('M1', 'M5')
          AND ti.metadata ->> 'external_provider_paper_only' = 'true'
        ORDER BY t.opened_at ASC
      `,
      [input.userId, input.brokerConnectionId],
    )) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const instrument = String(row.instrument ?? '')
        .trim()
        .toUpperCase();
      const direction = String(row.direction ?? '') as 'BUY' | 'SELL';
      const lotSize = Number(row.lot_size);
      const entryPrice = Number(row.fill_price);
      const stopLoss = Number(row.stop_loss);
      const riskAtStop = ['BUY', 'SELL'].includes(direction)
        ? m1UsdRiskAtStop({ instrument, lotSize, entryPrice, stopLoss })
        : null;
      return { instrument, direction, lotSize, riskAtStop };
    });
  }

  async loadOpenPaperPositions(
    input: M1OpenPaperPositionQuery,
  ): Promise<M1OpenPaperPositionSnapshot[]> {
    const instrument = input.instrument.trim().toUpperCase();
    const rows = (await this.dataSource.query(
      `
        SELECT
          t.id AS trade_id,
          t.trade_intent_id,
          t.instrument,
          t.direction,
          t.opened_at,
          ti.metadata ->> 'm1_decision_id' AS decision_id,
          ti.metadata ->> 'm1_tactical_route' AS route,
          ti.metadata ->> 'm1_policy_version' AS policy_version,
          ti.metadata ->> 'm1_net_expected_r' AS original_net_expected_r
        FROM trading.trades t
        JOIN trading.trade_intents ti
          ON ti.id = t.trade_intent_id
         AND ti.user_id = t.user_id
         AND ti.broker_connection_id = t.broker_connection_id
        WHERE t.user_id = $1
          AND t.broker_connection_id = $2
          AND t.instrument = $3
          AND t.status = 'OPEN'
          AND ti.strategy_code IN ('external-irexpro-m1-tactical', 'external-irexpro-multimodel-ensemble')
          AND ti.timeframe = 'M1'
          AND ti.metadata ->> 'external_provider_paper_only' = 'true'
        ORDER BY t.opened_at ASC
      `,
      [input.userId, input.brokerConnectionId, instrument],
    )) as Array<Record<string, unknown>>;
    const validRoutes = new Set<M1ReliabilityRoute>([
      'M1_TREND_CONTINUATION',
      'M1_CONFIRMED_REVERSAL',
      'M1_EARLY_TRANSITION',
    ]);
    return rows.flatMap((row) => {
      const route = String(row.route ?? '') as M1ReliabilityRoute;
      const direction = String(row.direction ?? '') as 'BUY' | 'SELL';
      const openedAt = date(row.opened_at as string | Date);
      const originalNetExpectedR = number(row.original_net_expected_r);
      const tradeId = String(row.trade_id ?? '');
      const tradeIntentId = String(row.trade_intent_id ?? '');
      const decisionId = String(row.decision_id ?? '');
      const policyVersion = String(row.policy_version ?? '');
      if (
        !tradeId ||
        !tradeIntentId ||
        !decisionId ||
        !policyVersion ||
        !validRoutes.has(route) ||
        !['BUY', 'SELL'].includes(direction) ||
        !Number.isFinite(openedAt.getTime()) ||
        !Number.isFinite(originalNetExpectedR)
      ) {
        return [];
      }
      return [
        {
          tradeId,
          tradeIntentId,
          instrument: String(row.instrument ?? instrument).toUpperCase(),
          direction,
          openedAt,
          decisionId,
          route,
          policyVersion,
          originalNetExpectedR,
        },
      ];
    });
  }

  async hasActiveM1Intent(input: M1ActiveIntentQuery): Promise<boolean> {
    const instrument = input.instrument.trim().toUpperCase();
    const rows = (await this.dataSource.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM trading.trade_intents ti
          LEFT JOIN trading.trades t
            ON t.id = ti.trade_id
           AND t.user_id = ti.user_id
           AND t.broker_connection_id = ti.broker_connection_id
          WHERE ti.user_id = $1
            AND ti.broker_connection_id = $2
            AND ti.instrument = $3
            AND ti.direction = $4
            AND ti.strategy_code IN ('external-irexpro-m1-tactical', 'external-irexpro-multimodel-ensemble')
            AND ti.timeframe = 'M1'
            AND (
              ti.status = 'CREATED'
              OR (ti.status = 'EXECUTED' AND t.status = 'OPEN')
            )
        ) AS exists
      `,
      [input.userId, input.brokerConnectionId, instrument, input.direction],
    )) as Array<{ exists: boolean }>;
    return rows[0]?.exists === true;
  }

  async hasActiveOppositeM1Intent(input: M1ActiveOppositeIntentQuery): Promise<boolean> {
    return this.hasActiveM1Intent(input);
  }

  async loadShadowPairSideOutcomes(
    input: M1ShadowPairSideOutcomeQuery,
  ): Promise<M1ShadowPairSideOutcome[]> {
    const instrument = input.instrument.trim().toUpperCase();
    const rows = (await this.dataSource.query(
      `
        SELECT
          governance -> 'shadowOutcome15mV1' ->> 'observedAt' AS observed_at,
          governance -> 'shadowOutcome15mV1' ->> 'netRMultiple' AS net_r_multiple
        FROM trading.m1_tactical_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND route = $3
          AND instrument = $4
          AND direction = $5
          AND policy_version = $6
          AND execution_authority = 'NONE'
          AND governance -> 'shadowOutcome15mV1' ->> 'artifact' = $7
          AND governance -> 'shadowOutcome15mV1' ->> 'netRMultiple' IS NOT NULL
          AND governance -> 'shadowOutcome15mV1' ->> 'outcome' IN ('TP', 'SL', 'MTM')
          AND (governance -> 'shadowOutcome15mV1' ->> 'observedAt')::timestamptz <= $8::timestamptz
          AND evaluated_at >= ($8::timestamptz - interval '7 days')
        ORDER BY observed_at DESC
        LIMIT 20
      `,
      [
        input.userId,
        input.brokerConnectionId,
        input.route,
        instrument,
        input.direction,
        input.policyVersion,
        M1_SHADOW_OUTCOME_15M_ARTIFACT,
        input.evaluatedAt.toISOString(),
      ],
    )) as Array<{ observed_at: string | Date; net_r_multiple: string | number }>;

    return rows.flatMap((row) => {
      const observedAt = date(row.observed_at);
      const netR = Number(row.net_r_multiple);
      if (!Number.isFinite(observedAt.getTime()) || !Number.isFinite(netR)) return [];
      return [{ observedAt, netR }];
    });
  }

  async loadMatureShadowEpisodeLeaders(
    input: M1ShadowEpisodeLeaderQuery,
  ): Promise<M1ShadowEpisodeLeader[]> {
    const instrument = input.instrument.trim().toUpperCase();
    const rows = (await this.dataSource.query(
      `
        WITH eligible AS (
          SELECT
            id,
            user_id,
            broker_connection_id,
            instrument,
            direction,
            route,
            bar_time,
            evaluated_at,
            policy_version,
            candidate,
            governance,
            LAG(bar_time) OVER (
              PARTITION BY user_id, broker_connection_id, instrument, direction, route, policy_version
              ORDER BY bar_time ASC
            ) AS previous_bar_time
          FROM trading.m1_tactical_decisions
          WHERE user_id = $1
            AND broker_connection_id = $2
            AND instrument = $3
            AND policy_version = $4
            AND route <> 'ABSTAIN'
            AND execution_authority = 'NONE'
            AND (
              governance ->> 'shadowOutcomeEligible' = 'true'
              OR blockers = '[]'::jsonb
              OR blockers = '["M1_PHASE_SHADOW"]'::jsonb
            )
        ),
        episode_marked AS (
          SELECT
            *,
            CASE
              WHEN previous_bar_time IS NULL
                OR bar_time - previous_bar_time > interval '5 minutes'
              THEN 1
              ELSE 0
            END AS episode_start
          FROM eligible
        ),
        leaders AS (
          SELECT *
          FROM episode_marked
          WHERE episode_start = 1
        )
        SELECT
          id,
          instrument,
          direction,
          route,
          bar_time,
          evaluated_at,
          policy_version,
          candidate,
          governance
        FROM leaders
        WHERE governance -> 'shadowOutcome15mV1' IS NULL
          AND evaluated_at <= ($5::timestamptz - interval '16 minutes')
        ORDER BY evaluated_at ASC
        LIMIT 100
      `,
      [
        input.userId,
        input.brokerConnectionId,
        instrument,
        input.policyVersion,
        input.asOf.toISOString(),
      ],
    )) as Array<{
      id: string;
      instrument: string;
      direction: 'BUY' | 'SELL';
      route: M1ReliabilityRoute;
      bar_time: string | Date;
      evaluated_at: string | Date;
      policy_version: string;
      candidate: unknown;
      governance: unknown;
    }>;

    const validRoutes = new Set<M1ReliabilityRoute>([
      'M1_TREND_CONTINUATION',
      'M1_CONFIRMED_REVERSAL',
      'M1_EARLY_TRANSITION',
    ]);
    return rows.flatMap((row) => {
      if (!validRoutes.has(row.route)) return [];
      const candidate = jsonObject(row.candidate);
      const governance = jsonObject(row.governance);
      const genericGovernance = jsonObject(governance.genericGovernance);
      const stopDistance = number(candidate.stopDistance);
      const targetDistance = number(candidate.targetDistance);
      const rawExecutionCostR = genericGovernance.estimatedExecutionCostR;
      const estimatedExecutionCostR = Number(rawExecutionCostR);
      const barTime = date(row.bar_time);
      const evaluatedAt = date(row.evaluated_at);
      if (
        stopDistance <= 0 ||
        targetDistance <= 0 ||
        rawExecutionCostR === null ||
        rawExecutionCostR === undefined ||
        rawExecutionCostR === '' ||
        !Number.isFinite(estimatedExecutionCostR) ||
        estimatedExecutionCostR < 0 ||
        !Number.isFinite(barTime.getTime()) ||
        !Number.isFinite(evaluatedAt.getTime())
      ) {
        return [];
      }
      return [
        {
          id: row.id,
          instrument: row.instrument.trim().toUpperCase(),
          direction: row.direction,
          route: row.route,
          barTime,
          evaluatedAt,
          policyVersion: row.policy_version,
          stopDistance,
          targetDistance,
          estimatedExecutionCostR,
          executionCostSource:
            typeof genericGovernance.executionCostSource === 'string'
              ? genericGovernance.executionCostSource
              : null,
          rolloutPhase:
            typeof governance.rolloutPhase === 'string' ? governance.rolloutPhase : null,
        },
      ];
    });
  }

  async markShadowOutcome15mV1(decisionId: string, outcome: M1ShadowOutcome15mV1): Promise<void> {
    const payload: M1ShadowOutcome15mV1 = {
      ...outcome,
      artifact: M1_SHADOW_OUTCOME_15M_ARTIFACT,
      modifiesExecution: false,
    };
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET governance = jsonb_set(governance, '{shadowOutcome15mV1}', $2::jsonb, true),
            updated_at = now()
        WHERE id = $1
          AND governance -> 'shadowOutcome15mV1' IS NULL
      `,
      [decisionId, JSON.stringify(payload)],
    );
  }

  /**
   * Research-only fixed UTC-16m cohort. Group the oldest study-eligible event in
   * each pair/direction/episode before maturity filtering so a later scan
   * cannot silently replace an episode leader when a time cutoff advances.
   * No broker order, grant or production model promotion path reads this.
   */
  async loadMatureLowVolRangeLeaders(input: {
    userId: string;
    brokerConnectionId: string;
    instrument: string;
    policyVersion: string;
    asOf: Date;
  }): Promise<
    Array<{
      id: string;
      direction: 'BUY' | 'SELL';
      evaluatedAt: Date;
      stopDistance: number;
      targetDistance: number;
      observedExecutionCostR: number;
      hypothesisCohort: 'STABILIZED_ENTRY_HYPOTHESIS' | 'UNSTABLE_MOMENTUM_CONTROL';
    }>
  > {
    const rows = (await this.dataSource.query(
      `
        WITH annotated AS (
          SELECT id, instrument, direction, evaluated_at, governance,
                 ROW_NUMBER() OVER (
                   PARTITION BY instrument, direction,
                     governance -> 'lowVolRangeShadow' ->> 'hypothesisCohort',
                     FLOOR(EXTRACT(EPOCH FROM evaluated_at) / ${LOW_VOL_RANGE_EPISODE_MINUTES * 60})::bigint
                   ORDER BY evaluated_at ASC, id ASC
                 ) AS episode_rank
          FROM trading.m1_tactical_decisions
          WHERE user_id = $1
            AND broker_connection_id = $2
            AND instrument = $3
            AND policy_version = $4
            AND execution_authority = 'NONE'
            AND governance -> 'lowVolRangeShadow' ->> 'artifact' = $6
            AND governance -> 'lowVolRangeShadow' ->> 'outcomeStudyEligible' = 'true'
            AND evaluated_at >= TO_TIMESTAMP(
              FLOOR(EXTRACT(EPOCH FROM ($5::timestamptz - interval '90 minutes')) / ${LOW_VOL_RANGE_EPISODE_MINUTES * 60})
              * ${LOW_VOL_RANGE_EPISODE_MINUTES * 60}
            )
            AND evaluated_at <= ($5::timestamptz - interval '16 minutes')
        )
        SELECT id, direction, evaluated_at,
               governance -> 'lowVolRangeShadow' AS research
        FROM annotated
        WHERE episode_rank = 1
          AND evaluated_at > ($5::timestamptz - interval '90 minutes')
          AND governance -> 'lowVolRangeShadowOutcome15m' IS NULL
        ORDER BY evaluated_at ASC, id ASC
        LIMIT 12
      `,
      [
        input.userId,
        input.brokerConnectionId,
        input.instrument.trim().toUpperCase(),
        input.policyVersion,
        input.asOf.toISOString(),
        LOW_VOL_RANGE_SHADOW_ARTIFACT,
      ],
    )) as Array<{
      id: string;
      direction: 'BUY' | 'SELL';
      evaluated_at: Date | string;
      research: unknown;
    }>;
    return rows.flatMap((row) => {
      const state = jsonObject(row.research);
      const evaluatedAt = date(row.evaluated_at);
      const stopDistance = nullableNumber(state.hypotheticalStopDistance);
      const targetDistance = nullableNumber(state.hypotheticalTargetDistance);
      const observedExecutionCostR = nullableNumber(state.observedExecutionCostR);
      if (
        !Number.isFinite(evaluatedAt.getTime()) ||
        !['BUY', 'SELL'].includes(row.direction) ||
        stopDistance === null ||
        stopDistance <= 0 ||
        targetDistance === null ||
        targetDistance <= 0 ||
        observedExecutionCostR === null ||
        observedExecutionCostR < 0 ||
        state.mode !== 'SHADOW_ONLY' ||
        state.executionAuthority !== 'NONE' ||
        !['STABILIZED_ENTRY_HYPOTHESIS', 'UNSTABLE_MOMENTUM_CONTROL'].includes(
          String(state.hypothesisCohort ?? ''),
        )
      ) {
        return [];
      }
      return [
        {
          id: row.id,
          direction: row.direction,
          evaluatedAt,
          stopDistance,
          targetDistance,
          observedExecutionCostR,
          hypothesisCohort: state.hypothesisCohort as
            | 'STABILIZED_ENTRY_HYPOTHESIS'
            | 'UNSTABLE_MOMENTUM_CONTROL',
        },
      ];
    });
  }

  async markLowVolRangeShadowOutcome(
    decisionId: string,
    outcome: LowVolRangeShadowOutcome,
  ): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET governance = jsonb_set(governance, '{lowVolRangeShadowOutcome15m}', $2::jsonb, true),
            updated_at = now()
        WHERE id = $1
          AND governance -> 'lowVolRangeShadow' ->> 'outcomeStudyEligible' = 'true'
          AND governance -> 'lowVolRangeShadowOutcome15m' IS NULL
          AND execution_authority = 'NONE'
      `,
      [decisionId, JSON.stringify(outcome)],
    );
  }

  async loadPendingDriftCounterfactuals(
    input: M1PendingDriftCounterfactualQuery,
  ): Promise<M1PendingDriftCounterfactual[]> {
    const rows = (await this.dataSource.query(
      `
        -- Research-only: sample earliest drift evaluation in each fixed
        -- UTC 16-minute bucket. Previously only "drift-only" rows were
        -- admitted, excluding the real OOD cases with other blockers.
        -- No changes to order authority or any gate.
        WITH candidates AS (
          SELECT id, instrument, direction, route, evaluated_at,
                 candidate, governance, blockers,
                 ROW_NUMBER() OVER (
                   PARTITION BY FLOOR(EXTRACT(EPOCH FROM evaluated_at) / 960)::bigint
                   ORDER BY evaluated_at ASC, id ASC
                 ) AS episode_rank
          FROM trading.m1_tactical_decisions
          WHERE user_id = $1
            AND broker_connection_id = $2
            AND instrument = $3
            AND route <> 'ABSTAIN'
            AND execution_authority = 'NONE'
            AND (
              blockers @> '["DRIFT_OUT_OF_DISTRIBUTION"]'::jsonb
              OR blockers @> '["DRIFT_STRESSED"]'::jsonb
            )
            -- Rank across the COMPLETE oldest fixed UTC bucket, not a
            -- sliding 48-minute cutoff. Otherwise the first episode
            -- ages out each minute and a second candidate from its
            -- original bucket becomes an artificial new leader.
            AND evaluated_at >= TO_TIMESTAMP(
              FLOOR(EXTRACT(EPOCH FROM ($4::timestamptz - interval '48 minutes')) / 960)
              * 960
            )
            AND evaluated_at <= ($4::timestamptz - interval '16 minutes')
            AND policy_version = $5
        )
        SELECT id, instrument, direction, route, evaluated_at,
               candidate, governance, blockers
        FROM candidates
        WHERE episode_rank = 1
          -- Maturity window applies AFTER bucket leaders are selected:
          -- a leader that ages out cannot be replaced within its bin.
          AND evaluated_at > ($4::timestamptz - interval '48 minutes')
          AND governance -> 'driftCounterfactual15m' IS NULL
        ORDER BY evaluated_at DESC
        LIMIT 8
      `,
      [
        input.userId,
        input.brokerConnectionId,
        input.instrument.trim().toUpperCase(),
        input.asOf.toISOString(),
        input.policyVersion,
      ],
    )) as Array<{
      id: string;
      instrument: string;
      direction: 'BUY' | 'SELL';
      route: M1ReliabilityRoute;
      evaluated_at: string | Date;
      candidate: unknown;
      governance: unknown;
      blockers?: unknown;
    }>;

    return rows.map((row) => {
      const candidate = jsonObject(row.candidate);
      const governance = jsonObject(row.governance);
      const genericGovernance = jsonObject(governance.genericGovernance);
      const multimodelGovernance = jsonObject(governance.multimodelGovernance);
      const useMultimodel =
        multimodelGovernance.driftState === 'OUT_OF_DISTRIBUTION' ||
        multimodelGovernance.driftState === 'STRESSED';
      const driftEvidence = useMultimodel ? multimodelGovernance : genericGovernance;
      const diagnostics = driftEvidence.driftDiagnostics;
      const allBlockers = Array.isArray(row.blockers)
        ? row.blockers.filter((item): item is string => typeof item === 'string')
        : [];
      const nonDriftBlockers = allBlockers.filter(
        (item) =>
          item !== 'DRIFT_OUT_OF_DISTRIBUTION' &&
          item !== 'DRIFT_STRESSED' &&
          item !== 'MULTIMODEL_GOVERNANCE_BLOCKED',
      );
      return {
        id: row.id,
        instrument: row.instrument.trim().toUpperCase(),
        direction: row.direction,
        route: row.route,
        evaluatedAt: date(row.evaluated_at),
        stopDistance: number(candidate.stopDistance),
        targetDistance: number(candidate.targetDistance),
        estimatedExecutionCostR: number(
          driftEvidence.estimatedExecutionCostR ?? genericGovernance.estimatedExecutionCostR,
        ),
        driftState: typeof driftEvidence.driftState === 'string' ? driftEvidence.driftState : null,
        driftDiagnostics: Array.isArray(diagnostics)
          ? diagnostics.filter((item): item is string => typeof item === 'string')
          : [],
        nonDriftBlockers: [...new Set(nonDriftBlockers)].slice(0, 18),
        driftEvidenceSource: useMultimodel ? 'MULTIMODEL' : 'GENERIC',
      };
    });
  }

  async markDriftCounterfactual15m(
    decisionId: string,
    observation: M1DriftCounterfactualResult,
  ): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET governance = jsonb_set(governance, '{driftCounterfactual15m}', $2::jsonb, true),
            updated_at = now()
        WHERE id = $1
          AND governance -> 'driftCounterfactual15m' IS NULL
      `,
      [decisionId, JSON.stringify(observation)],
    );
  }

  async markRescueObservation(
    decisionId: string,
    observation: M1RescueObservationInput,
  ): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET governance = jsonb_set(governance, '{failedMoveRescue}', $2::jsonb, true),
            updated_at = now()
        WHERE id = $1
      `,
      [
        decisionId,
        JSON.stringify({
          openTradeId: observation.openTradeId,
          openDecisionId: observation.openDecisionId,
          observedAt: observation.observedAt.toISOString(),
          rescue: observation.rescue,
        }),
      ],
    );
  }

  async markExecutionLink(
    decisionId: string,
    signalId: string,
    tradeIntentId?: string,
  ): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET signal_id = COALESCE(signal_id, $2),
            trade_intent_id = COALESCE(trade_intent_id, $3),
            updated_at = now()
        WHERE id = $1
      `,
      [decisionId, signalId, tradeIntentId ?? null],
    );
  }

  async markOutcomeState(
    decisionId: string,
    outcomeState: string,
    observedAt = new Date(),
    outcomeReason?: string,
  ): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET outcome_state = $2,
            outcome_observed_at = $3,
            outcome_reason = $4,
            updated_at = now()
        WHERE id = $1
          AND (
            outcome_state IS DISTINCT FROM 'EXECUTION_SUCCEEDED'
            OR $2 = 'EXECUTION_SUCCEEDED'
          )
      `,
      [decisionId, outcomeState, observedAt.toISOString(), outcomeReason ?? null],
    );
  }

  async loadShadowOutcomeMetrics(
    filter: M1ShadowOutcomeMetricsFilter,
  ): Promise<M1ShadowOutcomeMetrics> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          id,
          evaluated_at,
          governance -> 'shadowOutcome15mV1' AS shadow_outcome
        FROM trading.m1_tactical_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND ($3::text IS NULL OR route = $3)
          AND ($4::text IS NULL OR instrument = $4)
          AND ($5::text IS NULL OR direction = $5)
          AND ($6::text IS NULL OR policy_version = $6)
          AND evaluated_at >= $7::timestamptz
          AND evaluated_at <= $8::timestamptz
          AND governance -> 'shadowOutcome15mV1' ->> 'artifact' = $9
        ORDER BY evaluated_at ASC
      `,
      [
        filter.userId,
        filter.brokerConnectionId,
        filter.route ?? null,
        filter.instrument?.trim().toUpperCase() ?? null,
        filter.direction ?? null,
        filter.policyVersion ?? null,
        filter.from.toISOString(),
        filter.to.toISOString(),
        M1_SHADOW_OUTCOME_15M_ARTIFACT,
      ],
    )) as Array<{
      id: string;
      evaluated_at: string | Date;
      shadow_outcome: unknown;
    }>;

    let evaluableEpisodes = 0;
    let ambiguousEpisodes = 0;
    let unobservableEpisodes = 0;
    let positiveEpisodes = 0;
    let negativeEpisodes = 0;
    let flatEpisodes = 0;
    let cumulativeNetR = 0;
    let grossPositiveR = 0;
    let grossNegativeR = 0;
    let peakNetR = 0;
    let maximumDrawdownR = 0;

    for (const row of rows) {
      const outcome = jsonObject(row.shadow_outcome);
      const state = typeof outcome.outcome === 'string' ? outcome.outcome : '';
      if (state === 'AMBIGUOUS') {
        ambiguousEpisodes += 1;
        continue;
      }
      if (state === 'UNOBSERVABLE_DATA_GAP') {
        unobservableEpisodes += 1;
        continue;
      }
      if (!['TP', 'SL', 'MTM'].includes(state)) continue;
      const rawNetR = outcome.netRMultiple;
      if (rawNetR === null || rawNetR === undefined || rawNetR === '') continue;
      const netR = Number(rawNetR);
      if (!Number.isFinite(netR)) continue;

      evaluableEpisodes += 1;
      cumulativeNetR += netR;
      if (netR > 0) {
        positiveEpisodes += 1;
        grossPositiveR += netR;
      } else if (netR < 0) {
        negativeEpisodes += 1;
        grossNegativeR += Math.abs(netR);
      } else {
        flatEpisodes += 1;
      }
      peakNetR = Math.max(peakNetR, cumulativeNetR);
      maximumDrawdownR = Math.max(maximumDrawdownR, peakNetR - cumulativeNetR);
    }

    return {
      totalEpisodeLeaders: rows.length,
      evaluableEpisodes,
      ambiguousEpisodes,
      unobservableEpisodes,
      positiveEpisodes,
      negativeEpisodes,
      flatEpisodes,
      cumulativeNetR,
      averageNetR: evaluableEpisodes > 0 ? cumulativeNetR / evaluableEpisodes : 0,
      grossPositiveR,
      grossNegativeR,
      profitFactor:
        grossNegativeR > 0
          ? grossPositiveR / grossNegativeR
          : grossPositiveR > 0
            ? Number.POSITIVE_INFINITY
            : null,
      maximumDrawdownR,
    };
  }

  async loadOutcomeMetrics(
    filter: M1TacticalOutcomeMetricsFilter,
  ): Promise<M1TacticalOutcomeMetrics> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          COUNT(*)::int AS closed_trades,
          COUNT(*) FILTER (WHERE t.realised_pnl > 0)::int AS wins,
          COUNT(*) FILTER (WHERE t.realised_pnl < 0)::int AS losses,
          COALESCE(SUM(t.realised_pnl), 0) AS realised_pnl,
          COALESCE(SUM(t.realised_pnl) FILTER (WHERE t.realised_pnl > 0), 0) AS gross_profit,
          COALESCE(ABS(SUM(t.realised_pnl) FILTER (WHERE t.realised_pnl < 0)), 0) AS gross_loss
        FROM trading.m1_tactical_decisions d
        JOIN trading.trade_intents ti
          ON ti.user_id = d.user_id
         AND ti.broker_connection_id = d.broker_connection_id
         AND (
           ti.id = d.trade_intent_id
           OR (d.trade_intent_id IS NULL AND d.signal_id IS NOT NULL AND ti.signal_id = d.signal_id)
         )
        JOIN trading.trades t
          ON t.trade_intent_id = ti.id
         AND t.user_id = d.user_id
         AND t.broker_connection_id = d.broker_connection_id
        WHERE d.user_id = $1
          AND d.broker_connection_id = $2
          AND ($3::text IS NULL OR d.route = $3)
          AND ($4::text IS NULL OR d.instrument = $4)
          AND ($5::text IS NULL OR d.direction = $5)
          AND ($6::text IS NULL OR d.policy_version = $6)
          AND t.status = 'CLOSED'
          AND t.realised_pnl IS NOT NULL
          AND t.closed_at >= $7::timestamptz
          AND t.closed_at <= $8::timestamptz
      `,
      [
        filter.userId,
        filter.brokerConnectionId,
        filter.route ?? null,
        filter.instrument?.trim().toUpperCase() ?? null,
        filter.direction ?? null,
        filter.policyVersion ?? null,
        filter.from.toISOString(),
        filter.to.toISOString(),
      ],
    )) as Array<Record<string, unknown>>;
    const row = rows[0] ?? {};
    const closedTrades = number(row.closed_trades);
    const wins = number(row.wins);
    const losses = number(row.losses);
    const realisedPnl = number(row.realised_pnl);
    const grossProfit = number(row.gross_profit);
    const grossLoss = number(row.gross_loss);
    return {
      closedTrades,
      wins,
      losses,
      realisedPnl,
      grossProfit,
      grossLoss,
      profitFactor:
        grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null,
    };
  }

  private toRecord(row: DecisionRow): M1TacticalDecisionRecord {
    return {
      id: row.id,
      userId: row.user_id,
      brokerConnectionId: row.broker_connection_id,
      instrument: row.instrument,
      direction: row.direction,
      route: row.route,
      barTime: date(row.bar_time),
      policyVersion: row.policy_version,
      executionAuthority: row.execution_authority,
      blockers: blockers(row.blockers),
      signalId: row.signal_id,
      tradeIntentId: row.trade_intent_id,
      outcomeState: row.outcome_state,
      outcomeReason: row.outcome_reason,
      outcomeObservedAt: nullableDate(row.outcome_observed_at),
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    };
  }
}
