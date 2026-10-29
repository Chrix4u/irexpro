import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { M1ReliabilityRoute, M1RoutePairSideEvidenceRow } from './m1-tactical-reliability';
import type { M1FailedMoveRescueDecision } from './m1-failed-move-rescue';
import type { M1DriftCounterfactualResult } from './m1-drift-counterfactual';
import type { M1ShadowPairSideOutcome } from './m1-shadow-pair-side-reliability';
import { m1UsdRiskAtStop } from './m1-tactical-currency-exposure';
import type { M5EarlyTransitionEvidence } from './m5-early-transition-handoff';

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
  planBPaperAdmitted: boolean | null;
  multimodelExecutable: boolean | null;
  multimodelAuthorityPath: string | null;
  multimodelRescueVolumeCap: number | null;
  trainedExpertState: string | null;
  trainedExpertDirection: 'BUY' | 'SELL' | null;
  trainedExpertConfidence: number | null;
  trainedExpertLongVotes: number | null;
  trainedExpertShortVotes: number | null;
  m1TacticalRole: string | null;
  m1TimingRoute: M1TacticalDecisionRoute;
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
  reason: 'CLEAR' | 'RECENT_MULTIMODEL_LOSS_STREAK';
  strategyRoute: M1MultimodelStrategyRoute;
  recentClosedTrades: number;
  recentLosses: number;
  recentWins: number;
  cumulativeRealisedPnl: number;
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

  async loadLatestDecisionStateForUser(
    userId: string,
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
          CASE
            WHEN execution_authority <> 'NONE' THEN 0
            WHEN route <> 'ABSTAIN' THEN 1
            ELSE 2
          END ASC,
          COALESCE((candidate ->> 'confidence')::numeric, 0) DESC,
          COALESCE((governance ->> 'netExpectedR')::numeric, -999999) DESC,
          created_at DESC
        LIMIT 1
      `,
      [userId],
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
      planBPaperAdmitted:
        typeof multimodelEnsemble.paperAdmitted === 'boolean'
          ? multimodelEnsemble.paperAdmitted
          : null,
      multimodelExecutable:
        typeof multimodelAuthority.executable === 'boolean' ? multimodelAuthority.executable : null,
      multimodelAuthorityPath: nullableString(multimodelAuthority.authorityPath),
      multimodelRescueVolumeCap: nullableNumber(multimodelAuthority.rescueVolumeCap),
      trainedExpertState: nullableString(trainedExpert.state),
      trainedExpertDirection:
        trainedDirection === 'BUY' || trainedDirection === 'SELL' ? trainedDirection : null,
      trainedExpertConfidence: nullableNumber(trainedExpert.ensembleConfidence),
      trainedExpertLongVotes: nullableNumber(trainedExpert.longVotes),
      trainedExpertShortVotes: nullableNumber(trainedExpert.shortVotes),
      m1TacticalRole: nullableString(governance.m1TacticalRole),
      m1TimingRoute: row.route,
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
          AND t.closed_at > ($6::timestamptz - interval '24 hours')
        ORDER BY t.closed_at DESC
        LIMIT 3
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

    const pnlValues = rows.map((row) => number(row.realised_pnl));
    const recentLosses = pnlValues.filter((value) => value < 0).length;
    const recentWins = pnlValues.filter((value) => value > 0).length;
    const cumulativeRealisedPnl =
      Math.round(pnlValues.reduce((sum, value) => sum + value, 0) * 100) / 100;
    const latestClosedAt = rows[0] ? date(rows[0].closed_at) : null;
    const cooldownUntilMs = latestClosedAt
      ? latestClosedAt.getTime() + M1_MULTIMODEL_LOSS_STREAK_COOLDOWN_HOURS * 60 * 60_000
      : 0;
    const cooldownRemainingSeconds = latestClosedAt
      ? Math.max(0, Math.ceil((cooldownUntilMs - input.evaluatedAt.getTime()) / 1000))
      : 0;
    const lossStreak =
      rows.length === M1_MULTIMODEL_LOSS_STREAK_MIN_CLOSED_TRADES &&
      recentLosses === M1_MULTIMODEL_LOSS_STREAK_MIN_CLOSED_TRADES;
    const active = lossStreak && cooldownRemainingSeconds > 0;

    return {
      artifact: M1_MULTIMODEL_LOSS_STREAK_BRAKE_ARTIFACT,
      active,
      reason: active ? 'RECENT_MULTIMODEL_LOSS_STREAK' : 'CLEAR',
      strategyRoute: input.strategyRoute,
      recentClosedTrades: rows.length,
      recentLosses,
      recentWins,
      cumulativeRealisedPnl,
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

  async loadPendingDriftCounterfactuals(
    input: M1PendingDriftCounterfactualQuery,
  ): Promise<M1PendingDriftCounterfactual[]> {
    const rows = (await this.dataSource.query(
      `
        SELECT id, instrument, direction, route, evaluated_at, candidate, governance
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
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(blockers) AS blocker(value)
            WHERE blocker.value NOT IN (
              'DRIFT_OUT_OF_DISTRIBUTION',
              'DRIFT_STRESSED',
              'M1_PHASE_SHADOW',
              'M1_PHASE_ROUTE_SHADOW'
            )
              AND blocker.value !~ '^M1_(SHADOW_|MEANINGFUL_SCOUT_|TIERED_SCOUT_)?RELIABILITY_'
          )
          AND governance -> 'driftCounterfactual15m' IS NULL
          AND evaluated_at <= ($4::timestamptz - interval '16 minutes')
          AND policy_version = $5
        ORDER BY evaluated_at DESC
        LIMIT 50
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
    }>;

    return rows.map((row) => {
      const candidate = jsonObject(row.candidate);
      const governance = jsonObject(row.governance);
      const genericGovernance = jsonObject(governance.genericGovernance);
      const diagnostics = genericGovernance.driftDiagnostics;
      return {
        id: row.id,
        instrument: row.instrument.trim().toUpperCase(),
        direction: row.direction,
        route: row.route,
        evaluatedAt: date(row.evaluated_at),
        stopDistance: number(candidate.stopDistance),
        targetDistance: number(candidate.targetDistance),
        estimatedExecutionCostR: number(genericGovernance.estimatedExecutionCostR),
        driftState:
          typeof genericGovernance.driftState === 'string' ? genericGovernance.driftState : null,
        driftDiagnostics: Array.isArray(diagnostics)
          ? diagnostics.filter((item): item is string => typeof item === 'string')
          : [],
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
