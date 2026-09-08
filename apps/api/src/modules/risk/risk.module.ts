import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RiskService } from './risk.service';
import { RiskController } from './risk.controller';
import { RiskIntelligenceController } from './risk-intelligence.controller';
import { RiskIntelligenceService } from './risk-intelligence.service';
import { RiskProfile } from './entities/risk-profile.entity';
import { RiskViolation } from './entities/risk-violation.entity';
import { BrokerModule } from '../broker/broker.module';
import { AuditModule } from '../audit/audit.module';
import { ExecutionModule } from '../execution/execution.module';
import { ExecutionControlModule } from '../execution-control/execution-control.module';

/**
 * RiskModule — Non-bypassable pre-trade validation gateway.
 *
 * Circular dependency with ExecutionModule:
 *   - RiskService uses ExecutionService for live trade counts and daily P&L
 *   - ExecutionService imports RiskDecision types (no runtime DI cycle needed there)
 * Resolved via forwardRef().
 *
 * Sprint 50: imports ExecutionControlModule so the pipeline's Step 1a-pre
 * emergency-control gate (GLOBAL/PROVIDER/USER/CONNECTION) resolves.
 *
 * See: docs/architecture/11-risk-engine-architecture.md
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RiskProfile, RiskViolation]),
    BrokerModule,
    AuditModule,
    ExecutionControlModule,
    forwardRef(() => ExecutionModule),
  ],
  controllers: [RiskController, RiskIntelligenceController],
  providers: [RiskService, RiskIntelligenceService],
  exports: [RiskService, RiskIntelligenceService],
})
export class RiskModule {}
