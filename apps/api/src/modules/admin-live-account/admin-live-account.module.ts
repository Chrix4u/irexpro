import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../broker/entities/broker-account.entity';
import { BrokerAccountSnapshot } from '../broker/entities/broker-account-snapshot.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';
import { Order } from '../execution/orders/order.entity';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import { RiskViolation } from '../risk/entities/risk-violation.entity';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from '../execution/reconciliation/entities/reconciliation-discrepancy.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { ExecutionControlModule } from '../execution-control/execution-control.module';
import { BrokerModule } from '../broker/broker.module';
import { AdminLiveAccountController } from './admin-live-account.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminLiveAccountService } from './admin-live-account.service';

/**
 * AdminLiveAccountModule — ADMIN live-operations read API (Sprint 50 PR-6 —
 * Directive PHASE L "Admin operations" §39 + audit investigation).
 *
 * Read-only aggregation over PR-1..PR-5 state: broker connections/accounts
 * (PR-1), trading sessions (PR-2 domain), reconciliation runs/discrepancies
 * (PR-4), execution controls (PR-3 control plane), audit logs, and the
 * broker provider registry. NO new tables — this module only reads.
 *
 * Phase 10 canary operations adds READ-ONLY repository access to the order
 * domain (trading.orders — dispatch outcomes), the risk domain
 * (risk_profiles kill-switch count, risk_violations dispatch blocks), and
 * broker_account_snapshots (staleness alerts) — still no writes, still no
 * new tables. BrokerAdapterRegistry (exported by BrokerModule) supplies the
 * metadata-only adapter version inventory.
 *
 * Cross-module entity imports follow the LiveAccountModule pattern
 * (TypeOrmModule.forFeature over the owning modules' entities).
 * ExecutionControlModule is imported so the service can REUSE
 * ExecutionControlService.listActiveControls(); BrokerModule provides BOTH
 * the fail-closed executable gate (BrokerService.isConnectionExecutable)
 * and the server-authoritative provider catalog
 * (BrokerProviderRegistryService) — nothing is re-implemented locally.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      BrokerConnection,
      BrokerAccount,
      BrokerAccountSnapshot,
      TradingSession,
      Order,
      RiskProfile,
      RiskViolation,
      ReconciliationRun,
      ReconciliationDiscrepancy,
      AuditLog,
    ]),
    ExecutionControlModule,
    BrokerModule,
  ],
  controllers: [AdminLiveAccountController, AdminAuditController],
  providers: [AdminLiveAccountService],
  exports: [AdminLiveAccountService],
})
export class AdminLiveAccountModule {}

// CI path-coverage note: this module is aggregated by the admin live-operations
// read API (Sprint 50 PR-6) and covered by admin-live-account.service.spec.ts.
