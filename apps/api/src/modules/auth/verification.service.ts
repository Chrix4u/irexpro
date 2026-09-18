import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { EmailVerificationDeliveryService } from './email-verification-delivery.service';
import {
  AuthVerificationToken,
  VerificationChannel,
} from './entities/auth-verification-token.entity';
import { PhoneVerificationDeliveryService } from './phone-verification-delivery.service';

@Injectable()
export class VerificationService {
  private static readonly EMAIL_TOKEN_TTL_MINUTES = 15;
  private static readonly PHONE_CODE_TTL_MINUTES = 10;
  private static readonly PHONE_MAX_ATTEMPTS = 5;
  private static readonly MAX_REQUEST_USER_AGENT_LENGTH = 500;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(AuthVerificationToken)
    private readonly tokenRepo: Repository<AuthVerificationToken>,
    private readonly emailDelivery: EmailVerificationDeliveryService,
    private readonly phoneDelivery: PhoneVerificationDeliveryService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async requestEmailVerification(
    userId: string,
    context: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    const requestContext = this.normalizeRequestContext(context);
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User session is no longer valid');
    if (!user.email)
      throw new BadRequestException('No email address is registered on this account');
    if (user.emailVerifiedAt) return;

    const webBaseUrl = this.configService.get<string>('app.webBaseUrl');
    if (!webBaseUrl || !this.emailDelivery.isConfigured()) {
      throw new ServiceUnavailableException('Email verification is temporarily unavailable');
    }

    // Generate the single-use challenge before acquiring the issuance lock so
    // configuration/entropy failures cannot invalidate an existing challenge.
    const now = new Date();
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.hash(rawToken);
    const expiresAt = new Date(
      now.getTime() + VerificationService.EMAIL_TOKEN_TTL_MINUTES * 60 * 1000,
    );

    const record = this.tokenRepo.create({
      userId: user.id,
      tokenHash,
      channel: VerificationChannel.EMAIL,
      expiresAt,
      usedAt: null,
      requestedIp: requestContext.ipAddress ?? null,
      userAgent: requestContext.userAgent ?? null,
      attemptCount: 0,
    });

    const persisted = await this.persistIssuedChallenge(user.id, VerificationChannel.EMAIL, record);
    if (!persisted) throw new UnauthorizedException('User session is no longer valid');

    // External delivery is intentionally outside the DB transaction so network
    // I/O never extends the per-user issuance lock.
    const verificationLink = `${webBaseUrl.replace(/\/$/u, '')}/verify-email#token=${encodeURIComponent(rawToken)}`;
    const fromAddress = this.configService.get<string>('email.fromAddress', 'no-reply@irexpro.com');
    const delivered = await this.emailDelivery.send({
      to: user.email,
      verificationLink,
      fromAddress,
    });

    await this.auditService.log({
      actorUserId: user.id,
      action: AuditAction.USER_EMAIL_VERIFICATION_REQUESTED,
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: requestContext.ipAddress,
      userAgent: requestContext.userAgent,
      metadata: {
        result: delivered ? 'sent' : 'delivery_failed',
        channel: 'email',
      },
    });

    if (!delivered) {
      throw new ServiceUnavailableException('Email verification is temporarily unavailable');
    }
  }

