import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum KycStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * Legacy Sprint 29 trading-experience enum.
 *
 * Retained only for database/backward compatibility. It is no longer
 * user-editable and MUST NOT drive risk limits, model selection, position
 * sizing, or automation behavior. iRexPro applies server-governed risk policy
 * independently of a user's historical self-reported experience.
 */
export enum TradingExperienceLevel {
  BEGINNER = 'BEGINNER',
  INTERMEDIATE = 'INTERMEDIATE',
  ADVANCED = 'ADVANCED',
  PROFESSIONAL = 'PROFESSIONAL',
}

@Entity({ name: 'user_profiles', schema: 'identity' })
export class UserProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'first_name', type: 'varchar', length: 100, nullable: true })
  firstName: string | null;

  @Column({ name: 'last_name', type: 'varchar', length: 100, nullable: true })
  lastName: string | null;

  @Column({ name: 'display_name', type: 'varchar', length: 100, nullable: true })
  displayName: string | null;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: string | null;

  @Column({ name: 'address_line1', type: 'varchar', length: 255, nullable: true })
  addressLine1: string | null;

  @Column({ name: 'address_line2', type: 'varchar', length: 255, nullable: true })
  addressLine2: string | null;

  @Column({ name: 'address_city', type: 'varchar', length: 100, nullable: true })
  addressCity: string | null;

  @Column({ name: 'address_state', type: 'varchar', length: 100, nullable: true })
  addressState: string | null;

  @Column({ name: 'address_postal_code', type: 'varchar', length: 20, nullable: true })
  addressPostalCode: string | null;

  @Column({ name: 'address_country', type: 'varchar', length: 2, nullable: true })
  addressCountry: string | null;

  @Column({
    name: 'kyc_status',
    type: 'enum',
    enum: KycStatus,
    default: KycStatus.NONE,
  })
  kycStatus: KycStatus;

  @Column({ name: 'kyc_submitted_at', type: 'timestamptz', nullable: true })
  kycSubmittedAt: Date | null;

  @Column({ name: 'kyc_approved_at', type: 'timestamptz', nullable: true })
  kycApprovedAt: Date | null;

  @Column({ name: 'risk_disclosure_accepted', type: 'boolean', default: false })
  riskDisclosureAccepted: boolean;

  @Column({ name: 'risk_disclosure_accepted_at', type: 'timestamptz', nullable: true })
  riskDisclosureAcceptedAt: Date | null;

  /**
   * Legacy compatibility field only. Not authoritative for trading behavior.
   */
  @Column({
    name: 'trading_experience_level',
    type: 'enum',
    enum: TradingExperienceLevel,
    nullable: true,
  })
  tradingExperienceLevel: TradingExperienceLevel | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(() => User, (user) => user.profile)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
