import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TradingAuthorityGeneration } from '../users/entities/trading-authority-generation.entity';
import { RiskGrant } from '../execution/entities/risk-grant.entity';
import { ExecutionConfirmation } from '../execution/entities/execution-confirmation.entity';
import { TradingPolicyState } from './entities/trading-policy-state.entity';
import { TradingPolicyRevisionLog } from './entities/trading-policy-revision-log.entity';
import { ProviderLiveVerificationState } from './entities/provider-live-verification-state.entity';
import { ProviderLiveVerificationRevisionLog } from './entities/provider-live-verification-revision-log.entity';
import { ExecutionControlRevisionState } from './entities/execution-control-revision.entity';
import { AuditModule } from '../audit/audit.module';
import { TradingAuthorityService } from './trading-authority.service';
import { SharedControlRevisionService } from './shared-control-revision.service';
import { GrantInvalidationService } from './grant-invalidation.service';

/**
 * ExecutionAuthorityModule — Sprint 56 correction round 6, issues #300 / #363 /
 * #299.
 *
 * Owns the two durable authority/revision services of the execution-authority
 * chain:
 *   - TradingAuthorityService — per-user monotonic trading-authority
 *     generation (issue #300). Fail-closed reads (NEVER `?? 1`), atomic
 *     monotonic CAS bumps, optional EntityManager for atomicity with the
 *     caller's authority fact.
 *   - SharedControlRevisionService — cross-replica shared trading-policy +
 *     provider LIVE-verification revisions (issue #363) and the global
 *     execution-control revision with the no-resurrection invariant
 *     (issue #299).
 *
 * AuditModule is the only non-forFeature import: both services write audit
 * rows via AuditService. No forwardRef is needed — nothing imports this module
 * yet (consumer wiring is orchestrator work; registering the same entities in
 * two modules' forFeature is safe, both resolve against the shared
 * DataSource).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TradingAuthorityGeneration,
      RiskGrant,
      ExecutionConfirmation,
      TradingPolicyState,
      TradingPolicyRevisionLog,
      ProviderLiveVerificationState,
      ProviderLiveVerificationRevisionLog,
      ExecutionControlRevisionState,
    ]),
    AuditModule,
  ],
  providers: [TradingAuthorityService, SharedControlRevisionService, GrantInvalidationService],
  exports: [TradingAuthorityService, SharedControlRevisionService, GrantInvalidationService],
})
export class ExecutionAuthorityModule {}
