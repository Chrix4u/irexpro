import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade, TradeStatus } from './entities/trade.entity';

/**
 * Read-only execution projection service for user-facing terminal clients.
 *
 * Keeping read queries separate from ExecutionService prevents browser-facing
 * concerns from expanding the live order-placement engine. Every query is
 * explicitly scoped by userId before DTO mapping occurs in the controller.
 */
@Injectable()
export class ExecutionReadService {
  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  async listOpenPositions(userId: string): Promise<Trade[]> {
    return this.tradeRepo.find({
      where: { userId, status: TradeStatus.OPEN },
      order: { openedAt: 'DESC', createdAt: 'DESC' },
      take: 100,
    });
  }

  async listRecentExecutions(userId: string, limit = 50): Promise<Trade[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.tradeRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
  }

  async listClosedExecutions(userId: string, limit = 50): Promise<Trade[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.tradeRepo.find({
      where: { userId, status: TradeStatus.CLOSED },
      order: { closedAt: 'DESC', createdAt: 'DESC' },
      take: safeLimit,
    });
  }

  /**
   * Resolve execution records for a previously user-scoped set of AI signals.
   *
   * The userId predicate is mandatory even though signal IDs are UUIDs. This
   * prevents decision lineage from becoming a cross-tenant lookup primitive.
   */
  async listBySignalIds(userId: string, signalIds: string[]): Promise<Trade[]> {
    if (signalIds.length === 0) return [];

    return this.tradeRepo.find({
      where: { userId, signalId: In(signalIds) },
      order: { createdAt: 'ASC' },
      take: 100,
    });
  }
}
