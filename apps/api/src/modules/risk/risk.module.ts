import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RiskService } from './risk.service';
import { RiskController } from './risk.controller';
import { RiskIntelligenceController } from './risk-intelligence.controller';
import { RiskIntelligenceService } from './risk-intelligence.service';
import { RiskGrantService } from './risk-grant.service';
import { RiskOrderGeometryService } from './risk-order-geometry.service';
import { RiskProfile } from './entities/risk-profile.entity';
import { RiskViolation } from './entities/risk-violation.entity';
import { RiskGrant } from '../execution/entities/risk-grant.entity';
import { ExecutionConfirmation } from '../execution/entities/execution-confirmation.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';
import { TradingAuthorityGeneration } from '../users/entities/trading-authority-generation.entity';
import { BrokerModule } from '../broker/broker.module';
import { AuditModule } from '../audit/audit.module';
import { ExecutionModule } from '../execution/execution.module';
import { ExecutionControlModule } from '../execution-control/execution-control.module';
import { ExecutionAuthorityModule } from '../execution-authority/execution-authority.module';
import { DailyRiskPeriodModule } from '../execution/daily-risk-period.module';
// Production-LIVE completion round (Phase 9): EligibilityService for the
// continuous LIVE user-eligibility gate (Step 1e). UsersModule is an acyclic
// leaf here (it imports only forFeature + AuditModule + ExecutionAuthorityModule
// + ThrottlerModule) — no cycle is introduced.
import { UsersModule } from '../users/users.module';

/**
 * RiskModule — Non-bypassable pre-trade validation gateway.
 *
 * Circular dependency with ExecutionModule:
 *   - RiskService uses ExecutionService for live trade counts and daily P&L,
 *     and ExecutionSessionResolutionService (the #295 session-authority seam)
 *   - ExecutionService imports RiskDecision types (no runtime DI cycle needed there)
 * Resolved via forwardRef().
 *
 * Sprint 50: imports ExecutionControlModule so the pipeline's Step 1a-pre
 * emergency-control gate (GLOBAL/PROVIDER/USER/CONNECTION) resolves.
 *
 * Sprint 56 correction round 5 (#301/#295/#298/#317): the risk module
 * registers the execution-authority repositories it needs — RiskGrant +
 * ExecutionConfirmation (durable grant issuance via RiskGrantService, whose
 * CAS lifecycle methods are exported for the execution-side authority gates),
 * TradingSession (session opening-balance baseline + monotonic peak-equity
 * CAS), and TradingAuthorityGeneration (the issue-#300 user-level generation
 * bound into every grant). Registering the same entities in two modules'
 * forFeature is safe — both resolve against the shared DataSource.
 *
 * See: docs/architecture/11-risk-engine-architecture.md
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RiskProfile,
      RiskViolation,
      RiskGrant,
      ExecutionConfirmation,
      TradingSession,
      TradingAuthorityGeneration,
    ]),
    BrokerModule,
    AuditModule,
    ExecutionControlModule,
    // Round 6: PLAIN leaf imports — the unified execution-authority services
    // (TradingAuthorityService / SharedControlRevisionService /
    // GrantInvalidationService) and the daily-risk-period authority. Both are
    // acyclic, so the existing forwardRef(ExecutionModule) cycle below stays
    // EXACTLY as committed (no provider-level forwardRef is stacked on it).
    ExecutionAuthorityModule,
    DailyRiskPeriodModule,
    // Production-LIVE completion round (Phase 9): continuous eligibility gate.
    UsersModule,
    forwardRef(() => ExecutionModule),
  ],
  controllers: [RiskController, RiskIntelligenceController],
  providers: [RiskService, RiskIntelligenceService, RiskGrantService, RiskOrderGeometryService],
  exports: [RiskService, RiskIntelligenceService, RiskGrantService, RiskOrderGeometryService],
})
export class RiskModule {}
