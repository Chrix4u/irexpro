import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaperBrokerState } from '../entities/paper-broker-state.entity';

export interface PaperOpenPositionTelemetry {
  externalPositionId: string;
  currentPrice: string | null;
  markObservedAt: Date | null;
  unrealisedPnl: string | null;
  maxFavorablePnl: string | null;
  maxAdversePnl: string | null;
  profitGiveback: string | null;
  observationCount: number | null;
  peakObservedAt: Date | null;
  lastObservedAt: Date | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function displayProfitGiveback(
  maxFavorablePnl: string | null,
  latestUnrealisedPnl: string | null,
): string | null {
  if (maxFavorablePnl === null || latestUnrealisedPnl === null) return null;
  const peak = Number(maxFavorablePnl);
  const latest = Number(latestUnrealisedPnl);
  if (!Number.isFinite(peak) || !Number.isFinite(latest)) return null;
  if (peak <= 0) return '0.00';
  return Math.max(0, peak - latest).toFixed(2);
}

@Injectable()
export class PaperBrokerStateService {
  constructor(
    @InjectRepository(PaperBrokerState)
    private readonly repository: Repository<PaperBrokerState>,
  ) {}

  async load(connectionId: string): Promise<Record<string, unknown> | null> {
    const row = await this.repository.findOne({ where: { connectionId } });
    return row?.state ?? null;
  }

  /**
   * Read-only, bounded projection of durable live PAPER path telemetry.
   *
   * This deliberately avoids adapter/provider calls so high-frequency UI reads
   * cannot create broker traffic or decrypt credentials. Provider position IDs
   * are returned only to server-side callers for exact matching and must never
   * be serialized directly to clients.
   */
  async loadOpenPositionTelemetry(connectionId: string): Promise<PaperOpenPositionTelemetry[]> {
    const state = await this.load(connectionId);
    const positions = state?.positions;
    if (!Array.isArray(positions)) return [];

    const projected: PaperOpenPositionTelemetry[] = [];
    for (const value of positions) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const position = value as Record<string, unknown>;
      const externalPositionId = stringOrNull(position.positionId);
      if (!externalPositionId) continue;

      const maxFavorablePnl = stringOrNull(position.pathMaxFavorablePnl);
      const latestUnrealisedPnl = stringOrNull(position.pathLatestUnrealisedPnl);
      const observationCount = position.pathObservationCount;
      projected.push({
        externalPositionId,
        currentPrice: stringOrNull(position.pathLastMarkPrice),
        markObservedAt: dateOrNull(position.pathLastMarkObservedAt),
        unrealisedPnl: latestUnrealisedPnl,
        maxFavorablePnl,
        maxAdversePnl: stringOrNull(position.pathMaxAdversePnl),
        profitGiveback: displayProfitGiveback(maxFavorablePnl, latestUnrealisedPnl),
        observationCount:
          typeof observationCount === 'number' &&
          Number.isSafeInteger(observationCount) &&
          observationCount >= 0
            ? observationCount
            : null,
        peakObservedAt: dateOrNull(position.pathPeakObservedAt),
        lastObservedAt: dateOrNull(position.pathLastObservedAt),
      });
    }
    return projected;
  }

  /**
   * Explicit qualification-campaign reset. Unlike save(), this intentionally
   * replaces monotonic simulator state after the trading session has been
   * stopped and flattened. Durable trading.trades evidence lives elsewhere
   * and is never deleted by this operation.
   */
  async resetForQualification(connectionId: string): Promise<void> {
    const pristine = {
      version: 1,
      orderCounter: 0,
      marketTickCounter: 0,
      balance: '10000.00',
      working: [],
      positions: [],
      closedTrades: [],
      orderStates: [],
      resultsByDedupeKey: [],
    };
    await this.repository.query(
      `
        INSERT INTO broker.paper_broker_states
          (connection_id, state_version, state, created_at, updated_at)
        VALUES ($1, 1, $2::jsonb, now(), now())
        ON CONFLICT (connection_id)
        DO UPDATE SET
          state_version = 1,
          state = EXCLUDED.state,
          updated_at = now()
      `,
      [connectionId, JSON.stringify(pristine)],
    );
  }

  async save(connectionId: string, state: Record<string, unknown>): Promise<void> {
    await this.repository.query(
      `
        INSERT INTO broker.paper_broker_states
          (connection_id, state_version, state, created_at, updated_at)
        VALUES ($1, 1, $2::jsonb, now(), now())
        ON CONFLICT (connection_id)
        DO UPDATE SET
          state_version = EXCLUDED.state_version,
          state = EXCLUDED.state,
          updated_at = now()
        WHERE
          COALESCE((EXCLUDED.state ->> 'marketTickCounter')::bigint, -1)
            >= COALESCE((paper_broker_states.state ->> 'marketTickCounter')::bigint, -1)
          AND COALESCE((EXCLUDED.state ->> 'orderCounter')::bigint, -1)
            >= COALESCE((paper_broker_states.state ->> 'orderCounter')::bigint, -1)
          AND (
            COALESCE(jsonb_array_length(EXCLUDED.state -> 'positions'), 0)
            + COALESCE(jsonb_array_length(EXCLUDED.state -> 'closedTrades'), 0)
            + COALESCE(jsonb_array_length(EXCLUDED.state -> 'working'), 0)
          ) >= (
            COALESCE(jsonb_array_length(paper_broker_states.state -> 'positions'), 0)
            + COALESCE(jsonb_array_length(paper_broker_states.state -> 'closedTrades'), 0)
            + COALESCE(jsonb_array_length(paper_broker_states.state -> 'working'), 0)
          )
          AND COALESCE(jsonb_array_length(EXCLUDED.state -> 'orderStates'), 0)
            >= COALESCE(jsonb_array_length(paper_broker_states.state -> 'orderStates'), 0)
          AND COALESCE(jsonb_array_length(EXCLUDED.state -> 'resultsByDedupeKey'), 0)
            >= COALESCE(jsonb_array_length(paper_broker_states.state -> 'resultsByDedupeKey'), 0)
      `,
      [connectionId, JSON.stringify(state)],
    );
  }
}
