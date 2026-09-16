import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { StartSessionDto } from './dto/start-session.dto';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { AllowedTradingMode } from '../risk/entities/risk-profile.entity';

/**
 * TradingController regression tests — Hotfix amendment.
 *
 * Proves every endpoint passes only a UUID string to TradingService — never
 * the complete AuthenticatedPrincipal object or the full User entity.
 */
describe('TradingController (Hotfix — UUID identity regression)', () => {
  let controller: TradingController;
  let tradingService: Record<string, jest.Mock>;

  const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const SESSION_ID = 'd4e5f6a7-b8c9-0123-def0-456789012345';

  beforeEach(() => {
    tradingService = {
      startTradingSession: jest.fn().mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        executionMode: ExecutionMode.PAPER_ONLY,
        authorityGeneration: 1,
        status: 'ACTIVE',
      }),
      stopTradingSession: jest.fn().mockResolvedValue(undefined),
      changeExecutionMode: jest.fn().mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        executionMode: ExecutionMode.SEMI_AUTO,
        authorityGeneration: 2,
        status: 'ACTIVE',
      }),
      getActiveSession: jest.fn().mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
      }),
      getSessionById: jest.fn().mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
      }),
    };

    controller = new TradingController(tradingService as unknown as TradingService);
  });

  describe('passes only UUID string to TradingService', () => {
    it('startSession passes userId as UUID string', async () => {
      const dto: StartSessionDto = { executionMode: ExecutionMode.PAPER_ONLY };
      await controller.startSession(USER_ID, dto);
      expect(tradingService.startTradingSession).toHaveBeenCalledWith(
        USER_ID,
        undefined,
        ExecutionMode.PAPER_ONLY,
      );
      expect(typeof tradingService.startTradingSession.mock.calls[0][0]).toBe('string');
    });

    it('startSession resolves the legacy requestedMode alias to the same ExecutionMode value', async () => {
      const dto: StartSessionDto = { requestedMode: AllowedTradingMode.PAPER_ONLY };
      await controller.startSession(USER_ID, dto);
      expect(tradingService.startTradingSession).toHaveBeenCalledWith(
        USER_ID,
        undefined,
        ExecutionMode.PAPER_ONLY,
      );
    });

    it('changeExecutionMode passes userId + sessionId as UUID strings', async () => {
      await controller.changeExecutionMode(USER_ID, SESSION_ID, {
        executionMode: ExecutionMode.SEMI_AUTO,
      });
      expect(tradingService.changeExecutionMode).toHaveBeenCalledWith(
        USER_ID,
        SESSION_ID,
        ExecutionMode.SEMI_AUTO,
      );
      expect(typeof tradingService.changeExecutionMode.mock.calls[0][0]).toBe('string');
    });

    it('stopSession passes userId as UUID string', async () => {
      await controller.stopSession(USER_ID, SESSION_ID);
      expect(tradingService.stopTradingSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
      expect(typeof tradingService.stopTradingSession.mock.calls[0][0]).toBe('string');
    });

    it('getActive passes userId as UUID string', async () => {
      await controller.getActive(USER_ID);
      expect(tradingService.getActiveSession).toHaveBeenCalledWith(USER_ID);
      expect(typeof tradingService.getActiveSession.mock.calls[0][0]).toBe('string');
    });

    it('getById passes userId as UUID string', async () => {
      await controller.getById(USER_ID, SESSION_ID);
      expect(tradingService.getSessionById).toHaveBeenCalledWith(USER_ID, SESSION_ID);
      expect(typeof tradingService.getSessionById.mock.calls[0][0]).toBe('string');
    });
  });

  describe('never receives the complete AuthenticatedPrincipal', () => {
    const principalObject = {
      userId: USER_ID,
      email: 'user@example.com',
      phone: '+233243618186',
      roles: ['USER'],
      status: 'ACTIVE',
    };

    it('startSession does not pass the principal object', async () => {
      const dto: StartSessionDto = {};
      await controller.startSession(principalObject.userId, dto);
      const arg = tradingService.startTradingSession.mock.calls[0][0];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
      expect(typeof arg).toBe('string');
    });

    it('stopSession does not pass the principal object', async () => {
      await controller.stopSession(principalObject.userId, SESSION_ID);
      const arg = tradingService.stopTradingSession.mock.calls[0][0];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
    });
  });

  describe('session detail access remains ownership-protected', () => {
    it('getById passes the correct userId (service enforces ownership)', async () => {
      await controller.getById(USER_ID, SESSION_ID);
      expect(tradingService.getSessionById).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    });

    it('stopSession passes the correct userId (service enforces ownership)', async () => {
      await controller.stopSession(USER_ID, SESSION_ID);
      expect(tradingService.stopTradingSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    });
  });
});
