import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  evaluateM1ProbationMissedOpportunity,
  M1_PROBATION_MISSED_HORIZON,
  M1_PROBATION_EPISODE_MINUTES,
  type ProbationBrokerM1,
  type ProbationMissedOpportunityResult,
} from './m1-probation-missed-opportunity-shadow';

const INTERVAL_MS = 120_000;
const MAX_CANDIDATES_PER_CYCLE = 25;

interface ProbationCandidate {
  id: string;
  user_id: string;
  broker_connection_id: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: string;
  evaluated_at: Date | string;
  candidate: Record<string, unknown>;
  governance: Record<string, unknown>;
}

@Injectable()
export class M1ProbationMissedOpportunityShadowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M1ProbationMissedOpportunityShadowService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.runOnce(), 50_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log('Probation-only DEMO missed-opportunity M1 replay active, authority=NONE');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.loadCandidates(now);
      for (const candidate of candidates) {
        try {
          const at = new Date(candidate.evaluated_at);
          const start = new Date((Math.floor(at.getTime() / 60_000) + 1) * 60_000);
          const end = new Date(start.getTime() + M1_PROBATION_MISSED_HORIZON * 60_000);
          const candles = await this.loadCandles(
            candidate.broker_connection_id,
            candidate.instrument,
            start,
            end,
          );
          const result = evaluateM1ProbationMissedOpportunity({
            instrument: candidate.instrument,
            direction: candidate.direction,
            decisionTime: at,
            stopDistance: Number(candidate.candidate.stopDistance),
            targetDistance: Number(candidate.candidate.targetDistance),
            bars: candles,
          });
          await this.persist(candidate, result, end);
        } catch (error) {
          this.logger.warn('Probation research deferred: ' + (error as Error).message);
        }
      }
    } catch (error) {
      this.logger.warn('Probation research cycle deferred: ' + (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async loadCandidates(now: Date): Promise<ProbationCandidate[]> {
    return (await this.dataSource.query(
      `
        WITH eligible AS (
          SELECT d.id,d.user_id,d.broker_connection_id,d.instrument,d.direction,
            d.route,d.evaluated_at,d.candidate,d.governance,
            ROW_NUMBER() OVER (
              PARTITION BY d.user_id,d.broker_connection_id,d.instrument,d.direction,
                FLOOR(EXTRACT(EPOCH FROM d.evaluated_at) / $3::int)::bigint
              ORDER BY d.evaluated_at ASC,d.id ASC
            ) AS episode_rank
          FROM trading.m1_tactical_decisions d
          JOIN broker.broker_connections bc
            ON bc.id=d.broker_connection_id AND bc.user_id=d.user_id
          WHERE bc.account_type='DEMO'
            AND bc.broker_id IN ('ctrader','pepperstone-ctrader','icmarkets-ctrader')
            AND d.route <> 'ABSTAIN'
            AND d.execution_authority='NONE'
            -- Only opportunities whose *sole* veto was the deliberate
            -- primary-only probation switch. Never reinterpret OOD or risk vetoes.
            AND d.blockers='["M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION"]'::jsonb
            AND d.governance #>> '{demoPrimaryOnlyProbation,chosenAuthorityPath}'
              NOT IN ('BLOCKED','UNKNOWN')
            AND d.evaluated_at >= $1::timestamptz - interval '21 days'
            AND d.evaluated_at < $1::timestamptz - interval '62 minutes'
        )
        SELECT id,user_id,broker_connection_id,instrument,direction,
          route,evaluated_at,candidate,governance
        FROM eligible
        WHERE episode_rank=1
          AND governance -> 'probationMissedOpportunity60m' IS NULL
        ORDER BY evaluated_at DESC,id DESC
        LIMIT $2
      `,
      [now.toISOString(), MAX_CANDIDATES_PER_CYCLE, M1_PROBATION_EPISODE_MINUTES * 60],
    )) as ProbationCandidate[];
  }

  private async loadCandles(
    connectionId: string,
    instrument: string,
    from: Date,
    until: Date,
  ): Promise<ProbationBrokerM1[]> {
    return (await this.dataSource.query(
      `
        SELECT bucket_time,open,high,low,close,source,sample_count,
          positive_quote_sample_count,first_sample_at,last_quote_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id=$1 AND instrument=$2 AND timeframe='M1'
          AND bucket_time >= $3::timestamptz AND bucket_time < $4::timestamptz
        ORDER BY bucket_time ASC
      `,
      [connectionId, instrument.toUpperCase(), from.toISOString(), until.toISOString()],
    )) as ProbationBrokerM1[];
  }

  private async persist(
    row: ProbationCandidate,
    evaluation: ProbationMissedOpportunityResult,
    horizonAt: Date,
  ): Promise<void> {
    const response = {
      ...evaluation,
      instrument: row.instrument,
      direction: row.direction,
      strategyRoute: row.route,
      originalEvaluatedAt: new Date(row.evaluated_at).toISOString(),
      checkpointAt: horizonAt.toISOString(),
      originalCandidate: {
        entry: row.candidate.entry ?? null,
        stopDistance: row.candidate.stopDistance ?? null,
        targetDistance: row.candidate.targetDistance ?? null,
        confidence: row.candidate.confidence ?? null,
        directionQuality: row.candidate.directionQuality ?? null,
      },
      originalAuthorityPath:
        row.governance.demoPrimaryOnlyProbation &&
        typeof row.governance.demoPrimaryOnlyProbation === 'object'
          ? ((row.governance.demoPrimaryOnlyProbation as Record<string, unknown>)
              .chosenAuthorityPath ?? null)
          : null,
      originalBlockers: ['M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION'],
      replayEpisodePolicy: 'EARLIEST_SOLE_PROBATION_CANDIDATE_PER_PAIR_SIDE_PER_FIXED_30M_UTC',
      purpose: 'Missed-trade research; NOT a permission to remove probation',
      caveat:
        'Quote OHLC is unordered and not executable bid/ask. Gross-only R excludes commissions, spread, slippage, swaps, volume constraints, correlated capacity and macro-event exposure. In-sample replay is not validation.',
      modelTrainingStatus: 'RESEARCH_ONLY_NOT_TRAINED',
      modifiesExecution: false,
      executionAuthority: 'NONE',
    };
    await this.dataSource.query(
      `
        UPDATE trading.m1_tactical_decisions
        SET governance=jsonb_set(
          governance,'{probationMissedOpportunity60m}',$4::jsonb,true
        ),updated_at=now()
        WHERE id=$1 AND user_id=$2 AND broker_connection_id=$3
          AND execution_authority='NONE'
          AND blockers='["M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION"]'::jsonb
          AND governance->'probationMissedOpportunity60m' IS NULL
      `,
      [row.id, row.user_id, row.broker_connection_id, JSON.stringify(response)],
    );
  }
}
