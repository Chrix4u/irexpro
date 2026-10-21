import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { M1ReliabilityRoute, M1RoutePairSideEvidenceRow } from './m1-tactical-reliability';
import type { M1FailedMoveRescueDecision } from './m1-failed-move-rescue';
import type { M1DriftCounterfactualResult } from './m1-drift-counterfactual';

export type M1TacticalDecisionRoute = M1ReliabilityRoute | 'ABSTAIN';
export type M1TacticalDecisionAuthority = 'NONE' | 'PAPER_ONLY_RESEARCH';

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

export interface M1ActiveOppositeIntentQuery {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
}

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
      closed_at: string | Date;
    }>;
    return rows.map((row) => ({
      route: row.route,
      instrument: row.instrument,
      direction: row.direction,
      policyVersion: row.policy_version,
      realisedPnl: number(row.realised_pnl),
      closedAt: date(row.closed_at),
    }));
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
          AND ti.strategy_code = 'external-irexpro-m1-tactical'
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

  async hasActiveOppositeM1Intent(input: M1ActiveOppositeIntentQuery): Promise<boolean> {
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
            AND ti.strategy_code = 'external-irexpro-m1-tactical'
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
            AND (blockers = '[]'::jsonb OR blockers = '["M1_PHASE_SHADOW"]'::jsonb)
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
      const estimatedExecutionCostR = number(genericGovernance.estimatedExecutionCostR);
      const barTime = date(row.bar_time);
      const evaluatedAt = date(row.evaluated_at);
      if (
        stopDistance <= 0 ||
        targetDistance <= 0 ||
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
          rolloutPhase: typeof governance.rolloutPhase === 'string' ? governance.rolloutPhase : null,
        },
      ];
    });
  }

  async markShadowOutcome15mV1(
    decisionId: string,
    outcome: M1ShadowOutcome15mV1,
  ): Promise<void> {
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
          AND jsonb_array_length(blockers) <= 2
          AND blockers <@ '["DRIFT_OUT_OF_DISTRIBUTION","DRIFT_STRESSED","M1_PHASE_SHADOW"]'::jsonb
          AND (
            blockers @> '["DRIFT_OUT_OF_DISTRIBUTION"]'::jsonb
            OR blockers @> '["DRIFT_STRESSED"]'::jsonb
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
