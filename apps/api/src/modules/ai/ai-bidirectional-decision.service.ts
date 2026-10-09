import { Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AiBidirectionalComparisonDto,
  AiBidirectionalDecisionResponseDto,
  AiBidirectionalDirection,
  AiBidirectionalDriftState,
  AiBidirectionalSideDto,
  AiBidirectionalStrategyRoute,
} from './dto/ai-bidirectional-decision-response.dto';

const ACTIVE_ENGINE_CODE = 'irexpro-multimodel-ensemble-v1';
const DEFAULT_COMPARISON_LIMIT = 24;
const MAX_COMPARISON_LIMIT = 60;

interface EnsembleDecisionRow {
  model_version: string;
  instrument: string;
  direction: string;
  market_bar_time: string | Date;
  evaluated_at: string | Date;
  confidence: string | number;
  meta_probability: string | number;
  expected_r: string | number;
  regime: string;
  consensus_passed: string | number;
  consensus_required: string | number;
  reasons: unknown;
  components: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true';
}

function iso(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 20);
}

function strategyRoute(value: unknown): AiBidirectionalStrategyRoute | null {
  return value === 'TREND_CONTINUATION' ||
    value === 'CONFIRMED_REVERSAL' ||
    value === 'EARLY_TRANSITION'
    ? value
    : null;
}

function driftState(value: unknown): AiBidirectionalDriftState | null {
  return value === 'NORMAL' || value === 'STRESSED' || value === 'OUT_OF_DISTRIBUTION'
    ? value
    : null;
}

function direction(value: unknown): AiBidirectionalDirection | null {
  return value === 'BUY' || value === 'SELL' ? value : null;
}

function toSide(row: EnsembleDecisionRow): AiBidirectionalSideDto | null {
  const side = direction(row.direction);
  const evaluatedAt = iso(row.evaluated_at);
  const confidence = finiteNumber(row.confidence);
  const metaProbability = finiteNumber(row.meta_probability);
  const grossExpectedR = finiteNumber(row.expected_r);
  const consensusPassed = integer(row.consensus_passed);
  const consensusRequired = integer(row.consensus_required);
  if (
    !side ||
    !evaluatedAt ||
    confidence === null ||
    metaProbability === null ||
    grossExpectedR === null ||
    consensusPassed === null ||
    consensusRequired === null
  ) {
    return null;
  }

  const components = record(row.components);
  const governance = record(components?.governance);
  const netExpectedR = finiteNumber(governance?.netExpectedR);
  const blockers = stringArray(governance?.paperExecutionBlockers);

  return {
    direction: side,
    evaluatedAt,
    confidence,
    metaProbability,
    grossExpectedR,
    netExpectedR,
    regime: typeof row.regime === 'string' ? row.regime : 'UNKNOWN',
    strategyRoute: strategyRoute(components?.strategyRoute),
    consensusPassed,
    consensusRequired,
    paperAdmitted: bool(components?.paperAdmitted),
    paperExecutionEligible: bool(governance?.paperExecutionEligible),
    driftState: driftState(governance?.driftState),
    blockers,
  };
}

function selectionOf(
  buy: AiBidirectionalSideDto | null,
  sell: AiBidirectionalSideDto | null,
): Pick<AiBidirectionalComparisonDto, 'selectionStatus' | 'selectedDirection'> {
  const buyEligible = buy?.paperExecutionEligible === true;
  const sellEligible = sell?.paperExecutionEligible === true;
  if (buyEligible && sellEligible) {
    return { selectionStatus: 'BOTH_ELIGIBLE', selectedDirection: null };
  }
  if (buyEligible) return { selectionStatus: 'BUY_ELIGIBLE', selectedDirection: 'BUY' };
  if (sellEligible) return { selectionStatus: 'SELL_ELIGIBLE', selectedDirection: 'SELL' };
  return { selectionStatus: 'NO_ELIGIBLE_DIRECTION', selectedDirection: null };
}

