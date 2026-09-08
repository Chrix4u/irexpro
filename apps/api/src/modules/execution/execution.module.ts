import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ExecutionController } from './execution.controller';
import { ExecutionReadService } from './execution-read.service';
import { ExecutionService } from './execution.service';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { Trade } from './entities/trade.entity';
import { TradingSession } from './entities/trading-session.entity';
import { Order } from './orders/order.entity';
import { OrderService } from './orders/order.service';
import {
  TradeReconciliationJob,
  TRADE_RECONCILIATION_QUEUE,
} from './jobs/trade-reconciliation.job';
import { TradeReconciliationProducer } from './jobs/trade-reconciliation.producer';
import { StateReconciliationService } from './reconciliation/state-reconciliation.service';
import { ReconciliationPersistenceService } from './reconciliation/reconciliation-persistence.service';
import { ReconciliationResolutionService } from './reconciliation/reconciliation-resolution.service';
import { ReconciliationRun } from './reconciliation/entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from './reconciliation/entities/reconciliation-discrepancy.entity';
import { BrokerAccount } from '../broker/entities/broker-account.entity';
import { RiskModule } from '../risk/risk.module';
import { BrokerModule } from '../broker/broker.module';
import { AuditModule } from '../audit/audit.module';
import { ExecutionControlModule } from '../execution-control/execution-control.module';

/**
 * ExecutionModule — Live trade execution, lifecycle management, and
 * frontend-safe read projections.
 *
 * Sprint 50 PR-3: ExecutionOrchestrator joins the providers — the order-domain
 * dispatch pipeline (gates → idempotent reservation → provider dispatch →
 * response handling → machine-guarded transitions). ExecutionControlModule
 * provides the fail-closed emergency control plane the orchestrator checks
 * before every dispatch.
 *
 * Sprint 50 PR-4: the state-reconciliation slice (Directive PHASE G) —
 * StateReconciliationService (full internal↔provider diff per connection),
 * ReconciliationPersistenceService (runs + discrepancy persistence), and
 * ReconciliationResolutionService (safe, machine-guarded convergence). The
 * scheduled TradeReconciliationJob now drives this service instead of inline
 * per-trade logic.
 *
 * Circular dependency with RiskModule (Risk uses ExecutionService for
 * trade counts / daily P&L; Execution uses RiskDecision types).
 * Resolved via forwardRef() on both sides.
 *
 * See: docs/architecture/12-execution-engine-architecture.md
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Trade,
      TradingSession,
      Order,
      BrokerAccount,
      ReconciliationRun,
      ReconciliationDiscrepancy,
    ]),
    BullModule.registerQueue({ name: TRADE_RECONCILIATION_QUEUE }),
    forwardRef(() => RiskModule),
    BrokerModule,
    AuditModule,
    ExecutionControlModule,
  ],
  controllers: [ExecutionController],
  providers: [
    ExecutionService,
    ExecutionOrchestrator,
    ExecutionReadService,
    OrderService,
    StateReconciliationService,
    ReconciliationPersistenceService,
    ReconciliationResolutionService,
    TradeReconciliationJob,
    TradeReconciliationProducer,
  ],
  exports: [ExecutionService, ExecutionOrchestrator, ExecutionReadService, OrderService],
})
export class ExecutionModule {}
