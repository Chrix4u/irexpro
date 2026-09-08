import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { normalizeCanonicalUuid } from '../../../common/utils/uuid.util';
import { User, UserStatus } from '../../users/entities/user.entity';

export interface WsAuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string | null;
  userRoles: string[];
  authenticatedSessionVersion: number;
}

interface WsJwtPayload {
  sub: string;
  email: string | null;
  roles: string[];
  tokenType?: 'access' | 'refresh';
  sessionVersion?: number;
}

/**
 * WsJwtGuard — JWT authentication guard for WebSocket connections.
 *
 * Sprint 48 applies the same server-side revocation semantics as the HTTP
 * JwtStrategy. A socket handshake must present an ACCESS token whose
 * sessionVersion still matches identity.users.session_version. Refresh tokens,
 * stale tokens, and tokens for inactive users are rejected before room join.
 * Realtime verification is explicitly pinned to HS256, matching the HTTP bearer
 * boundary and the repository's configured token issuer.
 *
 * Connection-time and per-message authentication intentionally share the same
 * authenticateClient() implementation. The validated session generation is
 * also persisted on socket.data so outbound room delivery can re-check the
 * current server-side generation before emitting to a previously joined socket.
 * Any failed revalidation clears those server-attached identity fields, and a
 * guarded message-time failure disconnects the stale socket immediately.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    try {
      await this.authenticateClient(client);
      return true;
    } catch (error) {
      client.disconnect(true);
      throw error;
    }
  }

  async authenticateClient(client: Socket): Promise<void> {
    const token = this.extractToken(client);

    if (!token) {
      this.clearAuthentication(client);
      this.logger.warn(`WsJwtGuard: no token provided, rejecting socket ${client.id}`);
      throw new WsException('Unauthorized: no token provided');
    }

    try {
      const secret = this.configService.get<string>('jwt.secret');
      const payload = this.jwtService.verify<WsJwtPayload>(token, {
        secret,
        algorithms: ['HS256'],
      });

      if (!payload.sub || typeof payload.sub !== 'string') {
        throw new Error('missing subject');
      }
      const subject = normalizeCanonicalUuid(payload.sub);
      if (!subject) {
        throw new Error('invalid subject');
      }
      // Token purpose is explicit and fail-closed, matching the HTTP bearer
      // boundary. Missing tokenType is not treated as a legacy access token.
      if (payload.tokenType !== 'access') {
        throw new Error('wrong token type');
      }

      const user = await this.userRepo.findOne({
        where: { id: subject },
        select: ['id', 'email', 'status', 'sessionVersion'],
      });

      if (
        !user ||
        user.status === UserStatus.SUSPENDED ||
        user.status === UserStatus.PERMANENTLY_LOCKED ||
        user.status === UserStatus.CLOSED
      ) {
        throw new Error('inactive user');
      }

      const tokenVersion = Number.isInteger(payload.sessionVersion) ? payload.sessionVersion! : 0;
      const userVersion = Number.isInteger(user.sessionVersion) ? user.sessionVersion : 0;
      if (tokenVersion !== userVersion) {
        throw new Error('revoked session');
      }

      (client as WsAuthenticatedSocket).userId = user.id;
      (client as WsAuthenticatedSocket).userEmail = user.email;
      (client as WsAuthenticatedSocket).userRoles = payload.roles ?? [];
      (client as WsAuthenticatedSocket).authenticatedSessionVersion = userVersion;

      client.data.userId = user.id;
      client.data.userEmail = user.email;
      client.data.userRoles = payload.roles ?? [];
      client.data.authenticatedSessionVersion = userVersion;
    } catch {
      this.clearAuthentication(client);
      this.logger.warn(`WsJwtGuard: invalid token on socket ${client.id}`);
      throw new WsException('Unauthorized: invalid, expired, or revoked token');
    }
  }

  private clearAuthentication(client: Socket): void {
    const authenticatedClient = client as Socket & Partial<WsAuthenticatedSocket>;
    delete authenticatedClient.userId;
    delete authenticatedClient.userEmail;
    delete authenticatedClient.userRoles;
    delete authenticatedClient.authenticatedSessionVersion;

    delete client.data.userId;
    delete client.data.userEmail;
    delete client.data.userRoles;
    delete client.data.authenticatedSessionVersion;
  }

  private extractToken(client: Socket): string | null {
    const authToken = client.handshake?.auth?.token as string | undefined;
    if (authToken) return authToken;

    const authHeader = client.handshake?.headers?.authorization as string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return null;
  }
}
