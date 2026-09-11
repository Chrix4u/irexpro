import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ExecutionController } from './execution.controller';
import { ExecutionConfirmationController } from './execution-confirmation.controller';
import { ExecutionConfirmationService } from './execution-confirmation.service';
import { ExecutionReadService } from './execution-read.service';
import { ExecutionService } from './execution.service';
import { ExecutionSessionResolutionService } from './execution-session.resolution';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { FinalDispatchBoundary } from './orchestration/final-dispatch-boundary';
import { AiSignalIdentityGateService } from './orchestration/signal-identity.gate';
import { TradeLifecycleCasService } from './orders/trade-lifecycle-cas.service';
import { Trade } from './entities/trade.entity';
import { TradingSession } from './entities/trading-session.entity';
import { RiskGrant } from './entities/risk-grant.entity';
import { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import { AiSignalIdentity } from './entities/ai-signal-identity.entity';
import { Order } from './orders/order.entity';
import { OrderService } from './orders/order.service';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
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
      RiskGrant,
      ExecutionConfirmation,
      AiSignalIdentity,
      Order,
      BrokerAccount,
      ReconciliationRun,
      ReconciliationDiscrepancy,
      // Round 5 (task 50-c): the SEMI_AUTO confirmation path rebuilds the
      // execution decision from the consumed grant and needs the CURRENT
      // risk profile's daily-trade limit (read-only repository use; the
      // entity itself is risk-module-owned).
      RiskProfile,
    ]),
    BullModule.registerQueue({ name: TRADE_RECONCILIATION_QUEUE }),
    forwardRef(() => RiskModule),
    BrokerModule,
    AuditModule,
    ExecutionControlModule,
  ],
  controllers: [ExecutionController, ExecutionConfirmationController],
  providers: [
    ExecutionService,
    // Round 5 (#295): the session-resolution seam every EXECUTION-side
    // NEW-exposure decision uses (TradingSession = authoritative target).
    ExecutionSessionResolutionService,
    ExecutionOrchestrator,
    // Round 5 (task 50-c): the FINAL DISPATCH BOUNDARY — grant/session/
    // connection/mode/confirmation/control re-verification + atomic
    // consumption immediately before any provider state-changing call.
    FinalDispatchBoundary,
    // Round 5 (task 50-c): the pipeline-entry signal-identity gate (#302).
    AiSignalIdentityGateService,
    // Round 5 (task 50-c): CAS discipline for every provider-bound Trade
    // lifecycle transition (#315).
    TradeLifecycleCasService,
    // Round 5 (task 50-c): the SEMI_AUTO confirmation surface (#298).
    ExecutionConfirmationService,
    // The grant-consumer seam is NOT re-provided here: FinalDispatchBoundary
    // consumes the risk module's RiskGrantService directly (the 50-b
    // contract owner — issueGrant / consumeGrantAtomic /
    // invalidateGrantsForSession), injected via forwardRef across the
    // RiskModule ↔ ExecutionModule import cycle.
    ExecutionReadService,
    OrderService,
    StateReconciliationService,
    ReconciliationPersistenceService,
    ReconciliationResolutionService,
    TradeReconciliationJob,
    TradeReconciliationProducer,
  ],
  exports: [
    ExecutionService,
    ExecutionSessionResolutionService,
    ExecutionOrchestrator,
    FinalDispatchBoundary,
    AiSignalIdentityGateService,
    TradeLifecycleCasService,
    ExecutionReadService,
    OrderService,
  ],
})
export class ExecutionModule {}
