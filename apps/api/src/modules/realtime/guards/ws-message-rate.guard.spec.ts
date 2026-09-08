import { ExecutionContext } from '@nestjs/common';
import { Socket } from 'socket.io';
import { WsMessageRateGuard } from './ws-message-rate.guard';

const handlers = {
  handleAuthenticate() {},
  handleJoinSession() {},
  handleLeaveSession() {},
  unknownHandler() {},
};

type HandlerName = keyof typeof handlers;

function makeContext(client: Socket, handlerName: HandlerName): ExecutionContext {
  return {
    switchToWs: () => ({
      getClient: () => client,
    }),
    getHandler: () => handlers[handlerName],
  } as unknown as ExecutionContext;
}

describe('WsMessageRateGuard', () => {
  let guard: WsMessageRateGuard;
  let now: jest.SpyInstance<number, []>;

  beforeEach(() => {
    guard = new WsMessageRateGuard();
    now = jest.spyOn(Date, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    now.mockRestore();
  });

  it('allows the configured authenticate budget and rejects the next message', () => {
    const client = {} as Socket;
    const context = makeContext(client, 'handleAuthenticate');

    for (let index = 0; index < 5; index += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }

    expect(() => guard.canActivate(context)).toThrow('Too many requests');
  });

  it('recovers when the sliding window expires', () => {
    const client = {} as Socket;
    const context = makeContext(client, 'handleAuthenticate');

    for (let index = 0; index < 5; index += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }

    now.mockReturnValue(9_999);
    expect(() => guard.canActivate(context)).toThrow('Too many requests');

    now.mockReturnValue(10_000);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('isolates rate buckets between sockets', () => {
    const firstClient = {} as Socket;
    const secondClient = {} as Socket;
    const firstContext = makeContext(firstClient, 'handleAuthenticate');
    const secondContext = makeContext(secondClient, 'handleAuthenticate');

    for (let index = 0; index < 5; index += 1) {
      expect(guard.canActivate(firstContext)).toBe(true);
    }

    expect(() => guard.canActivate(firstContext)).toThrow('Too many requests');
    expect(guard.canActivate(secondContext)).toBe(true);
  });

  it('isolates rate buckets between guarded handlers on the same socket', () => {
    const client = {} as Socket;
    const authenticateContext = makeContext(client, 'handleAuthenticate');
    const joinContext = makeContext(client, 'handleJoinSession');

    for (let index = 0; index < 5; index += 1) {
      expect(guard.canActivate(authenticateContext)).toBe(true);
    }

    expect(() => guard.canActivate(authenticateContext)).toThrow('Too many requests');
    expect(guard.canActivate(joinContext)).toBe(true);
  });

  it('applies the larger join and leave budgets independently', () => {
    const client = {} as Socket;
    const joinContext = makeContext(client, 'handleJoinSession');
    const leaveContext = makeContext(client, 'handleLeaveSession');

    for (let index = 0; index < 10; index += 1) {
      expect(guard.canActivate(joinContext)).toBe(true);
    }
    expect(() => guard.canActivate(joinContext)).toThrow('Too many requests');

    for (let index = 0; index < 20; index += 1) {
      expect(guard.canActivate(leaveContext)).toBe(true);
    }
    expect(() => guard.canActivate(leaveContext)).toThrow('Too many requests');
  });

  it('fails closed when applied to a handler without an explicit policy', () => {
    const client = {} as Socket;
    const context = makeContext(client, 'unknownHandler');

    expect(() => guard.canActivate(context)).toThrow('Too many requests');
  });
});
