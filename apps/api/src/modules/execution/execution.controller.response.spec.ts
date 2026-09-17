import { ExecutionController } from './execution.controller';
import { ExecutionReadService } from './execution-read.service';
import { Trade, TradeCloseReason, TradeDirection, TradeStatus } from './entities/trade.entity';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const trade = new Trade();
  Object.assign(trade, {
    id: '22222222-2222-4222-8222-222222222222',
    userId: '11111111-1111-4111-8111-111111111111',
    brokerConnectionId: '33333333-3333-4333-8333-333333333333',
    signalId: '44444444-4444-4444-8444-444444444444',
    idempotencyKey: 'internal-idempotency-key',
    instrument: 'EURUSD',
    direction: TradeDirection.BUY,
    lotSize: '0.1000',
    requestedEntryPrice: '1.10000000',
    fillPrice: '1.10010000',
    stopLoss: '1.09500000',
    takeProfit: '1.11000000',
    trailingStopPips: null,
    externalOrderId: 'broker-order-secret-ish-id',
    status: TradeStatus.OPEN,
    exitPrice: null,
    realisedPnl: null,
    closeReason: null,
    brokerRejectionReason: null,
    openedAt: new Date('2026-08-28T12:00:00.000Z'),
    closedAt: null,
    createdAt: new Date('2026-08-28T11:59:00.000Z'),
    updatedAt: new Date('2026-08-28T12:00:00.000Z'),
    ...overrides,
  });
  return trade;
}

describe('ExecutionController frontend-safe responses', () => {
  let controller: ExecutionController;
  let readService: Record<string, jest.Mock>;

  const USER_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    readService = {
      listOpenPositions: jest.fn().mockResolvedValue([makeTrade()]),
      listRecentExecutions: jest.fn().mockResolvedValue([
        makeTrade({
          status: TradeStatus.CLOSED,
          exitPrice: '1.10800000',
          realisedPnl: '80.25',
          closeReason: TradeCloseReason.TAKE_PROFIT_HIT,
          closedAt: new Date('2026-08-28T14:00:00.000Z'),
        }),
      ]),
    };
    controller = new ExecutionController(
      readService as unknown as ExecutionReadService,
      { getUserCapitalBudget: jest.fn(), setUserCapitalBudget: jest.fn() } as never,
    );
  });

  it('passes only the authenticated user UUID into open-position reads', async () => {
    await controller.listOpenPositions(USER_ID);
    expect(readService.listOpenPositions).toHaveBeenCalledWith(USER_ID);
  });

  it('passes user UUID and requested limit into recent execution reads', async () => {
    await controller.listRecentExecutions(USER_ID, 25);
    expect(readService.listRecentExecutions).toHaveBeenCalledWith(USER_ID, 25);
  });

  it('does not expose internal execution entity fields or currency-less P&L', async () => {
    const [response] = await controller.listOpenPositions(USER_ID);
    const keys = Object.keys(response);

    expect(keys).not.toContain('userId');
    expect(keys).not.toContain('brokerConnectionId');
    expect(keys).not.toContain('signalId');
    expect(keys).not.toContain('idempotencyKey');
    expect(keys).not.toContain('externalOrderId');
    expect(keys).not.toContain('brokerRejectionReason');
    expect(keys).not.toContain('realisedPnl');

    expect(response).toMatchObject({
      instrument: 'EURUSD',
      direction: TradeDirection.BUY,
      status: TradeStatus.OPEN,
      fillPrice: '1.10010000',
    });
  });

  it('returns authoritative lifecycle fields without exposing persisted currency-less P&L', async () => {
    const [response] = await controller.listRecentExecutions(USER_ID, 50);
    expect(response.exitPrice).toBe('1.10800000');
    expect(response.closeReason).toBe(TradeCloseReason.TAKE_PROFIT_HIT);
    expect(Object.keys(response)).not.toContain('realisedPnl');
  });
});
