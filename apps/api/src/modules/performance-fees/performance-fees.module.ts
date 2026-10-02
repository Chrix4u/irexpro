import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PerformanceFeePolicy } from './entities/performance-fee-policy.entity';
import { TradingAccountPerformance } from './entities/trading-account-performance.entity';
import { PerformanceFeeAssessment } from './entities/performance-fee-assessment.entity';
import { PerformanceFeeLedgerEntry } from './entities/performance-fee-ledger-entry.entity';
import { Invoice } from '../payments/entities/invoice.entity';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { AuditModule } from '../audit/audit.module';
import { PerformanceFeeService } from './services/performance-fee.service';
import { PerformanceFeesController } from './performance-fees.controller';
import { PerformanceFeeSimulationState } from './entities/performance-fee-simulation-state.entity';
import { PerformanceFeeSimulationCharge } from './entities/performance-fee-simulation-charge.entity';
import { PerformanceFeeSimulationService } from './services/performance-fee-simulation.service';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { Trade } from '../execution/entities/trade.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PerformanceFeePolicy,
      TradingAccountPerformance,
      PerformanceFeeAssessment,
      PerformanceFeeLedgerEntry,
      Invoice,
      PaymentTransaction,
      PerformanceFeeSimulationState,
      PerformanceFeeSimulationCharge,
      BrokerConnection,
      Trade,
    ]),
    AuditModule,
  ],
  controllers: [PerformanceFeesController],
  providers: [PerformanceFeeService, PerformanceFeeSimulationService],
  exports: [PerformanceFeeService, PerformanceFeeSimulationService],
})
export class PerformanceFeesModule {}
