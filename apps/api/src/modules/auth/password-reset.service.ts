import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, DataSource } from 'typeorm';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import * as argon2 from 'argon2';
import { PasswordResetToken, ResetChannel } from './entities/password-reset-token.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { normalizePhone, isEmail } from './utils/phone.util';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { PasswordResetDeliveryService } from './password-reset-delivery.service';

/**
 * PasswordResetService — secure password reset flow.
 *
 * Security properties:
 *   - Raw token/code is NEVER stored.
 *   - High-entropy email tokens use SHA-256 lookup digests.
 *   - Low-entropy phone codes use a domain-separated HMAC-SHA-256 digest with
 *     the production-required AUTH_VERIFICATION_PEPPER.
 *   - Email token is 32 random bytes; phone code is 6 digits.
 *   - Email link expires in 15 minutes; phone code in 10 minutes.
 *   - Reset-token issuance is serialized per user before prior unused tokens
 *     are invalidated and the replacement token is persisted.
 *   - Reset tokens are single-use and prior unused tokens are invalidated.
 *   - Phone code is invalidated after 5 failed attempts.
 *   - Request metadata is bounded to its database contract before persistence.
 *   - Request response is generic to prevent account enumeration.
 *   - Raw token/code/pepper is NEVER logged.
 *   - Successful password reset advances User.sessionVersion and retires any
 *     pending (not yet enabled) MFA enrollment in the same DB transaction as
 *     the password change. Active MFA secrets are preserved.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  private static readonly EMAIL_TOKEN_BYTES = 32;
  private static readonly PHONE_CODE_LENGTH = 6;
  private static readonly EMAIL_TOKEN_EXPIRY_MS = 15 * 60 * 1000;
  private static readonly PHONE_CODE_EXPIRY_MS = 10 * 60 * 1000;
  private static readonly MAX_PHONE_CODE_ATTEMPTS = 5;
  private static readonly MAX_REQUEST_USER_AGENT_LENGTH = 500;

  constructor(
    @InjectRepository(PasswordResetToken)
    private resetTokenRepo: Repository<PasswordResetToken>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private configService: ConfigService,
    private auditService: AuditService,
    private deliveryService: PasswordResetDeliveryService,
    private dataSource: DataSource,
  ) {}

  async requestReset(
    identifier: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<PasswordResetResult> {
    const requestMeta = this.normalizeRequestMeta(meta);
    const trimmed = identifier.trim();
    const user = await this.findUserByIdentifier(trimmed);

    if (!user) {
      this.logger.log(
        'Password reset requested for unknown identifier — returning generic response',
      );
      return { delivered: false, channel: null };
    }

    if (
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.PERMANENTLY_LOCKED ||
      user.status === UserStatus.CLOSED
    ) {
      this.logger.log(
        `Password reset requested for ${user.status} user — returning generic response`,
      );
      return { delivered: false, channel: null };
    }

    const channel: ResetChannel = user.email ? ResetChannel.EMAIL : ResetChannel.PHONE;
    const destination = channel === ResetChannel.EMAIL ? user.email! : user.phone!;

    // Generate the secret before acquiring the issuance lock. In particular,
    // a missing phone-code pepper must fail closed without invalidating an
    // existing usable reset token.
    const { rawToken, tokenHash } = this.generateToken(channel, user.id, destination);

    const expiresAt = new Date(
      Date.now() +
        (channel === ResetChannel.EMAIL
          ? PasswordResetService.EMAIL_TOKEN_EXPIRY_MS
          : PasswordResetService.PHONE_CODE_EXPIRY_MS),
    );

    const resetToken = this.resetTokenRepo.create({
      userId: user.id,
      tokenHash,
      channel,
      destinationHash: this.hashDestination(destination),
      expiresAt,
      usedAt: null,
      requestedIp: requestMeta.ipAddress ?? null,
      userAgent: requestMeta.userAgent ?? null,
      attemptCount: 0,
    });

    const persisted = await this.persistIssuedResetToken(user.id, resetToken);
    if (!persisted) {
      this.logger.log(
        'Password reset user disappeared during issuance — returning generic response',
      );
      return { delivered: false, channel: null };
    }

    // External delivery is intentionally outside the DB transaction. Holding
    // the per-user row lock across network I/O would unnecessarily serialize
    // unrelated database work and prolong lock duration.
    const delivered = await this.deliveryService.deliver({
      channel,
      destination,
      rawToken,
      userId: user.id,
      userName: user.email ?? user.phone ?? user.id,
      ...(user.countryCode ? { countryCode: user.countryCode } : {}),
    });

    await this.auditService.log({
      actorUserId: user.id,
      action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: { channel, delivered, expiresAt: expiresAt.toISOString() },
    });

    return { delivered, channel };
  }

  async resetWithToken(token: string, password: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const resetToken = await this.resetTokenRepo.findOne({
      where: { tokenHash, channel: ResetChannel.EMAIL },
    });

    if (!resetToken) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    this.validateTokenUsable(resetToken);
    await this.applyPasswordReset(resetToken, password);
  }

  async resetWithCode(identifier: string, code: string, password: string): Promise<void> {
    const trimmed = identifier.trim();
    if (!trimmed) {
      throw new BadRequestException('Identifier is required for phone code reset');
    }

    const user = await this.findUserByIdentifier(trimmed);
    if (!user || !user.phone) {
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    // Find the active record independently of the caller-supplied code so an
    // incorrect guess still reaches the token's attempt counter.
    const resetToken = await this.resetTokenRepo.findOne({
      where: { userId: user.id, channel: ResetChannel.PHONE, usedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    if (!resetToken) {
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    if (resetToken.expiresAt.getTime() <= Date.now()) {
      await this.resetTokenRepo.update(
        { id: resetToken.id, usedAt: IsNull() },
        { usedAt: new Date() },
      );
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    const pepper = this.verificationPepper();
    const candidateHash = this.hashPhoneCode(user.id, user.phone, code, pepper);
    if (!this.safeDigestEqual(resetToken.tokenHash, candidateHash)) {
      const nextAttemptCount = resetToken.attemptCount + 1;
      const exhausted = nextAttemptCount >= PasswordResetService.MAX_PHONE_CODE_ATTEMPTS;
      const updated = await this.resetTokenRepo.update(
        { id: resetToken.id, usedAt: IsNull(), attemptCount: resetToken.attemptCount },
        {
          attemptCount: nextAttemptCount,
          ...(exhausted ? { usedAt: new Date() } : {}),
        },
      );
      if (updated?.affected !== undefined && updated.affected !== 1) {
        throw new UnauthorizedException('Invalid or expired reset code');
      }
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    await this.applyPhonePasswordReset(resetToken, password);
  }

  private normalizeRequestMeta(meta?: PasswordResetRequestMeta): PasswordResetRequestMeta {
    return {
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent?.slice(0, PasswordResetService.MAX_REQUEST_USER_AGENT_LENGTH),
    };
  }

  private async findUserByIdentifier(identifier: string): Promise<User | null> {
    const emailLogin = isEmail(identifier);
    const phoneLookup = emailLogin ? null : normalizePhone(identifier);

    return this.userRepo.findOne({
      where: emailLogin ? { email: identifier.toLowerCase() } : { phone: phoneLookup ?? '' },
    });
  }

  private async persistIssuedResetToken(
    userId: string,
    resetToken: PasswordResetToken,
  ): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Serialize reset-token issuance for a user. A concurrent requester must
      // wait here, then invalidate the token created by the previous requester
      // before persisting its own replacement.
      const lockedUser = await queryRunner.manager.findOne(User, {
        where: { id: userId },
        select: { id: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!lockedUser) {
        await queryRunner.rollbackTransaction();
        return false;
      }

      const resetTokenRepo = queryRunner.manager.getRepository(PasswordResetToken);
      await resetTokenRepo.update({ userId, usedAt: IsNull() }, { usedAt: new Date() });
      await resetTokenRepo.save(resetToken);

      await queryRunner.commitTransaction();
      return true;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private generateToken(
    channel: ResetChannel,
    userId: string,
    destination: string,
  ): { rawToken: string; tokenHash: string } {
    if (channel === ResetChannel.EMAIL) {
      const rawToken = randomBytes(PasswordResetService.EMAIL_TOKEN_BYTES).toString('hex');
      return { rawToken, tokenHash: this.hashToken(rawToken) };
    }
    const rawToken = String(randomInt(0, 10 ** PasswordResetService.PHONE_CODE_LENGTH)).padStart(
      PasswordResetService.PHONE_CODE_LENGTH,
      '0',
    );
    const tokenHash = this.hashPhoneCode(userId, destination, rawToken, this.verificationPepper());
    return { rawToken, tokenHash };
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private hashDestination(destination: string): string {
    return createHash('sha256').update(destination.toLowerCase()).digest('hex');
  }

  private verificationPepper(): string {
    const pepper = this.configService.get<string>('auth.verificationPepper');
    if (!pepper || pepper.length < 32) {
      throw new ServiceUnavailableException('Phone password reset is temporarily unavailable');
    }
    return pepper;
  }

  private hashPhoneCode(userId: string, destination: string, code: string, pepper: string): string {
    return createHmac('sha256', pepper)
      .update(`password-reset:${userId}:${destination.toLowerCase()}:${code}`, 'utf8')
      .digest('hex');
  }

  private safeDigestEqual(storedHex: string, candidateHex: string): boolean {
    const stored = Buffer.from(storedHex, 'hex');
    const candidate = Buffer.from(candidateHex, 'hex');
    return stored.length === 32 && candidate.length === 32 && timingSafeEqual(stored, candidate);
  }

  private validateTokenUsable(resetToken: PasswordResetToken): void {
    if (resetToken.usedAt) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }
    if (new Date() > resetToken.expiresAt) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }
  }

  private async applyPhonePasswordReset(
    resetToken: PasswordResetToken,
    password: string,
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const consumedAt = new Date();
      const consumed = await queryRunner.manager.update(
        PasswordResetToken,
        {
          id: resetToken.id,
          usedAt: IsNull(),
          attemptCount: resetToken.attemptCount,
        },
        { usedAt: consumedAt },
      );
      if (consumed?.affected !== undefined && consumed.affected !== 1) {
        throw new UnauthorizedException('Invalid or expired reset code');
      }

      const passwordHash = await this.hashNewPassword(password);
      await queryRunner.manager.update(User, resetToken.userId, { passwordHash });

      // Pending TOTP setup was authorized under the pre-reset password state.
      // Clear it transactionally, but scope the update to mfaEnabled=false so
      // an already-active MFA secret is never removed by password reset.
      await queryRunner.manager.update(
        User,
        { id: resetToken.userId, mfaEnabled: false },
        { mfaSecret: null, mfaSetupExpiresAt: null },
      );

      await queryRunner.manager.update(User, resetToken.userId, {
        sessionVersion: () => '"session_version" + 1',
      });

      await queryRunner.commitTransaction();

      await this.logCompletedReset(resetToken.userId, resetToken.channel);
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async applyPasswordReset(
    resetToken: PasswordResetToken,
    password: string,
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Consume the email token before mutating the user. Only one concurrent
      // transaction can change an unused row; replays lose this compare-and-set
      // and cannot reach the password/session updates below.
      const consumed = await queryRunner.manager.update(
        PasswordResetToken,
        { id: resetToken.id, usedAt: IsNull() },
        { usedAt: new Date() },
      );
      if (consumed.affected !== 1) {
        throw new UnauthorizedException('Invalid or expired reset token');
      }

      const passwordHash = await this.hashNewPassword(password);

      // Keep the password update as a separate statement so audit/tests can
      // verify that only the hash is written here.
      await queryRunner.manager.update(User, resetToken.userId, { passwordHash });

      // A pending MFA enrollment was authorized using the old password. Retire
      // only that pending state; the predicate deliberately preserves enabled
      // MFA and its TOTP secret.
      await queryRunner.manager.update(
        User,
        { id: resetToken.userId, mfaEnabled: false },
        { mfaSecret: null, mfaSetupExpiresAt: null },
      );

      // Revoke every JWT issued before the reset in the SAME transaction.
      // A successful reset therefore cannot commit while old sessions remain
      // valid server-side.
      await queryRunner.manager.update(User, resetToken.userId, {
        sessionVersion: () => '"session_version" + 1',
      });

      await queryRunner.commitTransaction();

      await this.logCompletedReset(resetToken.userId, resetToken.channel);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async hashNewPassword(password: string): Promise<string> {
    return argon2.hash(password, {
      memoryCost: this.configService.get<number>('auth.argon2MemoryCost', 65536),
      timeCost: this.configService.get<number>('auth.argon2TimeCost', 3),
      parallelism: this.configService.get<number>('auth.argon2Parallelism', 1),
    });
  }

  private async logCompletedReset(userId: string, channel: ResetChannel): Promise<void> {
    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.USER_PASSWORD_RESET_COMPLETED,
      resourceType: 'User',
      resourceId: userId,
      metadata: { channel, sessionsRevoked: true },
    });

    this.logger.log('Password reset completed');
  }
}

export interface PasswordResetResult {
  delivered: boolean;
  channel: ResetChannel | null;
}

export interface PasswordResetRequestMeta {
  ipAddress?: string;
  userAgent?: string;
}
