import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BrokerAccountSnapshot } from '../broker/entities/broker-account-snapshot.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { Order } from '../execution/orders/order.entity';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';
import { Trade } from '../execution/entities/trade.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Round 7 (P1 metrics — audit R7-audit-C finding A6): the dependency-free,
 * in-process metrics pipeline (counters + gauges + /metrics exposition).
 *
 * PURE LEAF MODULE — imports nothing but the TypeOrm repository
 * registrations for the on-scrape DB-backed gauges (TradingSession, Trade,
 * BrokerConnection, BrokerAccountSnapshot, ReconciliationRun and Order are
 * LEAF ENTITY FILES — no service, no module imports → no import cycle with
 * ANY consumer).
 *
 * On-scrape gauge inventory (all computed by MetricsController, fail-open):
 *  - irexpro_live_sessions_active (TradingSession)
 *  - irexpro_open_trades (Trade)
 *  - irexpro_broker_connections (BrokerConnection, authorizationStatus)
 *  - irexpro_broker_snapshot_staleness_seconds (BrokerAccountSnapshot)
 *  - irexpro_reconciliation_last_cycle_age_seconds (ReconciliationRun)
 *  - irexpro_reconciliation_pending_orders (Order)
 *
 * DI DECISION (how instrumented services reach MetricsService):
 *  Consumer services (strategy-orchestrator, risk, risk-grant,
 *  execution-orchestrator, execution-expiry job, execution-control,
 *  ai-exit-orchestrator) do NOT constructor-inject MetricsService and their
 *  modules do NOT import this module. Instead each instrumented service
 *  resolves it lazily at CALL time via
 *  `ModuleRef.get(MetricsService, { strict: false })` in a private getter
 *  (the platform's established pattern — see execution-confirmation.service
 *  for the RiskModule↔ExecutionModule cycle precedent). Rationale:
 *   1. MetricsModule is registered once in AppModule, so the app-wide
 *      non-strict ModuleRef lookup finds the singleton from any module.
 *   2. Direct constructor injection would require a MetricsService provider
 *      in EVERY spec that constructs the instrumented services — including
 *      out-of-scope suites (risk.sprint32/execution.sprint32 construct
 *      RiskService/ExecutionService via DI) — and module-file imports that
 *      are outside this work item's approved file scope.
 *   3. In isolated test contexts the lookup fails → the private getter
 *      returns null → the `this.metrics?.increment(...)` call sites no-op.
 *      Metrics can never break trading control flow.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TradingSession,
      Trade,
      BrokerConnection,
      BrokerAccountSnapshot,
      ReconciliationRun,
      Order,
    ]),
  ],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
