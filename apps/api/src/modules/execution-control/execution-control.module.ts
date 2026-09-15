import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutionControl } from './entities/execution-control.entity';
import { ExecutionControlService } from './execution-control.service';
import { ExecutionControlController } from './execution-control.controller';
import { AuditModule } from '../audit/audit.module';
import { ExecutionAuthorityModule } from '../execution-authority/execution-authority.module';

/**
 * ExecutionControlModule — server-side emergency control plane (Directive §28).
 *
 * Exported so RiskModule / StrategyModule / ExecutionModule can inject
 * ExecutionControlService and gate new work through
 * assertExecutionAllowed() BEFORE any provider dispatch. The check is
 * fail-closed: an unreadable control store blocks execution.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ExecutionControl]),
    AuditModule,
    // Round 6 (#299/#14): activation/deactivation bump the shared global
    // execution-control revision atomically (no boolean resurrection).
    ExecutionAuthorityModule,
  ],
  controllers: [ExecutionControlController],
  providers: [ExecutionControlService],
  exports: [ExecutionControlService],
})
export class ExecutionControlModule {}
