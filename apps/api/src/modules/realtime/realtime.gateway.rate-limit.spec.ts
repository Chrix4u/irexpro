import { RealtimeGateway } from './realtime.gateway';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { WsMessageRateGuard } from './guards/ws-message-rate.guard';

describe('RealtimeGateway — guarded message ordering', () => {
  const guardedHandlers = [
    'handleAuthenticate',
    'handleJoinSession',
    'handleLeaveSession',
  ] as const;

  it.each(guardedHandlers)('runs the message-rate guard before WsJwtGuard on %s', (handlerName) => {
    const handler = RealtimeGateway.prototype[handlerName];
    const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined;

    expect(guards).toEqual([WsMessageRateGuard, WsJwtGuard]);
  });
});
