import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaperBrokerState } from '../entities/paper-broker-state.entity';

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