@Injectable()
export class AiBidirectionalDecisionService {
  constructor(@Optional() private readonly dataSource?: DataSource) {}

  async getRecentComparisons(
    userId: string,
    limit = DEFAULT_COMPARISON_LIMIT,
  ): Promise<AiBidirectionalDecisionResponseDto> {
    const generatedAt = new Date().toISOString();
    if (!this.dataSource || !userId) {
      return { generatedAt, policyVersion: null, comparisons: [] };
    }

    const boundedLimit = Math.max(1, Math.min(MAX_COMPARISON_LIMIT, Math.trunc(limit)));
    const latestRows = (await this.dataSource.query(
      `
        SELECT model_version
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND engine_code = $2
        ORDER BY evaluated_at DESC
        LIMIT 1
      `,
      [userId, ACTIVE_ENGINE_CODE],
    )) as Array<{ model_version?: unknown }>;
    const policyVersion =
      typeof latestRows[0]?.model_version === 'string' && latestRows[0].model_version.length > 0
        ? latestRows[0].model_version
        : null;
    if (!policyVersion) {
      return { generatedAt, policyVersion: null, comparisons: [] };
    }

    const rows = (await this.dataSource.query(
      `
        WITH recent_bars AS (
          SELECT instrument, market_bar_time, MAX(evaluated_at) AS last_evaluated_at
          FROM trading.ensemble_shadow_decisions
          WHERE user_id = $1
            AND engine_code = $2
            AND model_version = $3
          GROUP BY instrument, market_bar_time
          ORDER BY last_evaluated_at DESC
          LIMIT $4
        )
        SELECT
          d.model_version,
          d.instrument,
          d.direction,
          d.market_bar_time,
          d.evaluated_at,
          d.confidence,
          d.meta_probability,
          d.expected_r,
          d.regime,
          d.consensus_passed,
          d.consensus_required,
          d.reasons,
          d.components
        FROM trading.ensemble_shadow_decisions d
        INNER JOIN recent_bars b
          ON b.instrument = d.instrument
         AND b.market_bar_time = d.market_bar_time
        WHERE d.user_id = $1
          AND d.engine_code = $2
          AND d.model_version = $3
        ORDER BY b.last_evaluated_at DESC, d.instrument ASC, d.direction ASC
      `,
      [userId, ACTIVE_ENGINE_CODE, policyVersion, boundedLimit],
    )) as EnsembleDecisionRow[];

    const grouped = new Map<
      string,
      {
        instrument: string;
        marketBarTime: string;
        buy: AiBidirectionalSideDto | null;
        sell: AiBidirectionalSideDto | null;
        latestEvaluatedAt: number;
      }
    >();

    for (const row of rows) {
      if (typeof row.instrument !== 'string' || row.instrument.length < 3) continue;
      const marketBarTime = iso(row.market_bar_time);
      const side = toSide(row);
      if (!marketBarTime || !side) continue;
      const key = `${row.instrument}|${marketBarTime}`;
      const evaluatedMs = new Date(side.evaluatedAt).getTime();
      const current = grouped.get(key) ?? {
        instrument: row.instrument,
        marketBarTime,
        buy: null,
        sell: null,
        latestEvaluatedAt: evaluatedMs,
      };
      if (side.direction === 'BUY') current.buy = side;
      else current.sell = side;
      current.latestEvaluatedAt = Math.max(current.latestEvaluatedAt, evaluatedMs);
      grouped.set(key, current);
    }

    const comparisons = [...grouped.values()]
      .sort((a, b) => b.latestEvaluatedAt - a.latestEvaluatedAt)
      .slice(0, boundedLimit)
      .map(({ latestEvaluatedAt: _ignored, ...comparison }) => ({
        ...comparison,
        decisionPolicyVersion: policyVersion,
        ...selectionOf(comparison.buy, comparison.sell),
      }));

    return { generatedAt, policyVersion, comparisons };
  }
}
