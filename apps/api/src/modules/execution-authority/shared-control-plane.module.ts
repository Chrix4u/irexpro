import { Module } from '@nestjs/common';
import { ExecutionAuthorityModule } from './execution-authority.module';
import { UsersModule } from '../users/users.module';
import { SharedControlPlaneBootstrap } from './shared-control-plane.bootstrap';

/**
 * SharedControlPlaneModule — Round 6 (#363): registers the deployment-time
 * shared control-plane sync (trading-policy + provider-verification catalog
 * revisions). A LEAF consumer of UsersModule + ExecutionAuthorityModule —
 * nothing imports this module back, so the graph stays acyclic.
 */
@Module({
  imports: [ExecutionAuthorityModule, UsersModule],
  providers: [SharedControlPlaneBootstrap],
})
export class SharedControlPlaneModule {}
