import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  evaluateM1ReversalTimingFusionShadow,
  type M1ReversalFusionCandidate,
} from './m1-reversal-timing-fusion-shadow';
import {
  evaluateM1ProbationMissedOpportunity,
  type ProbationBrokerM1,
} from './m1-probation-missed-opportunity-shadow';
import { evaluateProbationCausalCostStress } from './m1-probation-causal-cost-stress';

interface DecisionRow {
  id: string;
  user_id: string;
  broker_connection_id: string;
  account_currency: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: 'ABSTAIN' | 'M1_TREND_CONTINUATION' | 'M1_CONFIRMED_REVERSAL' | 'M1_EARLY_TRANSITION';
  evaluated_at: Date | string;
  candidate: M1ReversalFusionCandidate & { stopDistance: number; targetDistance: number };
  blockers: string[];
  planb_route: string;
  planb_paper_admitted: boolean;
  planb_paper_governance_passed: boolean;
  event_risk: string;
  drift_state: string;
}
interface PriorCost {
  sample_count: number | string;
  p90_fee_r?: number | string | null;
  p90_spread?: number | string | null;
}
const MAX_BATCH = 80;
const CYCLE_MS = 120_000;
const REPLAY_HORIZON_MINUTES = 60;

/** Records a causal research-only alternative to the M1 failed-breakout
 * requirement; it NEVER changes the route, trade intent or broker account.
 */
