import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RealtimeService } from './realtime.service';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import { RealtimeEvent } from './events/realtime-event.enum';
import { User, UserStatus } from '../users/entities/user.entity';

describe('RealtimeService', () => {
  let module: TestingModule;
  let service: RealtimeService;
  let eventBus: DomainEventBus;
  let userRepo: { findOne: jest.Mock };
  let fetchSockets: jest.Mock;
  let adminRoom: { emit: jest.Mock };
  let mockServer: { in: jest.Mock; to: jest.Mock };

  const makeSocket = (
    overrides: Partial<{
      userId: string;
      authenticatedSessionVersion: number;
    }> = {},
  ) => ({
    data: {
      userId: 'user-1',
      authenticatedSessionVersion: 3,
      ...overrides,
    },
    emit: jest.fn(),
    disconnect: jest.fn(),
  });

  const activeUser = (overrides: Partial<User> = {}) =>
    ({
      id: 'user-1',
      status: UserStatus.ACTIVE,
      sessionVersion: 3,
      ...overrides,
    }) as User;

  const flushAsyncDelivery = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    userRepo = { findOne: jest.fn().mockResolvedValue(activeUser()) };

    module = await Test.createTestingModule({
      providers: [
        RealtimeService,
        DomainEventBus,
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    service = module.get<RealtimeService>(RealtimeService);
    eventBus = module.get<DomainEventBus>(DomainEventBus);

    fetchSockets = jest.fn().mockResolvedValue([]);
    adminRoom = { emit: jest.fn() };
    mockServer = {
      in: jest.fn().mockReturnValue({ fetchSockets }),
      to: jest.fn().mockReturnValue(adminRoom),
    };

    service.setServer(mockServer as never);
    service.onModuleInit();
  });

  afterEach(async () => {
    await module.close();
  });

  describe('validated outbound delivery', () => {
    it('delivers to a current socket whose authenticated generation still matches', async () => {
      const socket = makeSocket();
      fetchSockets.mockResolvedValue([socket]);

      await service.emitToUser('user-1', RealtimeEvent.TRADE_OPENED, { tradeId: 't1' });

      expect(mockServer.in).toHaveBeenCalledWith('user:user-1');
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: ['id', 'status', 'sessionVersion'],
      });
      expect(socket.emit).toHaveBeenCalledWith(RealtimeEvent.TRADE_OPENED, { tradeId: 't1' });
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects and suppresses delivery after the server session generation advances', async () => {
      const socket = makeSocket({ authenticatedSessionVersion: 3 });
      fetchSockets.mockResolvedValue([socket]);
      userRepo.findOne.mockResolvedValue(activeUser({ sessionVersion: 4 }));

      await service.emitToUser('user-1', RealtimeEvent.SYSTEM_NOTIFICATION, { title: 'private' });

      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it.each([UserStatus.SUSPENDED, UserStatus.PERMANENTLY_LOCKED, UserStatus.CLOSED])(
      'disconnects and suppresses delivery for restricted status %s',
      async (status) => {
        const socket = makeSocket();
        fetchSockets.mockResolvedValue([socket]);
        userRepo.findOne.mockResolvedValue(activeUser({ status }));

        await service.emitToUser('user-1', RealtimeEvent.SYSTEM_NOTIFICATION, {
          title: 'private',
        });

        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.disconnect).toHaveBeenCalledWith(true);
      },
    );

    it('fails closed when current session state cannot be read', async () => {
      const socket = makeSocket();
      fetchSockets.mockResolvedValue([socket]);
      userRepo.findOne.mockRejectedValue(new Error('database unavailable'));

      await expect(
        service.emitToUser('user-1', RealtimeEvent.SYSTEM_NOTIFICATION, { title: 'private' }),
      ).resolves.toBeUndefined();

      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects malformed or wrong-user sockets before user-room delivery', async () => {
      const missingGeneration = makeSocket();
      delete (missingGeneration.data as { authenticatedSessionVersion?: number })
        .authenticatedSessionVersion;
      const wrongUser = makeSocket({ userId: 'user-2' });
      fetchSockets.mockResolvedValue([missingGeneration, wrongUser]);

      await service.emitToUser('user-1', RealtimeEvent.SYSTEM_NOTIFICATION, { title: 'private' });

      expect(userRepo.findOne).not.toHaveBeenCalled();
      expect(missingGeneration.emit).not.toHaveBeenCalled();
      expect(wrongUser.emit).not.toHaveBeenCalled();
      expect(missingGeneration.disconnect).toHaveBeenCalledWith(true);
      expect(wrongUser.disconnect).toHaveBeenCalledWith(true);
    });

    it('validates each identity in a trading-session room and emits only to current sockets', async () => {
      const currentSocket = makeSocket({ userId: 'user-1', authenticatedSessionVersion: 3 });
      const staleSocket = makeSocket({ userId: 'user-2', authenticatedSessionVersion: 6 });
      fetchSockets.mockResolvedValue([currentSocket, staleSocket]);
      userRepo.findOne.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'user-1'
          ? activeUser({ id: 'user-1', sessionVersion: 3 })
          : activeUser({ id: 'user-2', sessionVersion: 7 }),
      );

      await service.emitToTradingSession('session-1', RealtimeEvent.TRADE_OPENED, {
        tradeId: 't1',
      });

      expect(currentSocket.emit).toHaveBeenCalledWith(RealtimeEvent.TRADE_OPENED, {
        tradeId: 't1',
      });
      expect(currentSocket.disconnect).not.toHaveBeenCalled();
      expect(staleSocket.emit).not.toHaveBeenCalled();
      expect(staleSocket.disconnect).toHaveBeenCalledWith(true);
    });

    it('does not throw when the server is not set', async () => {
      service.setServer(null as never);
      await expect(
        service.emitToUser('user-1', RealtimeEvent.TRADE_OPENED, {}),
      ).resolves.toBeUndefined();
    });
  });

  describe('emitToAdmins()', () => {
    it('preserves the existing admin-room emission path', () => {
      service.emitToAdmins(RealtimeEvent.SYSTEM_NOTIFICATION, { title: 'Test' });
      expect(mockServer.to).toHaveBeenCalledWith('admin:global');
      expect(adminRoom.emit).toHaveBeenCalledWith(RealtimeEvent.SYSTEM_NOTIFICATION, {
        title: 'Test',
      });
    });
  });

  describe('DomainEventBus subscriptions', () => {
    it('forwards TRADING_SESSION_STARTED only after current-session validation', async () => {
      const socket = makeSocket();
      fetchSockets.mockResolvedValue([socket]);

      eventBus.publish(DomainEventType.TRADING_SESSION_STARTED, 'user-1', {
        sessionId: 'sess-1',
        brokerConnectionId: 'conn-1',
        status: 'ACTIVE',
        startedAt: new Date(),
      });
      await flushAsyncDelivery();

      expect(mockServer.in).toHaveBeenCalledWith('user:user-1');
      expect(socket.emit).toHaveBeenCalledWith(
        RealtimeEvent.TRADING_SESSION_STARTED,
        expect.objectContaining({ sessionId: 'sess-1', status: 'ACTIVE' }),
      );
    });

    it('keeps trade payloads free of credential and token material', async () => {
      const socket = makeSocket();
      fetchSockets.mockResolvedValue([socket]);

      eventBus.publish(DomainEventType.TRADE_OPENED, 'user-1', {
        tradeId: 't-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        volume: '0.05',
        entryPrice: '1.08500',
        status: 'OPEN',
      });
      await flushAsyncDelivery();

      const emittedPayload = socket.emit.mock.calls[0][1] as Record<string, unknown>;
      expect(emittedPayload).toHaveProperty('tradeId');
      expect(emittedPayload).toHaveProperty('instrument');
      expect(emittedPayload).not.toHaveProperty('encryptedCredentials');
      expect(emittedPayload).not.toHaveProperty('credentialIv');
      expect(emittedPayload).not.toHaveProperty('accessToken');
      expect(emittedPayload).not.toHaveProperty('refreshToken');
    });

    it('cleans up subscriptions on onModuleDestroy', async () => {
      const socket = makeSocket();
      fetchSockets.mockResolvedValue([socket]);
      service.onModuleDestroy();

      eventBus.publish(DomainEventType.TRADING_SESSION_STARTED, 'user-1', {});
      await flushAsyncDelivery();

      expect(socket.emit).not.toHaveBeenCalled();
    });
  });
});
