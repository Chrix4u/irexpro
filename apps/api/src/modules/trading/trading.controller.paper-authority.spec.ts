import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { StartSessionDto } from './dto/start-session.dto';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { TradingSessionStatus } from '../execution/entities/trading-session.entity';

const PAPER_CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const METAAPI_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const RESEARCH_USER_ID = 'research-user';

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date('2026-10-04T21:00:00.000Z');
  return {
    id: SESSION_ID,
    userId: RESEARCH_USER_ID,
    brokerConnectionId: PAPER_CONNECTION_ID,
    executionMode: ExecutionMode.PAPER_ONLY,
    authorityGeneration: 1,
    status: TradingSessionStatus.ACTIVE,
    openingBalance: '10000.00',
    peakEquity: '10000.00',
    riskProfileSnapshot: {},
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildController(configOverrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'vpsForexScanner.enabled': true,
    'vpsForexScanner.userId': RESEARCH_USER_ID,
    'vpsForexScanner.apiKey': 'production-key-present',
    'vpsForexScanner.brokerConnectionId': PAPER_CONNECTION_ID,
    ...configOverrides,
  };

  const tradingService = {
    startTradingSession: jest.fn().mockResolvedValue(session()),
    changeExecutionMode: jest.fn().mockResolvedValue(session()),
  } as unknown as TradingService;

  const configService = {
    get: jest.fn((key: string, fallback?: unknown) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
    ),
  } as unknown as ConfigService;

  return {
    controller: new TradingController(tradingService, configService),
    tradingService,
  };
}

describe('TradingController multi-model PAPER authority lock', () => {
  it(
    'allows the scanner-owned user to start the exact configured PAPER_ONLY binding',
    async () => {
      const { controller, tradingService } = buildController();

      const result = await controller.startSession(RESEARCH_USER_ID, {
        brokerConnectionId: PAPER_CONNECTION_ID,
        executionMode: ExecutionMode.PAPER_ONLY,
      } as StartSessionDto);

      expect(tradingService.startTradingSession).toHaveBeenCalledWith(
        RESEARCH_USER_ID,
        PAPER_CONNECTION_ID,
        ExecutionMode.PAPER_ONLY,
      );
      expect(result.brokerConnectionId).toBe(PAPER_CONNECTION_ID);
      expect(result.executionMode).toBe(ExecutionMode.PAPER_ONLY);
    },
  );

  it(
    'rejects an accidental MetaApi DEMO/FULL_AUTO start for the scanner-owned user',
    async () => {
      const { controller, tradingService } = buildController();

      await expect(
        controller.startSession(RESEARCH_USER_ID, {
          brokerConnectionId: METAAPI_CONNECTION_ID,
          executionMode: ExecutionMode.FULL_AUTO,
        } as StartSessionDto),
      ).rejects.toThrow(ForbiddenException);

      expect(tradingService.startTradingSession).not.toHaveBeenCalled();
    },
  );

  it('rejects another connection even when the request says PAPER_ONLY', async () => {
    const { controller, tradingService } = buildController();

    await expect(
      controller.startSession(RESEARCH_USER_ID, {
        brokerConnectionId: METAAPI_CONNECTION_ID,
        executionMode: ExecutionMode.PAPER_ONLY,
      } as StartSessionDto),
    ).rejects.toThrow(ForbiddenException);

    expect(tradingService.startTradingSession).not.toHaveBeenCalled();
  });

  it(
    'rejects execution-mode promotion while the research campaign owns the user',
    async () => {
      const { controller, tradingService } = buildController();

      await expect(
        controller.changeExecutionMode(RESEARCH_USER_ID, SESSION_ID, {
          executionMode: ExecutionMode.FULL_AUTO,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(tradingService.changeExecutionMode).not.toHaveBeenCalled();
    },
  );

  it(
    'does not change generic trading behavior for users outside the configured research campaign',
    async () => {
      const { controller, tradingService } = buildController();
      const ordinaryUser = 'ordinary-user';
      (tradingService.startTradingSession as jest.Mock).mockResolvedValue(
        session({
          userId: ordinaryUser,
          brokerConnectionId: METAAPI_CONNECTION_ID,
          executionMode: ExecutionMode.FULL_AUTO,
        }),
      );

      const result = await controller.startSession(ordinaryUser, {
        brokerConnectionId: METAAPI_CONNECTION_ID,
        executionMode: ExecutionMode.FULL_AUTO,
      } as StartSessionDto);

      expect(tradingService.startTradingSession).toHaveBeenCalledWith(
        ordinaryUser,
        METAAPI_CONNECTION_ID,
        ExecutionMode.FULL_AUTO,
      );
      expect(result.executionMode).toBe(ExecutionMode.FULL_AUTO);
    },
  );
});
