import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BillingFrequency {
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  ANNUAL = 'ANNUAL',
  ON_PROFIT_EVENT = 'ON_PROFIT_EVENT',
}

export enum CalculationMode {
  HIGH_WATER_MARK = 'HIGH_WATER_MARK',
}

export enum AppliesToMode {
  REALISED_PROFIT_ONLY = 'REALISED_PROFIT_ONLY',
}

/**
 * PerformanceFeePolicy
 *
 * Defines terms under which a performance fee is charged.
 * - feePercent is a percentage value (e.g. 20.0000 = 20%)
 * - Fees apply ONLY to realised closed-trade profit above the high-water mark.
 * - Fees NEVER apply to deposits, top-ups, bonuses, credits, or unrealised/floating P&L.
 * - Demo, paper, or backtest trading results are EXCLUDED from fee calculations.
 */
@Entity({ name: 'performance_fee_policies', schema: 'performance_fees' })
export class PerformanceFeePolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Optional: if null, policy applies to all plans */
  @Column({ name: 'plan_id', type: 'uuid', nullable: true })
  @Index()
  planId: string | null;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name: string;

  /**
   * Performance fee percentage (e.g. 20.0000 = 20%).
   * Stored with 4 decimal places of precision.
   */
  @Column({ name: 'fee_percent', type: 'numeric', precision: 7, scale: 4 })
  feePercent: string;

  @Column({
    name: 'billing_frequency',
    type: 'enum',
    enum: BillingFrequency,
  })
  billingFrequency: BillingFrequency;

  @Column({
    name: 'calculation_mode',
    type: 'enum',
    enum: CalculationMode,
    default: CalculationMode.HIGH_WATER_MARK,
  })
  calculationMode: CalculationMode;

  @Column({
    name: 'applies_to',
    type: 'enum',
    enum: AppliesToMode,
    default: AppliesToMode.REALISED_PROFIT_ONLY,
  })
  appliesTo: AppliesToMode;

  @Column({ name: 'version', type: 'integer', default: 1 })
  version: number;

  @Column({ name: 'effective_from', type: 'timestamptz', default: () => 'NOW()' })
  effectiveFrom: Date;

  @Column({ name: 'effective_to', type: 'timestamptz', nullable: true })
  effectiveTo: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
