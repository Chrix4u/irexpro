import { forwardRef, Module } from '@nestjs/common';
import { StrategyOrchestratorService } from './strategy-orchestrator.service';
import { StrategyLabController } from './strategy-lab.controller';
import { StrategyLabService } from './strategy-lab.service';
import { RiskModule } from '../risk/risk.module';
import { ExecutionModule } from '../execution/execution.module';
import { BrokerModule } from '../broker/broker.module';
import { AuditModule } from '../audit/audit.module';
// Round 6 live-execution completion (§2): authority/revision reads at intent creation.
import { ExecutionAuthorityModule } from '../execution-authority/execution-authority.module';

/**
 * StrategyModule — production orchestration plus read-only Strategy Lab.
 *
 * Live execution remains on the mandatory pipeline:
 *   Signal → active-session gate → broker gate → Risk Engine → Execution Engine
 *
 * Strategy Lab is deliberately separate from that mutation path. It reads a
 * versioned deterministic fixture, verifies its checksum, and returns advisory
 * scorecards only. It cannot place trades or alter live risk/broker state.
 *
 * Uses forwardRef on ExecutionModule because StrategyModule can be imported
 * by AiModule → StrategyModule → ExecutionModule (resolves safely with forwardRef).
 */
@Module({
  imports: [
    RiskModule,
    forwardRef(() => ExecutionModule),
    BrokerModule,
    AuditModule,
    // Round 6 §2: TradingAuthorityService + SharedControlRevisionService for
    // the authority generations recorded on every TradeIntent at creation.
    // ExecutionAuthorityModule is a LEAF module (AuditModule + forFeature
    // only) — importing it here cannot create a DI cycle.
    ExecutionAuthorityModule,
  ],
  controllers: [StrategyLabController],
  providers: [StrategyOrchestratorService, StrategyLabService],
  exports: [StrategyOrchestratorService, StrategyLabService],
})
export class StrategyModule {}
