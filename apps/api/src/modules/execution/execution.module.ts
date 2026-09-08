import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ExecutionController } from './execution.controller';
import { ExecutionReadService } from './execution-read.service';
import { ExecutionService } from './execution.service';
import { Trade } from './entities/trade.entity';
import { TradingSession } from './entities/trading-session.entity';
import { Order } from './orders/order.entity';
import { OrderService } from './orders/order.service';
import {
  TradeReconciliationJob,
  TRADE_RECONCILIATION_QUEUE,
} from './jobs/trade-reconciliation.job';
import { TradeReconciliationProducer } from './jobs/trade-reconciliation.producer';
import { RiskModule } from '../risk/risk.module';
import { BrokerModule } from '../broker/broker.module';
import { AuditModule } from '../audit/audit.module';

/**
 * ExecutionModule — Live trade execution, lifecycle management, and
 * frontend-safe read projections.
 *
 * Circular dependency with RiskModule (Risk uses ExecutionService for
 * trade counts / daily P&L; Execution uses RiskDecision types).
 * Resolved via forwardRef() on both sides.
 *
 * See: docs/architecture/12-execution-engine-architecture.md
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Trade, TradingSession, Order]),
    BullModule.registerQueue({ name: TRADE_RECONCILIATION_QUEUE }),
    forwardRef(() => RiskModule),
    BrokerModule,
    AuditModule,
  ],
  controllers: [ExecutionController],
  providers: [
    ExecutionService,
    ExecutionReadService,
    OrderService,
    TradeReconciliationJob,
    TradeReconciliationProducer,
  ],
  exports: [ExecutionService, ExecutionReadService, OrderService],
})
export class ExecutionModule {}
