import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthUserDto } from './dto/auth-user.dto';
import { normalizePhone, isEmail } from './utils/phone.util';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { Role, RoleName } from '../users/entities/role.entity';
import { AuditService } from '../audit/audit.service';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { normalizeCanonicalUuid } from '../../common/utils/uuid.util';
import { JwtPayload } from './strategies/jwt.strategy';
import { MfaService } from './mfa.service';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface BrowserRefreshTokens extends AuthTokens {
  rememberMe: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private static readonly LOGIN_FAILURE_LIMIT = 10;
  private static readonly LOGIN_LOCKOUT_MINUTES = 15;

  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(UserProfile)
    private profileRepo: Repository<UserProfile>,
    @InjectRepository(UserRole)
    private userRoleRepo: Repository<UserRole>,
    @InjectRepository(Role)
    private roleRepo: Repository<Role>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private auditService: AuditService,
    private dataSource: DataSource,
    // Optional keeps legacy focused unit-test constructors stable. Production
    // AuthModule always supplies MfaService; MFA-enabled accounts fail closed if
    // a test/minimal module omits it.
    @Optional() private mfaService?: MfaService,
  ) {}

  async register(dto: RegisterDto, ipAddress?: string): Promise<AuthTokens> {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('At least one of email or phone is required');
    }

    const normalizedPhone = dto.phone
      ? normalizePhone(dto.phone, this.callingCodeForCountry(dto.countryCode))
      : null;

    if (dto.email) {
      const existingByEmail = await this.userRepo.findOne({
        where: { email: dto.email.toLowerCase() },
      });
      if (existingByEmail) {
        throw new ConflictException('An account with this email already exists');
      }
    }

    if (normalizedPhone) {
      const existingByPhone = await this.userRepo.findOne({ where: { phone: normalizedPhone } });
      if (existingByPhone) {
        throw new ConflictException('An account with this phone number already exists');
      }
    }

    const passwordHash = await argon2.hash(dto.password, {
      memoryCost: this.configService.get('auth.argon2MemoryCost', 65536),
      timeCost: this.configService.get('auth.argon2TimeCost', 3),
      parallelism: this.configService.get('auth.argon2Parallelism', 1),
    });

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const user = queryRunner.manager.create(User, {
        email: dto.email ? dto.email.toLowerCase() : null,
        phone: normalizedPhone,
        passwordHash,
        countryCode: dto.countryCode ?? null,
        status: UserStatus.ACTIVE,
        sessionVersion: 1,
      });
      await queryRunner.manager.save(user);

      const profile = queryRunner.manager.create(UserProfile, {
        userId: user.id,
        firstName: dto.firstName ?? null,
        lastName: dto.lastName ?? null,
      });
      await queryRunner.manager.save(profile);

      const userRole = await this.roleRepo.findOne({ where: { name: RoleName.USER } });
      if (userRole) {
        const ur = queryRunner.manager.create(UserRole, {
          userId: user.id,
          roleId: userRole.id,
        });
        await queryRunner.manager.save(ur);
      }

      await queryRunner.commitTransaction();

      await this.auditService.log({
        actorUserId: user.id,
        action: AuditAction.USER_REGISTERED,
        resourceType: 'User',
        resourceId: user.id,
        ipAddress,
        metadata: { email: user.email, countryCode: user.countryCode },
      });

      const tokens = this.generateTokens(user, [RoleName.USER], dto.rememberMe === true);
      this.logger.log('New user registered');
      return tokens;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async login(dto: LoginDto, ipAddress?: string): Promise<AuthTokens> {
    const identifier = dto.identifier.trim();
    const emailLogin = isEmail(identifier);
    const phoneLookup = emailLogin ? null : normalizePhone(identifier);

    const user = await this.userRepo.findOne({
      where: emailLogin ? { email: identifier.toLowerCase() } : { phone: phoneLookup ?? '' },
      relations: ['userRoles', 'userRoles.role'],
    });

    if (!user) {
      await this.auditService.log({
        action: AuditAction.USER_LOGIN_FAILED,
        ipAddress,
        metadata: {
          reason: 'user_not_found',
          result: 'failed',
          identifierType: emailLogin ? 'email' : 'phone',
        },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.PERMANENTLY_LOCKED ||
      user.status === UserStatus.CLOSED
    ) {
      await this.auditService.log({
        actorUserId: user.id,
        action: AuditAction.USER_LOGIN_FAILED,
        ipAddress,
        metadata: { reason: 'account_status', result: 'blocked', status: user.status },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const now = Date.now();
    const lockedUntil = user.loginLockedUntil ? new Date(user.loginLockedUntil).getTime() : 0;

    if (lockedUntil > now) {
      await this.auditService.log({
        actorUserId: user.id,
        action: AuditAction.USER_LOGIN_FAILED,
        ipAddress,
        metadata: { reason: 'temporary_lockout', result: 'blocked' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    // Expired temporary locks self-clear before password verification. This
    // gives the account a clean consecutive-failure window after the cooldown.
    if (lockedUntil > 0 && lockedUntil <= now) {
      await this.userRepo.update(user.id, {
        failedLoginAttempts: 0,
        loginLockedUntil: null,
      });
      user.failedLoginAttempts = 0;
      user.loginLockedUntil = null;
    }

    const isValid = await argon2.verify(user.passwordHash, dto.password);
    if (!isValid) {
      await this.recordLoginFailure(user.id);
      await this.auditService.log({
        actorUserId: user.id,
        action: AuditAction.USER_LOGIN_FAILED,
        ipAddress,
        metadata: {
          reason: 'invalid_password',
          result: 'failed',
          lockoutThreshold: AuthService.LOGIN_FAILURE_LIMIT,
        },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    // MFA is evaluated only after the primary password succeeds, so the public
    // response never reveals whether an account has MFA configured. Bad TOTP
    // challenges do not increment the password-failure counter; the controller's
    // tight per-IP login throttle bounds online TOTP guessing separately.
    if (
      user.mfaEnabled &&
      (!this.mfaService || !this.mfaService.verifyLoginChallenge(user, dto.mfaCode))
    ) {
      await this.auditService.log({
        actorUserId: user.id,
        action: AuditAction.USER_LOGIN_FAILED,
        ipAddress,
        metadata: { reason: 'invalid_mfa', result: 'failed' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.userRepo.update(user.id, {
      lastLoginAt: new Date(),
      failedLoginAttempts: 0,
      loginLockedUntil: null,
    });

    const roles = user.userRoles?.map((ur) => ur.role.name) ?? [RoleName.USER];

    await this.auditService.log({
      actorUserId: user.id,
      action: AuditAction.USER_LOGIN_SUCCESS,
      ipAddress,
      metadata: { result: 'success', mfaVerified: user.mfaEnabled },
    });

    return this.generateTokens(user, roles, dto.rememberMe === true);
  }

  /**
   * Atomically increment failed-login state in PostgreSQL. The threshold and
   * interval are compile-time integers, not request data, so this SQL fragment
   * cannot be influenced by a caller. Concurrent bad-password requests cannot
   * lose increments or bypass the threshold.
   */
  private async recordLoginFailure(userId: string): Promise<void> {
    await this.userRepo.update(userId, {
      failedLoginAttempts: () => '"failed_login_attempts" + 1',
      loginLockedUntil: () =>
        `CASE WHEN "failed_login_attempts" + 1 >= ${AuthService.LOGIN_FAILURE_LIMIT} ` +
        `THEN CURRENT_TIMESTAMP + INTERVAL '${AuthService.LOGIN_LOCKOUT_MINUTES} minutes' ` +
        'ELSE NULL END',
    });
  }

  /** Native/body-token refresh contract: return only the two JWTs. */
  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const { accessToken, refreshToken: rotatedRefreshToken } =
      await this.rotateRefreshToken(refreshToken);
    return { accessToken, refreshToken: rotatedRefreshToken };
  }

  /** Browser-cookie refresh contract: include only signed cookie-persistence metadata. */
  async refreshBrowserTokens(refreshToken: string): Promise<BrowserRefreshTokens> {
    return this.rotateRefreshToken(refreshToken);
  }

  private async rotateRefreshToken(refreshToken: string): Promise<BrowserRefreshTokens> {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const subject = normalizeCanonicalUuid(payload.sub);
    if (!subject) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (payload.tokenType !== 'refresh') {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.userRepo.findOne({
      where: { id: subject },
      relations: ['userRoles', 'userRoles.role'],
    });

    if (
      !user ||
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.PERMANENTLY_LOCKED ||
      user.status === UserStatus.CLOSED
    ) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const tokenVersion = this.payloadSessionVersion(payload);
    const currentVersion = this.userSessionVersion(user);
    if (tokenVersion !== currentVersion) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const nextVersion = currentVersion + 1;
    const rotation = await this.userRepo.update(
      { id: user.id, sessionVersion: currentVersion },
      { sessionVersion: nextVersion },
    );

    if (rotation?.affected !== undefined && rotation.affected !== 1) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    user.sessionVersion = nextVersion;
    const roles = user.userRoles?.map((ur) => ur.role.name) ?? [RoleName.USER];
    // Only a literal signed boolean true preserves persistence. Missing/invalid
    // claims from already-issued tokens downgrade conservatively to session-only.
    const rememberMe = payload.rememberMe === true;

    await this.auditService.log({
      actorUserId: user.id,
      action: AuditAction.USER_TOKEN_REFRESHED,
      resourceType: 'User',
      resourceId: user.id,
      metadata: {
        result: 'success',
        previousSessionVersion: currentVersion,
        sessionVersion: nextVersion,
      },
    });

    const tokens = this.generateTokens(user, roles, rememberMe);
    return { ...tokens, rememberMe };
  }

  async logout(userId: string, ipAddress?: string): Promise<void> {
    const result = await this.userRepo.update(userId, {
      sessionVersion: () => '"session_version" + 1',
    });

    if (result?.affected !== undefined && result.affected !== 1) {
      throw new UnauthorizedException('User session is no longer valid');
    }

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.USER_LOGOUT,
      resourceType: 'User',
      resourceId: userId,
      ipAddress,
      metadata: { result: 'success', scope: 'all_sessions' },
    });
  }

  /**
   * Sprint 55 — POST /auth/change-password.
   *
   * Mirrors reset-password's transactional semantics exactly:
   *   - re-authenticate with the CURRENT password first (same boundary as
   *     MFA setup/disable re-auth); wrong value → 401 and nothing changes;
   *   - store the new argon2 hash, retire any pending (not yet enabled) MFA
   *     enrollment — scoped to mfaEnabled=false so active MFA secrets are
   *     preserved — and revoke EVERY session by bumping session_version, all
   *     in ONE transaction (no partial state on failure);
   *   - the session_version bump is a compare-and-set on the version observed
   *     when the user row was loaded; a lost race fails closed and the whole
   *     transaction rolls back;
   *   - audit metadata records sessionsRevoked only — NEVER password content.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ipAddress?: string,
  ): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User session is no longer valid');
    }

    const currentPasswordValid = await argon2.verify(user.passwordHash, currentPassword);
    if (!currentPasswordValid) {
      await this.auditService.log({
        actorUserId: user.id,
        action: AuditAction.USER_PASSWORD_CHANGE_FAILED,
        resourceType: 'User',
        resourceId: user.id,
        ipAddress,
        // Metadata records the failure reason ONLY; no password material of
        // any kind ever enters the audit trail.
        metadata: { result: 'failed', reason: 'invalid_current_password' },
      });
      throw new UnauthorizedException('Current password verification failed');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Keep the password update as a separate statement so tests can verify
      // that only the one-way hash is written (reset-password convention).
      const passwordHash = await this.hashPassword(newPassword);
      await queryRunner.manager.update(User, user.id, { passwordHash });

      // A pending MFA enrollment was authorized using the old password. Retire
      // only that pending state; the predicate deliberately preserves enabled
      // MFA and its TOTP secret (reset-password hardening).
      await queryRunner.manager.update(
        User,
        { id: user.id, mfaEnabled: false },
        { mfaSecret: null, mfaSetupExpiresAt: null },
      );

      // CAS revocation of every existing session: the update only lands when
      // the generation still equals the one observed at read time. A concurrent
      // rotation/logout/reset wins the race and this request fails closed.
      const currentVersion = this.userSessionVersion(user);
      const bump = await queryRunner.manager.update(
        User,
        { id: user.id, sessionVersion: currentVersion },
        { sessionVersion: currentVersion + 1 },
      );
      if (bump?.affected !== undefined && bump.affected !== 1) {
        throw new UnauthorizedException('Session state changed concurrently; please retry');
      }

      await queryRunner.commitTransaction();

      await this.auditService.log({
        actorUserId: user.id,
        action: AuditAction.USER_PASSWORD_CHANGED,
        resourceType: 'User',
        resourceId: user.id,
        ipAddress,
        // Deliberately nothing else — no password material of any kind.
        metadata: { sessionsRevoked: true },
      });
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Sprint 55 — POST /auth/sessions/revoke-others.
   *
   * Sign-out-everywhere-ELSE for the CALLER: the global session generation is
   * compare-and-set bumped v → v+1, which invalidates every OTHER session's
   * access + refresh tokens (JwtStrategy/JWT revalidation) and disconnects
   * their realtime sockets via the existing per-message checks — no guard or
   * strategy changes required. The caller is then immediately re-issued a
   * fresh token pair minted at v+1 so the current device stays signed in.
   *
   * The CAS uses the same single-statement conditional UPDATE (and the same
   * stale-generation failure mode) as refresh rotation: affected !== 1 → 401
   * and NO tokens are minted, NO audit success is recorded.
   *
   * Body transport (mobile, default) mints the new refresh token with
   * rememberMe=false. Cookie transport inherits the signed rememberMe
   * preference from the presented cookie refresh token when it verifiably
   * belongs to the same user (see browserRememberMePreference); anything
   * unverifiable downgrades conservatively to session-only.
   */
  async revokeOtherSessions(
    userId: string,
    options: { ipAddress?: string; inheritRememberMeFrom?: string } = {},
  ): Promise<BrowserRefreshTokens> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['userRoles', 'userRoles.role'],
    });

    if (
      !user ||
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.PERMANENTLY_LOCKED ||
      user.status === UserStatus.CLOSED
    ) {
      throw new UnauthorizedException('User session is no longer valid');
    }

    const currentVersion = this.userSessionVersion(user);
    const nextVersion = currentVersion + 1;
    const bump = await this.userRepo.update(
      { id: user.id, sessionVersion: currentVersion },
      { sessionVersion: nextVersion },
    );

    if (bump?.affected !== undefined && bump.affected !== 1) {
      // Stale-generation race, same failure mode as refresh rotation.
      throw new UnauthorizedException('Session state changed concurrently; please retry');
    }

    user.sessionVersion = nextVersion;

    await this.auditService.log({
      actorUserId: user.id,
      action: AuditAction.USER_SESSIONS_REVOKED_OTHERS,
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: options.ipAddress,
      metadata: { sessionsRevoked: 'all_other' },
      severity: AuditSeverity.INFO,
    });

    const roles = user.userRoles?.map((ur) => ur.role.name) ?? [RoleName.USER];
    const rememberMe = this.browserRememberMePreference(options.inheritRememberMeFrom, user.id);
    const tokens = this.generateTokens(user, roles, rememberMe);
    return { ...tokens, rememberMe };
  }

  /**
   * Cookie-transport persistence preference. Only a literal signed
   * rememberMe=true carried by a refresh-type token for the SAME user is
   * honored; a missing, unverifiable, cross-user, or non-refresh token
   * downgrades conservatively to session-only (mirrors the literal-true
   * preservation rule in rotateRefreshToken).
   */
  private browserRememberMePreference(
    presentedRefreshToken: string | undefined,
    userId: string,
  ): boolean {
    if (!presentedRefreshToken) return false;
    try {
      const payload = this.jwtService.verify<JwtPayload>(presentedRefreshToken);
      if (payload.sub !== userId || payload.tokenType !== 'refresh') return false;
      return payload.rememberMe === true;
    } catch {
      return false;
    }
  }

  private generateTokens(user: User, roles: string[], rememberMe = false): AuthTokens {
    const basePayload = {
      sub: user.id,
      email: user.email,
      roles,
      sessionVersion: this.userSessionVersion(user),
    };

    const accessToken = this.jwtService.sign(
      {
        ...basePayload,
        tokenType: 'access' as const,
        jti: randomUUID(),
      },
      {
        expiresIn: this.configService.get<string>('jwt.accessExpiry', '15m'),
      },
    );

    const refreshToken = this.jwtService.sign(
      {
        ...basePayload,
        tokenType: 'refresh' as const,
        rememberMe,
        jti: randomUUID(),
      },
      {
        expiresIn: this.configService.get<string>('jwt.refreshExpiry', '7d'),
      },
    );

    return { accessToken, refreshToken };
  }

  private userSessionVersion(user: Pick<User, 'sessionVersion'>): number {
    return Number.isInteger(user.sessionVersion) ? user.sessionVersion : 0;
  }

  private payloadSessionVersion(payload: JwtPayload): number {
    return Number.isInteger(payload.sessionVersion) ? payload.sessionVersion! : 0;
  }

  async validateUser(id: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  async getAuthUserDto(userId: string, roles: RoleName[]): Promise<AuthUserDto> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['profile'],
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return AuthUserDto.fromUser(user, roles, user.profile);
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, {
      memoryCost: this.configService.get<number>('auth.argon2MemoryCost', 65536),
      timeCost: this.configService.get<number>('auth.argon2TimeCost', 3),
      parallelism: this.configService.get<number>('auth.argon2Parallelism', 1),
    });
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }

  private callingCodeForCountry(countryCode?: string): string | undefined {
    if (!countryCode) return undefined;
    const map: Record<string, string> = {
      GH: '+233',
      NG: '+234',
      GB: '+44',
      US: '+1',
      CA: '+1',
      ZA: '+27',
      KE: '+254',
      CI: '+225',
      TG: '+228',
      BJ: '+229',
      BF: '+226',
      SL: '+232',
      LR: '+231',
      AE: '+971',
      IN: '+91',
      CN: '+86',
    };
    return map[countryCode.toUpperCase()];
  }
}
