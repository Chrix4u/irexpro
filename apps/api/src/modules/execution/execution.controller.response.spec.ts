import { ExecutionController } from './execution.controller';
import { ExecutionReadService } from './execution-read.service';
import { AllocationService } from './services/allocation.service';
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
    accountCurrency: 'USD',
    realisedPnl: null,
    commission: '0.20',
    swap: '0',
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
      listClosedExecutions: jest.fn().mockResolvedValue([
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
      {} as AllocationService,
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

  it('passes user UUID and requested limit into closed-trade reads', async () => {
    await controller.listClosedExecutions(USER_ID, 25);
    expect(readService.listClosedExecutions).toHaveBeenCalledWith(USER_ID, 25);
  });

  it('does not expose internal execution entity identifiers', async () => {
    const [response] = await controller.listOpenPositions(USER_ID);
    const keys = Object.keys(response);

    expect(keys).not.toContain('userId');
    expect(keys).not.toContain('brokerConnectionId');
    expect(keys).not.toContain('signalId');
    expect(keys).not.toContain('idempotencyKey');
    expect(keys).not.toContain('externalOrderId');
    expect(keys).not.toContain('brokerRejectionReason');

    expect(response).toMatchObject({
      instrument: 'EURUSD',
      direction: TradeDirection.BUY,
      status: TradeStatus.OPEN,
      fillPrice: '1.10010000',
      accountCurrency: 'USD',
      realisedPnl: null,
    });
  });

  it('exposes only a bounded execution reason classification for rejected trades', async () => {
    readService.listRecentExecutions.mockResolvedValue([
      makeTrade({
        status: TradeStatus.REJECTED,
        brokerRejectionReason:
          'MARKET_SAFETY_PRICE_DEVIATION_EXCESSIVE: internal provider detail must not leak',
      }),
    ]);

    const [response] = await controller.listRecentExecutions(USER_ID, 50);

    expect(response.executionReasonCode).toBe('MARKET_SAFETY_PRICE_DEVIATION_EXCESSIVE');
    expect(Object.keys(response)).not.toContain('brokerRejectionReason');
    expect(JSON.stringify(response)).not.toContain('internal provider detail');
  });

  it('returns authoritative lifecycle fields and currency-bound realized P&L', async () => {
    const [response] = await controller.listRecentExecutions(USER_ID, 50);
    expect(response.exitPrice).toBe('1.10800000');
    expect(response.closeReason).toBe(TradeCloseReason.TAKE_PROFIT_HIT);
    expect(response.accountCurrency).toBe('USD');
    expect(response.realisedPnl).toBe('80.25');
    expect(response.commission).toBe('0.20');
    expect(response.swap).toBe('0');
  });
});
