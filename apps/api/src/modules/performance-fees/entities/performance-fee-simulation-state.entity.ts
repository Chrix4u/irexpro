import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'performance_fee_simulation_states',
  schema: 'performance_fees',
})
@Index(['userId', 'brokerConnectionId'], { unique: true })
export class PerformanceFeeSimulationState {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;

  @Column({ name: 'broker_connection_id', type: 'uuid' })
  @Index()
  brokerConnectionId: string;

  @Column({ name: 'currency', type: 'varchar', length: 3 })
  currency: string;
  @Column({
    name: 'current_high_water_mark',
    type: 'bigint',
    default: '0',
  })
  currentHighWaterMark: string;

  @Column({
    name: 'total_fees_simulated',
    type: 'bigint',
    default: '0',
  })
  totalFeesSimulated: string;

  @Column({
    name: 'last_settled_realised_balance',
    type: 'bigint',
    default: '0',
  })
  lastSettledRealisedBalance: string;

  @Column({
    name: 'last_simulated_settlement_at',
    type: 'timestamptz',
    nullable: true,
  })
  lastSimulatedSettlementAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
