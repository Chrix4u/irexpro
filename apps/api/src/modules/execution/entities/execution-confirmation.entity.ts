import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ExecutionConfirmationStatus } from '../interfaces/execution-authority';

/**
 * ExecutionConfirmation — the server-verifiable ONE-TIME user confirmation
 * for SEMI_AUTO NEW exposure (architect issue #298).
 *
 * Bound to: userId, sessionId, sessionGeneration, signalId,
 * brokerConnectionId, the exact order payload digest, quantity, instrument,
 * direction, SL/TP, the RiskGrant it authorizes, an expiration, and a
 * one-time consumption state.
 *
 * Invariants:
 *  - a confirmation for signal/order A may never authorize B;
 *  - editing material order parameters invalidates it (digest mismatch);
 *  - concurrent use produces exactly ONE winner (CAS consume);
 *  - session generation change revokes outstanding confirmations;
 *  - replay of a consumed confirmation fails.
 */
@Entity({ name: 'execution_confirmations', schema: 'trading' })
@Index('idx_exec_confirmations_user_id', ['userId'])
@Index('idx_exec_confirmations_session_id', ['sessionId'])
@Index('idx_exec_confirmations_signal_id', ['signalId'])
export class ExecutionConfirmation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

  /** Session authority generation when the confirmation was created. */
  @Column({ name: 'session_generation', type: 'integer' })
  sessionGeneration: number;

  @Column({ name: 'signal_id', type: 'varchar', length: 100 })
  signalId: string;

  /** EXACT broker connection the confirmed order targets. */
  @Column({ name: 'broker_connection_id', type: 'uuid' })
  brokerConnectionId: string;

  /** The RiskGrant this confirmation authorizes (issued after user approval). */
  @Column({ name: 'risk_grant_id', type: 'uuid', nullable: true })
  riskGrantId: string | null;

  /** SHA-256 canonical digest of the EXACT order payload being confirmed. */
  @Column({ name: 'order_payload_digest', type: 'varchar', length: 64 })
  orderPayloadDigest: string;

  @Column({ name: 'instrument', type: 'varchar', length: 50 })
  instrument: string;

  @Column({ name: 'direction', type: 'varchar', length: 10 })
  direction: string;

  /** Exact-decimal quantity string. */
  @Column({ name: 'quantity', type: 'numeric', precision: 18, scale: 8 })
  quantity: string;

  @Column({ name: 'stop_loss', type: 'numeric', precision: 18, scale: 8, nullable: true })
  stopLoss: string | null;

  @Column({ name: 'take_profit', type: 'numeric', precision: 18, scale: 8, nullable: true })
  takeProfit: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 30,
    default: ExecutionConfirmationStatus.PENDING,
  })
  status: ExecutionConfirmationStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
