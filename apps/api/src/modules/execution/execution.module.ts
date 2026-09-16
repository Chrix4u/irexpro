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
import { TradeIntent } from './entities/trade-intent.entity';
import { CapitalAllocation } from './entities/capital-allocation.entity';
import { CapitalBudget } from './entities/capital-budget.entity';
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
// Round 7 (P1): the expiry-hygiene sweeper + the durable emergency flatten.
import { ExecutionExpiryJob, EXECUTION_EXPIRY_QUEUE } from './jobs/execution-expiry.job';
import { ExecutionExpiryProducer } from './jobs/execution-expiry.producer';
import { EMERGENCY_FLATTEN_QUEUE } from './jobs/emergency-flatten.constants';
import { EmergencyFlattenJob } from './jobs/emergency-flatten.job';
import { EmergencyFlattenProducer } from './jobs/emergency-flatten.producer';
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
import { ExecutionAuthorityModule } from '../execution-authority/execution-authority.module';
import { DailyRiskPeriodModule } from './daily-risk-period.module';
import { TradeIntentService } from './services/trade-intent.service';
// Round 6 live-execution completion (§3/§4): the portfolio allocation
// engine + the deterministic fail-closed position-sizing engine.
import { MarketSafetyGateService } from './orchestration/market-safety-gate.service';
// Round 6 live-execution completion (§14): the per-account dispatch lease.
import { AccountDispatchLeaseService } from './orchestration/account-dispatch-lease.service';
import { AllocationService } from './services/allocation.service';
import { PositionSizingService } from './services/position-sizing.service';
// Round 6 live-execution completion (§8): the protective-order
// reconciliation loop (per-trade SL/TP verify/repair).
import { ProtectiveOrderReconciliationService } from './reconciliation/protective-order-reconciliation.service';

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
      TradeIntent,
      CapitalAllocation,
      CapitalBudget,
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
    BullModule.registerQueue(
      { name: TRADE_RECONCILIATION_QUEUE },
      // Round 7 (P1): the expiry-hygiene sweeper + the durable kill-switch
      // flatten queue (crash-surviving emergency de-risking).
      { name: EXECUTION_EXPIRY_QUEUE },
      { name: EMERGENCY_FLATTEN_QUEUE },
    ),
    forwardRef(() => RiskModule),
    BrokerModule,
    AuditModule,
    ExecutionControlModule,
    // Round 6: PLAIN leaf imports — the unified execution-authority services
    // (the final-dispatch boundary's commitment re-verification reads the
    // TradingAuthorityGeneration + shared control-plane revisions and
    // consumes grants/confirmations through the tenant-scoped CAS seams) and
    // the daily-risk-period authority. Acyclic on purpose: no forwardRef is
    // stacked onto the existing RiskModule cycle.
    ExecutionAuthorityModule,
    DailyRiskPeriodModule,
  ],
  controllers: [ExecutionController, ExecutionConfirmationController],
  providers: [
    ExecutionService,
    // Round 6 live-execution completion (§2): the durable normalized
    // TradeIntent layer — idempotent per (user, intentKey), full decision
    // provenance, authority generations at creation.
    TradeIntentService,
    // Round 6 §3/§4: allocation (server-side authoritative portfolio layer)
    // + position sizing (deterministic, fail-closed, ExactDecimal-only).
    AllocationService,
    PositionSizingService,
    // Round 6 §5/§18: the final market-safety gate (pre-commitment) —
    // proven fresh quote + spread sanity + entry deviation, before the
    // provider-dispatch commitment, NEW-EXPOSURE PLACE only.
    MarketSafetyGateService,
    // Round 6 §14: the per-account dispatch lease — the full dispatch
    // critical section is strictly serialized per broker account.
    AccountDispatchLeaseService,
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
    // Round 6 §8: the protective-order reconciliation loop runs after every
    // per-connection state sweep (same sequential adapter model).
    ProtectiveOrderReconciliationService,
    TradeReconciliationJob,
    TradeReconciliationProducer,
    // Round 7 (P1): the expiry-hygiene sweeper (stale intents/confirmations
    // expire proactively; their capital reservations are released) + the
    // durable emergency-flatten worker/producer (the kill-switch flatten
    // survives a process crash between the authority write and the close).
    ExecutionExpiryJob,
    ExecutionExpiryProducer,
    EmergencyFlattenJob,
    EmergencyFlattenProducer,
  ],
  exports: [
    ExecutionService,
    TradeIntentService,
    AllocationService,
    PositionSizingService,
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