  async verifyEmail(rawToken: string, ipAddress?: string): Promise<void> {
    const tokenHash = this.hash(rawToken);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let verifiedUserId: string | null = null;
    try {
      const token = await queryRunner.manager.findOne(AuthVerificationToken, {
        where: {
          tokenHash,
          channel: VerificationChannel.EMAIL,
          usedAt: IsNull(),
        },
      });

      if (!token || token.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Invalid or expired verification token');
      }

      const consumed = await queryRunner.manager.update(
        AuthVerificationToken,
        { id: token.id, usedAt: IsNull() },
        { usedAt: new Date() },
      );
      if (consumed.affected !== 1) {
        throw new UnauthorizedException('Invalid or expired verification token');
      }

      const user = await queryRunner.manager.findOne(User, { where: { id: token.userId } });
      if (!user) throw new UnauthorizedException('Invalid or expired verification token');

      const userUpdate: Partial<User> = { emailVerifiedAt: new Date() };
      if (user.status === UserStatus.PENDING_VERIFICATION) {
        userUpdate.status = UserStatus.ACTIVE;
      }
      await queryRunner.manager.update(User, user.id, userUpdate);

      await queryRunner.commitTransaction();
      verifiedUserId = user.id;
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    if (verifiedUserId) {
      await this.auditService.log({
        actorUserId: verifiedUserId,
        action: AuditAction.USER_EMAIL_VERIFIED,
        resourceType: 'User',
        resourceId: verifiedUserId,
        ipAddress,
        metadata: { result: 'success', channel: 'email' },
      });
    }
  }

  async requestPhoneVerification(
    userId: string,
    context: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    const requestContext = this.normalizeRequestContext(context);
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User session is no longer valid');
    if (!user.phone) throw new BadRequestException('No phone number is registered on this account');
    if (user.phoneVerifiedAt) return;
    if (!/^\+[1-9]\d{7,14}$/u.test(user.phone)) {
      throw new BadRequestException('Registered phone number cannot be verified');
    }
    if (!this.phoneDelivery.isConfigured(user.countryCode ?? 'ZZ')) {
      throw new ServiceUnavailableException('Phone verification is temporarily unavailable');
    }

    // Resolve the required pepper and generate the challenge before acquiring
    // the issuance lock. A missing/invalid pepper must not consume an existing
    // usable phone verification challenge.
    const pepper = this.verificationPepper();
    const now = new Date();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const tokenHash = this.hashPhoneCode(user.id, user.phone, code, pepper);
    const expiresAt = new Date(
      now.getTime() + VerificationService.PHONE_CODE_TTL_MINUTES * 60 * 1000,
    );
    const record = this.tokenRepo.create({
      userId: user.id,
      tokenHash,
      channel: VerificationChannel.PHONE,
      expiresAt,
      usedAt: null,
      requestedIp: requestContext.ipAddress ?? null,
      userAgent: requestContext.userAgent ?? null,
      attemptCount: 0,
    });

    const persisted = await this.persistIssuedChallenge(user.id, VerificationChannel.PHONE, record);
    if (!persisted) throw new UnauthorizedException('User session is no longer valid');

    const delivered = await this.phoneDelivery.sendVerificationCode(
      user.phone,
      code,
      user.countryCode ?? 'ZZ',
    );
    if (!delivered) {
      await this.tokenRepo.update(
        {
          userId: user.id,
          channel: VerificationChannel.PHONE,
          tokenHash,
          usedAt: IsNull(),
        },
        { usedAt: new Date() },
      );
    }

    await this.auditService.log({
      actorUserId: user.id,
      action: AuditAction.USER_PHONE_VERIFICATION_REQUESTED,
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: requestContext.ipAddress,
      userAgent: requestContext.userAgent,
      metadata: {
        result: delivered ? 'sent' : 'delivery_failed',
        channel: 'phone',
      },
    });

    if (!delivered) {
      throw new ServiceUnavailableException('Phone verification is temporarily unavailable');
    }
  }

  async verifyPhone(userId: string, code: string, ipAddress?: string): Promise<void> {
    const pepper = this.verificationPepper();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let verifiedUserId: string | null = null;
    let failure: { reason: string; attemptsRemaining: number } | null = null;

    try {
      const user = await queryRunner.manager.findOne(User, { where: { id: userId } });
      if (!user) throw new UnauthorizedException('User session is no longer valid');
      if (!user.phone)
        throw new BadRequestException('No phone number is registered on this account');
      if (user.phoneVerifiedAt) {
        await queryRunner.commitTransaction();
        return;
      }

      const token = await queryRunner.manager.findOne(AuthVerificationToken, {
        where: {
          userId: user.id,
          channel: VerificationChannel.PHONE,
          usedAt: IsNull(),
        },
        order: { createdAt: 'DESC' },
      });

      if (!token) {
        throw new UnauthorizedException('Invalid or expired verification code');
      }

      if (token.expiresAt.getTime() <= Date.now()) {
        await queryRunner.manager.update(
          AuthVerificationToken,
          { id: token.id, usedAt: IsNull() },
          { usedAt: new Date() },
        );
        await queryRunner.commitTransaction();
        failure = { reason: 'expired', attemptsRemaining: 0 };
      } else {
        const candidateHash = this.hashPhoneCode(user.id, user.phone, code, pepper);
        if (!this.safeDigestEqual(token.tokenHash, candidateHash)) {
          const nextAttemptCount = token.attemptCount + 1;
          const attemptsRemaining = Math.max(
            VerificationService.PHONE_MAX_ATTEMPTS - nextAttemptCount,
            0,
          );
          const exhausted = attemptsRemaining === 0;
          const updated = await queryRunner.manager.update(
            AuthVerificationToken,
            { id: token.id, usedAt: IsNull(), attemptCount: token.attemptCount },
            {
              attemptCount: nextAttemptCount,
              ...(exhausted ? { usedAt: new Date() } : {}),
            },
          );
          if (updated.affected !== 1) {
            throw new UnauthorizedException('Invalid or expired verification code');
          }
          await queryRunner.commitTransaction();
          failure = {
            reason: exhausted ? 'attempts_exhausted' : 'invalid_code',
            attemptsRemaining,
          };
        } else {
          const consumed = await queryRunner.manager.update(
            AuthVerificationToken,
            { id: token.id, usedAt: IsNull(), attemptCount: token.attemptCount },
            { usedAt: new Date() },
          );
          if (consumed.affected !== 1) {
            throw new UnauthorizedException('Invalid or expired verification code');
          }

          const userUpdate: Partial<User> = { phoneVerifiedAt: new Date() };
          if (user.status === UserStatus.PENDING_VERIFICATION) {
            userUpdate.status = UserStatus.ACTIVE;
          }
          await queryRunner.manager.update(User, user.id, userUpdate);
          await queryRunner.commitTransaction();
          verifiedUserId = user.id;
        }
      }
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    if (failure) {
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.USER_PHONE_VERIFICATION_FAILED,
        resourceType: 'User',
        resourceId: userId,
        ipAddress,
        metadata: {
          result: 'failed',
          channel: 'phone',
          reason: failure.reason,
          attemptsRemaining: failure.attemptsRemaining,
        },
      });
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    if (verifiedUserId) {
      await this.auditService.log({
        actorUserId: verifiedUserId,
        action: AuditAction.USER_PHONE_VERIFIED,
        resourceType: 'User',
        resourceId: verifiedUserId,
        ipAddress,
        metadata: { result: 'success', channel: 'phone' },
      });
    }
  }

  private async persistIssuedChallenge(
    userId: string,
    channel: VerificationChannel,
    record: AuthVerificationToken,
  ): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // The user row is the canonical serialization point. This intentionally
      // serializes issuance for the account while only invalidating the target
      // channel, so EMAIL and PHONE challenge state remain independent.
      const lockedUser = await queryRunner.manager.findOne(User, {
        where: { id: userId },
        select: { id: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!lockedUser) {
        await queryRunner.rollbackTransaction();
        return false;
      }

      const tokenRepo = queryRunner.manager.getRepository(AuthVerificationToken);
      await tokenRepo.update({ userId, channel, usedAt: IsNull() }, { usedAt: new Date() });
      await tokenRepo.save(record);

      await queryRunner.commitTransaction();
      return true;
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private normalizeRequestContext(context: { ipAddress?: string; userAgent?: string }): {
    ipAddress?: string;
    userAgent?: string;
  } {
    return {
      ipAddress: context.ipAddress,
      userAgent: context.userAgent?.slice(0, VerificationService.MAX_REQUEST_USER_AGENT_LENGTH),
    };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private verificationPepper(): string {
    const pepper = this.configService.get<string>('auth.verificationPepper');
    if (!pepper || pepper.length < 32) {
      throw new ServiceUnavailableException('Phone verification is temporarily unavailable');
    }
    return pepper;
  }

  private hashPhoneCode(userId: string, phone: string, code: string, pepper: string): string {
    return createHmac('sha256', pepper).update(`${userId}:${phone}:${code}`, 'utf8').digest('hex');
  }

  private safeDigestEqual(storedHex: string, candidateHex: string): boolean {
    const stored = Buffer.from(storedHex, 'hex');
    const candidate = Buffer.from(candidateHex, 'hex');
    return stored.length === 32 && candidate.length === 32 && timingSafeEqual(stored, candidate);
  }
}
