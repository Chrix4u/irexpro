import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { ExecutionMode } from '../execution/interfaces/execution-authority';

/**
 * Regression coverage for the browser-facing session contract.
 *
 * The TradingService owns the full persistence entity, but the controller must
 * never return internal identity, financial-session, or audit-snapshot fields
 * to frontend clients.
 *
 * Round 5 (#295/#298): executionMode + authorityGeneration ARE part of the
 * browser-facing contract (session authority) and must be present on every
 * session response — including the mode-change response.
 */
describe('TradingController frontend-safe session response', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const SESSION_ID = '22222222-2222-4222-8222-222222222222';
  const BROKER_CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
  const now = new Date('2026-08-28T18:00:00.000Z');

  const internalSession = {
    id: SESSION_ID,
    userId: USER_ID,
    brokerConnectionId: BROKER_CONNECTION_ID,
    executionMode: ExecutionMode.PAPER_ONLY,
    authorityGeneration: 1,
    status: TradingSessionStatus.ACTIVE,
    openingBalance: '10000.00',
    peakEquity: '10500.00',
    riskProfileSnapshot: {
      maxDailyLossPercent: '5',
      internalAuditMarker: 'must-not-leak',
    },
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  function buildController() {
    const tradingService = {
      startTradingSession: jest.fn().mockResolvedValue(internalSession),
      stopTradingSession: jest.fn().mockResolvedValue(undefined),
      changeExecutionMode: jest.fn().mockResolvedValue({
        ...internalSession,
        executionMode: ExecutionMode.SEMI_AUTO,
        authorityGeneration: 2,
      }),
      getActiveSession: jest.fn().mockResolvedValue(internalSession),
      getSessionById: jest.fn().mockResolvedValue(internalSession),
    };

    return {
      controller: new TradingController(tradingService as unknown as TradingService),
      tradingService,
    };
  }

  function expectSafeSession(response: object) {
    expect(response).toEqual({
      id: SESSION_ID,
      brokerConnectionId: BROKER_CONNECTION_ID,
      executionMode: ExecutionMode.PAPER_ONLY,
      authorityGeneration: 1,
      status: TradingSessionStatus.ACTIVE,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(response).not.toHaveProperty('userId');
    expect(response).not.toHaveProperty('openingBalance');
    expect(response).not.toHaveProperty('peakEquity');
    expect(response).not.toHaveProperty('riskProfileSnapshot');
  }

  it('sanitizes the session returned by start', async () => {
    const { controller } = buildController();
    const response = await controller.startSession(USER_ID, {});
    expectSafeSession(response);
  });

  it('sanitizes the current active session', async () => {
    const { controller } = buildController();
    const response = await controller.getActive(USER_ID);
    expect(response.session).not.toBeNull();
    expectSafeSession(response.session!);
  });

  it('returns null when there is no active session', async () => {
    const tradingService = {
      getActiveSession: jest.fn().mockResolvedValue(null),
    };
    const controller = new TradingController(tradingService as unknown as TradingService);

    await expect(controller.getActive(USER_ID)).resolves.toEqual({ session: null });
  });

  it('sanitizes a session returned by id', async () => {
    const { controller } = buildController();
    const response = await controller.getById(USER_ID, SESSION_ID);
    expectSafeSession(response);
  });

  it('sanitizes the session returned by the mode-change endpoint (authority fields present)', async () => {
    const { controller } = buildController();
    const response = await controller.changeExecutionMode(USER_ID, SESSION_ID, {
      executionMode: ExecutionMode.SEMI_AUTO,
    });
    expect(response).toEqual({
      id: SESSION_ID,
      brokerConnectionId: BROKER_CONNECTION_ID,
      executionMode: ExecutionMode.SEMI_AUTO,
      authorityGeneration: 2,
      status: TradingSessionStatus.ACTIVE,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(response).not.toHaveProperty('userId');
    expect(response).not.toHaveProperty('riskProfileSnapshot');
  });
});
