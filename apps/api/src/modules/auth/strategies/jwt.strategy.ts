import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { User, UserStatus } from '../../users/entities/user.entity';
import { AuthenticatedPrincipal } from '../../../common/interfaces/authenticated-principal.interface';
import { normalizeCanonicalUuid } from '../../../common/utils/uuid.util';

export interface JwtPayload {
  sub: string;
  email: string | null;
  roles: string[];
  /** Distinguishes bearer access JWTs from refresh JWTs. */
  tokenType?: 'access' | 'refresh';
  /** Signed browser persistence preference carried only by refresh JWTs. */
  rememberMe?: boolean;
  /** Server-side token generation used for immediate revocation. */
  sessionVersion?: number;
  /** Unique token id so each rotation produces a distinct JWT. */
  jti?: string;
  iat?: number;
  exp?: number;
}

/**
 * JwtStrategy — validates JWT access tokens and populates request.user.
 *
 * Sprint 48 adds two server-side security gates:
 *   1. refresh JWTs cannot be presented as bearer access tokens;
 *   2. the token's sessionVersion must match identity.users.session_version.
 *
 * Logout, password reset, and refresh rotation advance session_version, so
 * stale access tokens are rejected immediately rather than remaining valid
 * until their normal expiry.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret'),
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedPrincipal> {
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('Invalid token: missing subject');
    }

    const subject = normalizeCanonicalUuid(payload.sub);
    if (!subject) {
      throw new UnauthorizedException('Invalid token: invalid subject');
    }

    // Token purpose is explicit and fail-closed. Newly issued iRexPro JWTs
    // always carry a tokenType claim, so absence is not treated as a legacy
    // access-token fallback.
    if (payload.tokenType !== 'access') {
      throw new UnauthorizedException('Invalid access token');
    }

    const user = await this.userRepo.findOne({
      where: { id: subject },
      select: ['id', 'email', 'phone', 'status', 'sessionVersion'],
    });

    if (
      !user ||
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.PERMANENTLY_LOCKED ||
      user.status === UserStatus.CLOSED
    ) {
      throw new UnauthorizedException('User account is not active');
    }

    const tokenVersion = Number.isInteger(payload.sessionVersion) ? payload.sessionVersion! : 0;
    const userVersion = Number.isInteger(user.sessionVersion) ? user.sessionVersion : 0;
    if (tokenVersion !== userVersion) {
      throw new UnauthorizedException('Session has been revoked');
    }

    return {
      userId: user.id,
      email: user.email,
      phone: user.phone,
      roles: payload.roles ?? [],
      status: user.status,
    };
  }
}
