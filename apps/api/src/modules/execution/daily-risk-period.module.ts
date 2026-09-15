import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyRiskPeriod } from './entities/daily-risk-period.entity';
import { Trade } from './entities/trade.entity';
import { DailyRiskPeriodService } from './services/daily-risk-period.service';

/**
 * DailyRiskPeriodModule — Round 6 (#362/#313).
 *
 * A LEAF module owning the durable per-(user, logical account, currency, UTC
 * day) risk-period service. Both RiskModule and ExecutionModule import it
 * PLAINLY — no forwardRef anywhere — so the daily-loss budget authority is
 * shared WITHOUT extending the existing RiskModule↔ExecutionModule circular
 * import (stacking provider-level forwardRef onto that cycle is what crashed
 * full-graph DI compilation in the lost Round-6 tree).
 *
 * DailyRiskPeriodService depends only on its repository + the DataSource
 * (raw exact-string SUM over the trades table) — nothing imports this module
 * back.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DailyRiskPeriod, Trade])],
  providers: [DailyRiskPeriodService],
  exports: [DailyRiskPeriodService],
})
export class DailyRiskPeriodModule {}
