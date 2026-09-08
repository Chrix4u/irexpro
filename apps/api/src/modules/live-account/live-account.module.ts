import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../broker/entities/broker-account.entity';
import { Trade } from '../execution/entities/trade.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';
import { Order } from '../execution/orders/order.entity';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from '../execution/reconciliation/entities/reconciliation-discrepancy.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import { BrokerModule } from '../broker/broker.module';
import { LiveAccountController } from './live-account.controller';
import { LiveAccountService } from './live-account.service';

/**
 * LiveAccountModule — USER Live Account read API (Sprint 50 PR-5 —
 * Directive PHASE J).
 *
 * Read-only aggregation over PR-1..PR-4 state: broker connections/accounts
 * (PR-1), orders + positions (PR-2), execution orchestration outcomes
 * (PR-3), reconciliation runs/discrepancies (PR-4), audit activity, and the
 * user's risk profile (kill switch). NO new tables — this module only reads.
 *
 * Cross-module entity imports follow the BrokerReconciliationModule /
 * ExecutionModule pattern (TypeOrmModule.forFeature over the owning modules'
 * entities). BrokerModule is imported so the service can REUSE the Sprint 50
 * fail-closed executable gate (BrokerService.isConnectionExecutable) instead
 * of re-implementing a divergent copy.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      BrokerConnection,
      BrokerAccount,
      Trade,
      TradingSession,
      Order,
      ReconciliationRun,
      ReconciliationDiscrepancy,
      AuditLog,
      RiskProfile,
    ]),
    BrokerModule,
  ],
  controllers: [LiveAccountController],
  providers: [LiveAccountService],
  exports: [LiveAccountService],
})
export class LiveAccountModule {}
