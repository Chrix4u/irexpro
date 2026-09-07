import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { UserProfile } from './user-profile.entity';
import { UserRole } from './user-role.entity';

export enum UserStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  PERMANENTLY_LOCKED = 'PERMANENTLY_LOCKED',
  CLOSED = 'CLOSED',
}

@Entity({ name: 'users', schema: 'identity' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true, length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  phone: string | null;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  @Exclude()
  passwordHash: string;

  // The baseline migration stores this stable domain as varchar; the database
  // CHECK constraint added by account governance is the persistence boundary.
  @Column({
    type: 'varchar',
    length: 30,
    enum: UserStatus,
    default: UserStatus.PENDING_VERIFICATION,
  })
  status: UserStatus;

  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ name: 'phone_verified_at', type: 'timestamptz', nullable: true })
  phoneVerifiedAt: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  /** Consecutive invalid-password attempts since the last success/expired lock. */
  @Column({ name: 'failed_login_attempts', type: 'integer', default: 0 })
  @Exclude()
  failedLoginAttempts: number;

  /** Temporary abuse lock. Separate from the permanent account status lifecycle. */
  @Column({ name: 'login_locked_until', type: 'timestamptz', nullable: true })
  @Exclude()
  loginLockedUntil: Date | null;

  @Column({ name: 'country_code', type: 'varchar', length: 2, nullable: true })
  countryCode: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  timezone: string | null;

  @Column({ name: 'preferred_currency', type: 'varchar', length: 3, nullable: true })
  preferredCurrency: string | null;

  @Column({ name: 'mfa_enabled', type: 'boolean', default: false })
  mfaEnabled: boolean;

  @Column({ name: 'mfa_secret', type: 'varchar', length: 255, nullable: true })
  @Exclude()
  mfaSecret: string | null;

  /** Expiry for a not-yet-confirmed TOTP enrollment. Null once MFA is active. */
  @Column({ name: 'mfa_setup_expires_at', type: 'timestamptz', nullable: true })
  @Exclude()
  mfaSetupExpiresAt: Date | null;

  /**
   * Server-side authentication generation.
   *
   * Every access/refresh token carries this value. Refresh, logout, and
   * password reset advance it, immediately invalidating tokens issued under
   * an older generation without storing raw JWTs.
   */
  @Column({ name: 'session_version', type: 'integer', default: 1 })
  @Exclude()
  sessionVersion: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @OneToOne(() => UserProfile, (profile) => profile.user, { cascade: true, eager: false })
  profile: UserProfile;

  @OneToMany(() => UserRole, (userRole) => userRole.user, { cascade: true })
  userRoles: UserRole[];
}