@Injectable()
export class M1ReversalTimingFusionShadowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M1ReversalTimingFusionShadowService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.runOnce(), 45_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), CYCLE_MS);
    this.timer.unref?.();
    this.logger.log('M1 reversal M5-fusion research enabled, executionAuthority=NONE');
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.loadDecisions(now);
      for (const row of rows) {
        try {
          const asOf = new Date(row.evaluated_at);
          const fusion = evaluateM1ReversalTimingFusionShadow({
            candidate: {
              ...row.candidate,
              instrument: row.instrument,
              direction: row.direction,
              decisionTime: asOf,
            },
            originalRoute: row.route,
            planBStrategyRoute: row.planb_route,
            planBPaperAdmitted: row.planb_paper_admitted,
          });
          const episodeId = Math.floor(asOf.getTime() / (30 * 60_000));
          const originalGovernanceClean =
            row.planb_paper_governance_passed &&
            row.event_risk === 'CLEAR' &&
            row.drift_state === 'NORMAL';
          let quoteReplay: ReturnType<typeof evaluateM1ProbationMissedOpportunity> | null = null;
          let costStress: ReturnType<typeof evaluateProbationCausalCostStress> | null = null;
          if (fusion.wouldConfirmWithoutFailedBreakout) {
            const startMs = (Math.floor(asOf.getTime() / 60_000) + 1) * 60_000;
            const quotes = await this.loadQuotes(
              row.broker_connection_id,
              row.instrument,
              new Date(startMs),
              new Date(startMs + REPLAY_HORIZON_MINUTES * 60_000),
            );
            quoteReplay = evaluateM1ProbationMissedOpportunity({
              instrument: row.instrument,
              direction: row.direction,
              decisionTime: asOf,
              stopDistance: Number(row.candidate.stopDistance),
              targetDistance: Number(row.candidate.targetDistance),
              bars: quotes,
            });
            const [priorFees, priorSpread] = await Promise.all([
              this.loadPriorFees(row, asOf),
              this.loadPriorSpread(row, asOf),
            ]);
            costStress = evaluateProbationCausalCostStress({
              instrument: row.instrument,
              grossOutcome: quoteReplay.state,
              grossR: quoteReplay.indicativeGrossR,
              stopDistance: Number(row.candidate.stopDistance),
              feeSamples: Number(priorFees.sample_count ?? 0),
              feeP90R: priorFees.p90_fee_r == null ? null : Number(priorFees.p90_fee_r),
              spreadBars: Number(priorSpread.sample_count ?? 0),
              spreadP90Price:
                priorSpread.p90_spread == null ? null : Number(priorSpread.p90_spread),
            });
          }
          const audit = {
            ...fusion,
            originalBlockers: row.blockers,
            originalPlanBGovernancePassed: row.planb_paper_governance_passed,
            originalEventRisk: row.event_risk,
            originalDriftState: row.drift_state,
            originalGovernanceClean,
            instrument: row.instrument,
            direction: row.direction,
            originalDecisionTime: asOf.toISOString(),
            episode30m: episodeId,
            accountCurrency: row.account_currency,
            quoteReplay,
            costStress,
            sampleIndependence: 'DEDUPLICATE_PER_USER_ACCOUNT_PAIR_DIRECTION_UTC_30M_EPISODE',
            caveat:
              'All outcomes are unordered broker-native OHLC quote-bar touches, not executable orders. The alternate signal uses only pre-entry candidate features. Losses, missing quotes, commissions, spread and hypothetical slippage must remain visible. Prospective promotion requires independent evidence.',
            executionAuthority: 'NONE',
            modifiesExecution: false,
            trainingStatus: 'UNVALIDATED_RESEARCH',
          };
          await this.persist(row, audit);
        } catch (error) {
          this.logger.warn('M1 reversal fusion observation deferred: ' + (error as Error).message);
        }
      }
    } catch (error) {
      this.logger.warn('M1 reversal fusion cycle deferred: ' + (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async loadDecisions(now: Date): Promise<DecisionRow[]> {
    return (await this.dataSource.query(
      `
        SELECT d.id,d.user_id,d.broker_connection_id,bc.account_currency,
          d.instrument,d.direction,d.route,d.evaluated_at,d.candidate,d.blockers,
          d.governance#>>'{multimodelEnsemble,strategyRoute}' planb_route,
          (d.governance#>>'{multimodelEnsemble,paperAdmitted}')::boolean planb_paper_admitted,
          (d.governance#>>'{multimodelGovernance,paperExecutionEligible}')::boolean planb_paper_governance_passed,
          d.governance#>>'{multimodelGovernance,eventRisk}' event_risk,
          d.governance#>>'{multimodelGovernance,driftState}' drift_state
        FROM trading.m1_tactical_decisions d
        JOIN broker.broker_connections bc ON bc.id=d.broker_connection_id AND bc.user_id=d.user_id
        WHERE bc.account_type='DEMO'
          AND bc.broker_id IN ('ctrader','pepperstone-ctrader','icmarkets-ctrader')
          AND d.execution_authority='NONE'
          AND d.governance#>>'{multimodelEnsemble,strategyRoute}'='CONFIRMED_REVERSAL'
          AND d.governance#>>'{multimodelEnsemble,paperAdmitted}'='true'
          AND d.blockers @> '["MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED"]'::jsonb
          AND d.evaluated_at >= $1::timestamptz - interval '14 days'
          AND d.evaluated_at < $1::timestamptz - interval '62 minutes'
          AND d.governance->'reversalTimingFusionShadow60m' IS NULL
        ORDER BY d.evaluated_at DESC,d.id DESC
        LIMIT $2
      `,
      [now.toISOString(), MAX_BATCH],
    )) as DecisionRow[];
  }

  private async loadQuotes(
    brokerConnectionId: string,
    instrument: string,
    start: Date,
    end: Date,
  ): Promise<ProbationBrokerM1[]> {
    return (await this.dataSource.query(
      `
        SELECT bucket_time,open,high,low,close,source,sample_count,
          positive_quote_sample_count,first_sample_at,last_quote_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id=$1 AND instrument=$2 AND timeframe='M1'
          AND bucket_time >= $3::timestamptz AND bucket_time < $4::timestamptz
        ORDER BY bucket_time
      `,
      [brokerConnectionId, instrument, start.toISOString(), end.toISOString()],
    )) as ProbationBrokerM1[];
  }

  private async loadPriorFees(row: DecisionRow, asOf: Date): Promise<PriorCost> {
    const rows = (await this.dataSource.query(
      `
        SELECT count(*)::int sample_count,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY fee_r) p90_fee_r
        FROM (
          SELECT (abs(t.commission)+greatest(0,-coalesce(t.swap,0))) /
            nullif(CASE
              WHEN a.sizing_inputs->>'finalRiskAtStop' ~ '^[0-9]+([.][0-9]+)?$'
                THEN (a.sizing_inputs->>'finalRiskAtStop')::numeric END,0) fee_r
          FROM trading.trades t
          JOIN trading.trading_sessions s ON s.id=t.trading_session_id
            AND s.user_id=t.user_id AND s.broker_connection_id=t.broker_connection_id
            AND s.execution_mode='FULL_AUTO'
          JOIN LATERAL (
            SELECT sizing_inputs FROM trading.capital_allocations a
            WHERE a.trade_intent_id=t.trade_intent_id ORDER BY created_at DESC LIMIT 1
          ) a ON true
          WHERE t.user_id=$1 AND t.broker_connection_id=$2
            AND t.instrument=$3 AND t.account_currency=$4
            AND t.status='CLOSED' AND t.commission IS NOT NULL
            AND t.closed_at < $5::timestamptz
            AND t.closed_at >= $5::timestamptz - interval '21 days'
          ORDER BY t.closed_at DESC,t.id DESC
          LIMIT 40
        ) historical
        WHERE fee_r IS NOT NULL AND fee_r>=0
      `,
      [
        row.user_id,
        row.broker_connection_id,
        row.instrument,
        row.account_currency,
        asOf.toISOString(),
      ],
    )) as PriorCost[];
    return rows[0] ?? { sample_count: 0, p90_fee_r: null };
  }

  private async loadPriorSpread(row: DecisionRow, asOf: Date): Promise<PriorCost> {
    const rows = (await this.dataSource.query(
      `
        SELECT count(*)::int sample_count,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY spread_close::double precision) p90_spread
        FROM market_data.provider_quote_candles
        WHERE connection_id=$1 AND instrument=$2 AND timeframe='M1'
          AND source='ctrader-broker-native' AND spread_close>0
          AND positive_quote_sample_count>0
          AND last_quote_sample_at < $3::timestamptz
          AND last_quote_sample_at >= $3::timestamptz-interval '15 minutes'
      `,
      [row.broker_connection_id, row.instrument, asOf.toISOString()],
    )) as PriorCost[];
    return rows[0] ?? { sample_count: 0, p90_spread: null };
  }

  private async persist(row: DecisionRow, audit: Record<string, unknown>): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET governance=jsonb_set(governance,'{reversalTimingFusionShadow60m}',$4::jsonb,true),
          updated_at=now()
        WHERE id=$1 AND user_id=$2 AND broker_connection_id=$3
          AND execution_authority='NONE'
          AND blockers @> '["MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED"]'::jsonb
          AND governance->'reversalTimingFusionShadow60m' IS NULL
      `,
      [row.id, row.user_id, row.broker_connection_id, JSON.stringify(audit)],
    );
  }
}
