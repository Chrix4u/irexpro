import { Repository } from 'typeorm';
import { ExecutionReadService } from './execution-read.service';
import { Trade, TradeStatus } from './entities/trade.entity';

describe('ExecutionReadService', () => {
  let service: ExecutionReadService;
  let tradeRepo: Pick<Repository<Trade>, 'find'> & { find: jest.Mock };

  const USER_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    tradeRepo = { find: jest.fn().mockResolvedValue([]) };
    service = new ExecutionReadService(tradeRepo as unknown as Repository<Trade>);
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
});
