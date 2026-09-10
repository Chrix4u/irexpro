import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { AiSignalIdentityStatus } from '../interfaces/execution-authority';

/**
 * AiSignalIdentity — durable immutable signal identity for idempotent
 * processing (architect issue #302).
 *
 * Invariant: (userId, signalId) identifies ONE immutable signal. The
 * canonical payload digest pins the material trading inputs. A re-delivery
 * of the same signalId with a DIFFERENT material payload is a conflict
 * (security event), never a new logical signal.
 *
 * Retries/redeliveries carry the same producer-assigned stable signalId
 * BEFORE network delivery; HTTP retries may never mint fresh identities.
 */
@Entity({ name: 'ai_signal_identities', schema: 'trading' })
@Unique('uq_ai_signal_identity_user_signal', ['userId', 'signalId'])
@Index('idx_ai_signal_identity_user_id', ['userId'])
export class AiSignalIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Stable producer-assigned signal/event ID (mandatory, not optional). */
  @Column({ name: 'signal_id', type: 'varchar', length: 100 })
  signalId: string;

  /** SHA-256 canonical digest of the immutable signal payload. */
  @Column({ name: 'payload_digest', type: 'varchar', length: 64 })
  payloadDigest: string;

  /** Material trading inputs snapshotted for conflict detection. */
  @Column({ name: 'material_fields', type: 'jsonb' })
  materialFields: Record<string, unknown>;

  /** Producer-assigned generation timestamp (freshness + future-skew checks). */
  @Column({ name: 'generated_at', type: 'timestamptz' })
  generatedAt: Date;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'NOW()' })
  receivedAt: Date;

  @Column({ name: 'first_processed_at', type: 'timestamptz', nullable: true })
  firstProcessedAt: Date | null;

  @Column({ name: 'status', type: 'varchar', length: 30, default: AiSignalIdentityStatus.RECEIVED })
  status: AiSignalIdentityStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
