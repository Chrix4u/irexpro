import { Logger, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { TradingSession } from '../execution/entities/trading-session.entity';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { RealtimeService } from './realtime.service';

/**
 * RealtimeGateway — WebSocket gateway for real-time events.
 *
 * Namespace: /realtime
 *
 * Rooms:
 *   user:{userId}               — joined after authenticated message handling
 *   trading-session:{sessionId} — joined only after persisted ownership check
 *   admin:global                — admin-only room (future)
 *
 * Authentication:
 *   All connections must provide a valid JWT in:
 *     socket.handshake.auth.token  OR  Authorization: Bearer <token>
 *   Invalid, expired, revoked, or unauthenticated connections are rejected
 *   immediately in handleConnection(). Guarded messages revalidate the same
 *   server-side session state so revocation after connection still fails closed.
 *
 * Security rules:
 *   - Users can only join their own rooms. Trading-session ownership is read
 *     from persisted state; client-supplied ownership claims are never trusted.
 *   - No broker secrets, tokens, or stack traces are ever emitted
 *   - Payloads are type-checked via RealtimeService methods
 *   - Browser-origin policy is owned centrally by RealtimeIoAdapter at bootstrap
 *
 * See: docs/architecture/06-realtime-event-layer.md
 */
@WebSocketGateway({
  namespace: '/realtime',
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly realtimeService: RealtimeService,
    private readonly wsJwtGuard: WsJwtGuard,
    @InjectRepository(TradingSession)
    private readonly tradingSessionRepo: Repository<TradingSession>,
  ) {}

  afterInit(server: Server): void {
    this.realtimeService.setServer(server);
    this.logger.log('RealtimeGateway initialised — namespace: /realtime');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      await this.wsJwtGuard.authenticateClient(client);
      this.logger.log(`Socket authenticated: ${client.id}`);
    } catch {
      this.logger.warn(`Rejecting unauthorized socket: ${client.id}`);
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const userId = client.data?.userId ?? 'unknown';
    this.logger.log(`Socket disconnected: ${client.id} userId=${userId}`);
  }

  /**
   * After JWT validation, join the user's personal room.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('authenticate')
  handleAuthenticate(
    @ConnectedSocket() client: Socket,
    @MessageBody() _data: unknown,
  ): { status: string; userId: string } {
    const userId = client.data.userId as string;
    const roomName = `user:${userId}`;

    client.join(roomName);
    this.logger.log(`Socket ${client.id} joined room: ${roomName}`);

    return { status: 'authenticated', userId };
  }

  /**
   * Join a trading-session room only after verifying ownership against the
   * authoritative persisted session row. The message carries only sessionId;
   * any extra client fields are ignored and cannot influence authorization.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('join-session')
  async handleJoinSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId: string },
  ): Promise<{ status: string }> {
    const userId = client.data.userId as string;

    if (!data?.sessionId) {
      throw new WsException('sessionId is required');
    }

    let session: Pick<TradingSession, 'id' | 'userId'> | null;
    try {
      session = await this.tradingSessionRepo.findOne({
        where: { id: data.sessionId },
        select: ['id', 'userId'],
      });
    } catch (error) {
      this.logger.error(
        `Realtime session ownership lookup failed for socket ${client.id}: ${(error as Error).message}`,
      );
      throw new WsException('Forbidden: cannot join trading session');
    }

    if (!session || session.userId !== userId) {
      this.logger.warn(`Socket ${client.id} denied trading-session room membership`);
      throw new WsException('Forbidden: cannot join trading session');
    }

    const roomName = `trading-session:${data.sessionId}`;
    await client.join(roomName);
    this.logger.log(`Socket ${client.id} (user=${userId}) joined authorized session room`);

    return { status: 'joined' };
  }

  /**
   * Leave a trading session room.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('leave-session')
  handleLeaveSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId: string },
  ): { status: string } {
    if (!data?.sessionId) {
      throw new WsException('sessionId is required');
    }
    const roomName = `trading-session:${data.sessionId}`;
    client.leave(roomName);
    this.logger.log(`Socket ${client.id} left room: ${roomName}`);
    return { status: 'left' };
  }
}
