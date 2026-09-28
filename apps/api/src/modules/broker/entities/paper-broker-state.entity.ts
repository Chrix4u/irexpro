import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'paper_broker_states', schema: 'broker' })
export class PaperBrokerState {
  @PrimaryColumn({ name: 'connection_id', type: 'uuid' })
  connectionId: string;

  @Column({ name: 'state_version', type: 'integer', default: 1 })
  stateVersion: number;

  @Column({ name: 'state', type: 'jsonb' })
  state: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
