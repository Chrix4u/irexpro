import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

interface RealtimeMessageRatePolicy {
  limit: number;
  windowMs: number;
}

/**
 * Guard policies are keyed by gateway handler name so each message class has
 * an independent sliding window. Limits are intentionally conservative for
 * actions that should normally happen only during connection/setup flows.
 */
export const REALTIME_MESSAGE_RATE_POLICIES = {
  handleAuthenticate: { limit: 5, windowMs: 10_000 },
  handleJoinSession: { limit: 10, windowMs: 10_000 },
  handleLeaveSession: { limit: 20, windowMs: 10_000 },
} as const satisfies Record<string, RealtimeMessageRatePolicy>;

type RealtimeRateLimitedHandler = keyof typeof REALTIME_MESSAGE_RATE_POLICIES;

/**
 * Per-socket, per-handler abuse guard for authenticated realtime messages.
 *
 * This guard MUST execute before WsJwtGuard. Rejected messages therefore do
 * not trigger repeated JWT/session-version validation or downstream database
 * ownership reads. WeakMap ownership prevents disconnected sockets from being
 * retained solely by the limiter.
 */
@Injectable()
export class WsMessageRateGuard implements CanActivate {
  private readonly buckets = new WeakMap<Socket, Map<RealtimeRateLimitedHandler, number[]>>();

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const handlerName = context.getHandler().name as RealtimeRateLimitedHandler;
    const policy = REALTIME_MESSAGE_RATE_POLICIES[handlerName];

    // A handler protected by this guard must have an explicit policy. Fail
    // closed if a future handler is wired without adding one.
    if (!client || !policy) {
      throw new WsException('Too many requests');
    }

    const now = Date.now();
    const cutoff = now - policy.windowMs;
    const socketBuckets =
      this.buckets.get(client) ?? new Map<RealtimeRateLimitedHandler, number[]>();
    const retained = (socketBuckets.get(handlerName) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );

    if (retained.length >= policy.limit) {
      socketBuckets.set(handlerName, retained);
      this.buckets.set(client, socketBuckets);
      throw new WsException('Too many requests');
    }

    retained.push(now);
    socketBuckets.set(handlerName, retained);
    this.buckets.set(client, socketBuckets);
    return true;
  }
}
