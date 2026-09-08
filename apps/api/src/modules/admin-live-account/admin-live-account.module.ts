import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../broker/entities/broker-account.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';
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
      TradingSession,
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
