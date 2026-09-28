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
      `,
      [connectionId, JSON.stringify(state)],
    );
  }
}
