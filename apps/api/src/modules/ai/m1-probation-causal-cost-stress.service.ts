import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { evaluateProbationCausalCostStress } from './m1-probation-causal-cost-stress';

interface CohortRow {
  id: string;
  user_id: string;
  broker_connection_id: string;
  account_currency: string;
  instrument: string;
  evaluated_at: Date | string;
  candidate: { stopDistance?: unknown };
  observation: {
    state?: unknown;
    indicativeGrossR?: unknown;
  };
}
interface PriorFeeRow {
  sample_count: string | number | null;
  p90_fee_r: string | number | null;
}
interface PriorSpreadRow {
  sample_count: string | number | null;
  p90_spread: string | number | null;
}
const COST_STRESS_BATCH = 25;
const COST_STRESS_INTERVAL_MS = 120_000;

/**
 * Adds a separately identified, no-execution cost-stress lens to previously
 * written missed-opportunity observations. Uses only account-matched broker
 * fills and broker quotes that existed BEFORE the rejected entry decision.
 * Does not change any strategy, broker adapter, stop, position or order.
 */
@Injectable()
export class M1ProbationCausalCostStressService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M1ProbationCausalCostStressService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.runOnce(), 42_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), COST_STRESS_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log('Probation-only causal broker cost research enabled; no trading authority');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cohort = await this.loadEligible(now);
      for (const row of cohort) {
        try {
          const asOf = new Date(row.evaluated_at).toISOString();
          const [priorFee, priorSpread] = await Promise.all([
            this.loadPriorFee(row, asOf),
            this.loadPriorSpread(row, asOf),
          ]);
          const observedGross = row.observation.indicativeGrossR;
          const grossR =
            observedGross === null || observedGross === undefined ? null : Number(observedGross);
          const result = evaluateProbationCausalCostStress({
            instrument: row.instrument,
            grossOutcome: String(row.observation.state ?? ''),
            grossR,
            stopDistance: Number(row.candidate.stopDistance),
            feeSamples: Number(priorFee.sample_count ?? 0),
            feeP90R: priorFee.p90_fee_r === null ? null : Number(priorFee.p90_fee_r),
            spreadBars: Number(priorSpread.sample_count ?? 0),
            spreadP90Price: priorSpread.p90_spread === null ? null : Number(priorSpread.p90_spread),
          });
          await this.persist(row, {
            ...result,
            brokerConnectionScoped: true,
            accountCurrency: row.account_currency,
            priorFeeEvidenceCutoff: asOf,
            priorSpreadEvidenceCutoff: asOf,
            evidenceWindowDays: 21,
            spreadEvidenceWindowMinutes: 15,
            minimumFeeSamples: result.brokerFeeMinimumFills,
            observationReference: 'probationMissedOpportunity60m',
            nonExecutableDisclaimer:
              'Only historical P90 round-trip fee plus P90 mark-spread and a stated hypothetical slippage penalty. Quote-bar barrier touches do not prove executable broker fills, market depth, independent episodes or account-level net profit.',
          });
        } catch (error) {
          this.logger.warn('Probation cost stress candidate deferred: ' + (error as Error).message);
        }
      }
    } catch (error) {
      this.logger.warn('Probation cost stress cycle deferred: ' + (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async loadEligible(now: Date): Promise<CohortRow[]> {
    return (await this.dataSource.query(
      `
        SELECT d.id,d.user_id,d.broker_connection_id,bc.account_currency,
          d.instrument,d.evaluated_at,d.candidate,
          d.governance->'probationMissedOpportunity60m' AS observation
        FROM trading.m1_tactical_decisions d
        JOIN broker.broker_connections bc
          ON bc.id=d.broker_connection_id AND bc.user_id=d.user_id
        WHERE bc.account_type='DEMO'
          AND bc.broker_id IN ('ctrader','pepperstone-ctrader','icmarkets-ctrader')
          AND d.execution_authority='NONE'
          AND d.blockers='["M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION"]'::jsonb
          AND d.evaluated_at >= $1::timestamptz - interval '21 days'
          AND d.evaluated_at < $1::timestamptz - interval '62 minutes'
          AND jsonb_typeof(d.governance->'probationMissedOpportunity60m')='object'
          AND d.governance#>'{probationMissedOpportunity60m,costStress}' IS NULL
        ORDER BY d.evaluated_at DESC,d.id DESC
        LIMIT $2
      `,
      [now.toISOString(), COST_STRESS_BATCH],
    )) as CohortRow[];
  }

  private async loadPriorFee(row: CohortRow, asOf: string): Promise<PriorFeeRow> {
    const entries = (await this.dataSource.query(
      `
        SELECT COUNT(*)::int sample_count,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY fee_r) AS p90_fee_r
        FROM (
          SELECT
            (ABS(t.commission) + GREATEST(0,-COALESCE(t.swap,0))) /
              NULLIF(CASE
                WHEN alloc.sizing_inputs->>'finalRiskAtStop' ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (alloc.sizing_inputs->>'finalRiskAtStop')::numeric
                ELSE NULL END,0) AS fee_r
          FROM trading.trades t
          JOIN trading.trading_sessions s ON s.id=t.trading_session_id
            AND s.user_id=t.user_id AND s.broker_connection_id=t.broker_connection_id
            AND s.execution_mode='FULL_AUTO'
          JOIN broker.broker_connections b ON b.id=t.broker_connection_id
            AND b.user_id=$1 AND b.id=$2
            AND b.account_type='DEMO'
            AND b.account_currency=t.account_currency
          JOIN LATERAL (
            SELECT sizing_inputs FROM trading.capital_allocations a
            WHERE a.trade_intent_id=t.trade_intent_id
            ORDER BY a.created_at DESC LIMIT 1
          ) alloc ON TRUE
          WHERE t.user_id=$1 AND t.broker_connection_id=$2
            AND t.instrument=$3 AND t.account_currency=$4
            AND t.status='CLOSED' AND t.commission IS NOT NULL
            AND t.closed_at < $5::timestamptz
            AND t.closed_at >= $5::timestamptz - interval '21 days'
          ORDER BY t.closed_at DESC,t.id DESC
          LIMIT 40
        ) verified
        WHERE fee_r >= 0 AND fee_r IS NOT NULL
      `,
      [row.user_id, row.broker_connection_id, row.instrument, row.account_currency, asOf],
    )) as PriorFeeRow[];
    return entries[0] ?? { sample_count: 0, p90_fee_r: null };
  }

  private async loadPriorSpread(row: CohortRow, asOf: string): Promise<PriorSpreadRow> {
    const entries = (await this.dataSource.query(
      `
        SELECT COUNT(*)::int sample_count,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY spread_close::double precision)
            AS p90_spread
        FROM market_data.provider_quote_candles
        WHERE connection_id=$1 AND instrument=$2 AND timeframe='M1'
          AND source='ctrader-broker-native'
          AND spread_close > 0
          AND positive_quote_sample_count > 0
          AND last_quote_sample_at < $3::timestamptz
          AND last_quote_sample_at >= $3::timestamptz - interval '15 minutes'
      `,
      [row.broker_connection_id, row.instrument, asOf],
    )) as PriorSpreadRow[];
    return entries[0] ?? { sample_count: 0, p90_spread: null };
  }

  private async persist(row: CohortRow, stress: Record<string, unknown>): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET governance=jsonb_set(
          governance,'{probationMissedOpportunity60m,costStress}',$4::jsonb,true
        ),updated_at=now()
        WHERE id=$1 AND user_id=$2 AND broker_connection_id=$3
          AND execution_authority='NONE'
          AND blockers='["M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION"]'::jsonb
          AND jsonb_typeof(governance->'probationMissedOpportunity60m')='object'
          AND governance #> '{probationMissedOpportunity60m,costStress}' IS NULL
      `,
      [row.id, row.user_id, row.broker_connection_id, JSON.stringify(stress)],
    );
  }
}
