import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * TradingAuthorityGeneration — per-user monotonic authority generation
 * (architect issue #300).
 *
 * Advanced atomically (compare-and-set) whenever a user-authority fact
 * changes: account suspension/deactivation, KYC reversal, disclosure
 * policy/version change, consent revocation, jurisdiction change, risk
 * acknowledgement change, administrative restriction.
 *
 * Every RiskGrant binds the authorityGeneration observed at issuance. The
 * final dispatch boundary re-reads the CURRENT generation — a mismatch
 * invalidates NEW exposure (risk-reducing operations remain available).
 *
 * Revoking login sessions alone does not bump this generation: queued AI
 * trading authority is invalidated by the facts above, not by auth-token
 * lifecycle.
 */
@Entity({ name: 'trading_authority_generations', schema: 'identity' })
@Unique('uq_trading_authority_generation_user', ['userId'])
export class TradingAuthorityGeneration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Monotonic generation — only ever increased via CAS. */
  @Column({ name: 'generation', type: 'integer', default: 1 })
  generation: number;

  /** Human-readable reason for the last bump (audit correlation). */
  @Column({ name: 'last_reason', type: 'varchar', length: 200, nullable: true })
  lastReason: string | null;

  @Column({ name: 'last_bumped_at', type: 'timestamptz', nullable: true })
  lastBumpedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
