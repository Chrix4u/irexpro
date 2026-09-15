import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * CapitalBudget (Round 6 live-execution completion §3) — the EXPLICIT
 * per-account capital allocation baseline.
 *
 * One row per (userId, logicalAccountKey): the trading capital explicitly
 * allocatable against the logical broker account, denominated in ONE
 * account currency (cross-currency sums are never attempted — §1c).
 *
 * Seeded ONCE from the authoritative broker-account snapshot (§1a routing)
 * at the first allocation request and EXPLICIT thereafter: the budget is a
 * durable allocation decision, not a live equity echo — it never drifts
 * with the market and is never defaulted when the authoritative state is
 * unprovable (typed ALLOCATION_BUDGET_UNPROVABLE instead).
 *
 * Concentration caps are OPTIONAL account-level policy (percent of
 * total_capital, NULL = not enforced for this account): the per-instrument
 * and per-strategy aggregate exposure checks enforce them at allocation
 * time inside the serialized critical section.
 */
@Entity({ name: 'capital_budgets', schema: 'trading' })
@Index('uq_capital_budgets_user_account', ['userId', 'logicalAccountKey'], { unique: true })
export class CapitalBudget {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** The logical broker-account identity the budget is scoped to. */
  @Column({ name: 'logical_account_key', type: 'varchar', length: 255 })
  logicalAccountKey: string;

  /** ISO-4217 — the ONE currency this budget is denominated in. */
  @Column({ name: 'account_currency', type: 'varchar', length: 3 })
  accountCurrency: string;

  /** The explicit allocatable capital (decimal string — never a float). */
  @Column({ name: 'total_capital', type: 'numeric', precision: 18, scale: 8 })
  totalCapital: string;

  /** Optional per-instrument concentration cap (percent, NULL = unenforced). */
  @Column({
    name: 'max_instrument_concentration',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  maxInstrumentConcentration: string | null;

  /** Optional per-strategy concentration cap (percent, NULL = unenforced). */
  @Column({
    name: 'max_strategy_concentration',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  maxStrategyConcentration: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
