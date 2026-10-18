import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { M1ReliabilityRoute, M1RoutePairSideEvidenceRow } from './m1-tactical-reliability';

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
