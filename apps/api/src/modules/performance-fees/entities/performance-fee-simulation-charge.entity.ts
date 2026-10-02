import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum SimulationChargeStatus {
  DUE_TEST = 'DUE_TEST',
  SETTLED_TEST = 'SETTLED_TEST',
  CANCELLED = 'CANCELLED',
}

export enum SimulationSourceMode {
  PAPER = 'PAPER',
  DEMO = 'DEMO',
}

@Entity({
  name: 'performance_fee_simulation_charges',
  schema: 'performance_fees',
})
@Index(['userId', 'brokerConnectionId', 'status'])
export class PerformanceFeeSimulationCharge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId: string;
  @Column({ name: 'broker_connection_id', type: 'uuid' })
  @Index()
  brokerConnectionId: string;

  @Column({ name: 'source_mode', type: 'varchar', length: 10 })
  sourceMode: SimulationSourceMode;

  @Column({ name: 'currency', type: 'varchar', length: 3 })
  currency: string;

  @Column({ name: 'period_start', type: 'timestamptz', nullable: true })
  periodStart: Date | null;

  @Column({ name: 'period_end', type: 'timestamptz', nullable: true })
  periodEnd: Date | null;

  @Column({ name: 'trade_count', type: 'integer', default: 0 })
  tradeCount: number;

  @Column({ name: 'starting_high_water_mark', type: 'bigint' })
  startingHighWaterMark: string;

  @Column({ name: 'ending_realised_balance', type: 'bigint' })
  endingRealisedBalance: string;
  @Column({ name: 'realised_profit_for_fee', type: 'bigint' })
  realisedProfitForFee: string;

  @Column({ name: 'fee_percent', type: 'numeric', precision: 7, scale: 4 })
  feePercent: string;

  @Column({ name: 'fee_amount', type: 'bigint' })
  feeAmount: string;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  @Index()
  status: SimulationChargeStatus;

  @Column({ name: 'simulated_settled_at', type: 'timestamptz', nullable: true })
  simulatedSettledAt: Date | null;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
