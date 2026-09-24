import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade, TradeStatus } from './entities/trade.entity';
import type { TradeEntryDecisionSource } from './dto/trade-execution-response.dto';

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
   * Resolve durable AI-decision provenance for an already user-scoped set of
   * trades. Both userId and tradeId are predicates, so a browser read can
   * never use execution ids as a cross-tenant intent lookup primitive.
   */
  async getTradeIntentMap(
    userId: string,
    trades: Trade[],
  ): Promise<Map<string, TradeEntryDecisionSource>> {
    const tradeIds = [...new Set(trades.map((trade) => trade.id).filter(Boolean))];
    if (tradeIds.length === 0) return new Map();

    const intents = (await this.tradeRepo.manager.getRepository('trade_intents').find({
      where: { userId, tradeId: In(tradeIds) },
    })) as TradeEntryDecisionSource[];

    return new Map(
      intents
        .filter((intent) => intent.tradeId)
        .map((intent) => [intent.tradeId as string, intent]),
    );
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
