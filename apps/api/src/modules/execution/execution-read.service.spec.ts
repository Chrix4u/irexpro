import { Repository } from 'typeorm';
import { ExecutionReadService } from './execution-read.service';
import { Trade, TradeStatus } from './entities/trade.entity';
import { TradeIntent } from './entities/trade-intent.entity';

describe('ExecutionReadService', () => {
  let service: ExecutionReadService;
  let tradeRepo: Pick<Repository<Trade>, 'find'> & { find: jest.Mock };
  let tradeIntentRepo: Pick<Repository<TradeIntent>, 'find'> & { find: jest.Mock };

  const USER_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    tradeRepo = { find: jest.fn().mockResolvedValue([]) };
    tradeIntentRepo = { find: jest.fn().mockResolvedValue([]) };
    service = new ExecutionReadService(
      tradeRepo as unknown as Repository<Trade>,
      tradeIntentRepo as unknown as Repository<TradeIntent>,
    );
  });

  it('scopes open positions to the authenticated user and OPEN status', async () => {
    await service.listOpenPositions(USER_ID);

    expect(tradeRepo.find).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: TradeStatus.OPEN },
      order: { openedAt: 'DESC', createdAt: 'DESC' },
      take: 100,
    });
  });

  it('scopes recent executions to the authenticated user', async () => {
    await service.listRecentExecutions(USER_ID, 25);

    expect(tradeRepo.find).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      order: { createdAt: 'DESC' },
      take: 25,
    });
  });

  it('clamps recent execution limits to 1..100', async () => {
    await service.listRecentExecutions(USER_ID, 999);
    expect(tradeRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 100 }));

    await service.listRecentExecutions(USER_ID, -5);
    expect(tradeRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1 }));
  });

  it('keeps closed trade history independent from rejected activity noise', async () => {
    await service.listClosedExecutions(USER_ID, 25);

    expect(tradeRepo.find).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: TradeStatus.CLOSED },
      order: { closedAt: 'DESC', createdAt: 'DESC' },
      take: 25,
    });
  });

  it('clamps closed trade history limits to 1..100', async () => {
    await service.listClosedExecutions(USER_ID, 999);
    expect(tradeRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 100 }));

    await service.listClosedExecutions(USER_ID, -5);
    expect(tradeRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1 }));
  });

  it('batch-resolves trade intents with both user and trade ids', async () => {
    const tradeA = { id: 'trade-a' } as Trade;
    const tradeB = { id: 'trade-b' } as Trade;
    tradeIntentRepo.find.mockResolvedValue([
      { tradeId: 'trade-a', userId: USER_ID } as TradeIntent,
      { tradeId: 'trade-b', userId: USER_ID } as TradeIntent,
    ]);

    const result = await service.getTradeIntentMap(USER_ID, [tradeA, tradeB]);

    expect(tradeIntentRepo.find).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        tradeId: expect.anything(),
      },
    });
    expect(result.get('trade-a')?.userId).toBe(USER_ID);
    expect(result.get('trade-b')?.userId).toBe(USER_ID);
  });

  it('does not query intent storage when there are no trades', async () => {
    await expect(service.getTradeIntentMap(USER_ID, [])).resolves.toEqual(new Map());
    expect(tradeIntentRepo.find).not.toHaveBeenCalled();
  });
});
