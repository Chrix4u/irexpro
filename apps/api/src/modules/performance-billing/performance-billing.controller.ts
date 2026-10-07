import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, CurrentUserId } from '../../common/decorators/current-user.decorator';
import { AuthenticatedPrincipal } from '../../common/interfaces/authenticated-principal.interface';
import { RoleName } from '../users/entities/role.entity';
import { PerformanceFeeBillingCycleService } from './services/performance-fee-billing-cycle.service';
import { CreateBillingCycleDto } from './dto/create-billing-cycle.dto';
import { RunBillingCycleDto } from './dto/run-billing-cycle.dto';
import { CancelBillingCycleDto } from './dto/cancel-billing-cycle.dto';
import { BillingCycleStatus } from './entities/performance-fee-billing-cycle.entity';

/**
 * PerformanceBillingController
 *
 * REST API surface for the performance fee billing cycle workflow.
 *
 * Access rules:
 * - POST (create/run/cancel) — ADMIN / SUPER_ADMIN only.
 * - GET (list/get) — ADMIN / SUPER_ADMIN see all; normal users see only own data.
 * - No user can read another user's cycle unless they are an admin.
 *
 * SAFETY RULES:
 * - No broker withdrawals or auto-charges initiated here.
 * - No HWM updates here — those happen only after a verified payment webhook.
 * - No credentials, secrets, or raw payloads in any response.
 */
@Controller('performance-billing')
@UseGuards(RolesGuard)
export class PerformanceBillingController {
  constructor(private readonly svc: PerformanceFeeBillingCycleService) {}

  /** Create a DRAFT billing cycle (does not run it). Admin only. */
  @Post('cycles')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  createCycle(
    @Body() dto: CreateBillingCycleDto,
    @CurrentUserId() actorId: string,
    @Request() req: { ip?: string },
  ) {
    return this.svc.createBillingCycle(
      dto.userId,
      dto.brokerConnectionId ?? null,
      new Date(dto.periodStart),
      new Date(dto.periodEnd),
      dto.currency,
      actorId,
      req.ip,
    );
  }

  /** Run an existing billing cycle by id. Admin only. */
  @Post('cycles/:id/run')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  runCycle(
    @Param('id') id: string,
    @CurrentUserId() actorId: string,
    @Request() req: { ip?: string },
  ) {
    return this.svc.runBillingCycle(id, actorId, req.ip);
  }

  /** Create and immediately run a billing cycle (convenience endpoint). Admin only. */
  @Post('cycles/run')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  runDirect(
    @Body() dto: RunBillingCycleDto,
    @CurrentUserId() actorId: string,
    @Request() req: { ip?: string },
  ) {
    return this.svc.runBillingCycleForUserPeriod(
      dto.userId,
      dto.brokerConnectionId ?? null,
      new Date(dto.periodStart),
      new Date(dto.periodEnd),
      dto.currency,
      actorId,
      req.ip,
    );
  }

  /**
   * List billing cycles.
   * - Admin: all cycles, optionally filtered by userId and/or status.
   * - Normal user: always scoped to own userId; cross-user access forbidden.
   */
  @Get('cycles')
  listCycles(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('userId') queryUserId?: string,
    @Query('status') status?: BillingCycleStatus,
  ) {
    const isAdmin = this.isAdmin(principal);

    if (!isAdmin && queryUserId && queryUserId !== principal.userId) {
      throw new ForbiddenException('You can only view your own billing cycles');
    }

    const effectiveUserId = isAdmin ? queryUserId : principal.userId;
    return this.svc.listBillingCycles({ userId: effectiveUserId, status });
  }

  /**
   * Get a single billing cycle.
   * - Admin: any cycle.
   * - Normal user: only own cycles.
   */
  @Get('cycles/:id')
  async getCycle(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    const cycle = await this.svc.getBillingCycle(id);

    if (!this.isAdmin(principal) && cycle.userId !== principal.userId) {
      throw new ForbiddenException('You can only view your own billing cycles');
    }

    return cycle;
  }

  /** Cancel a billing cycle. Admin only. */
  @Post('cycles/:id/cancel')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  cancelCycle(
    @Param('id') id: string,
    @Body() dto: CancelBillingCycleDto,
    @CurrentUserId() actorId: string,
    @Request() req: { ip?: string },
  ) {
    return this.svc.cancelBillingCycle(id, dto.reason, actorId, req.ip);
  }

  private isAdmin(principal: AuthenticatedPrincipal): boolean {
    return (
      principal.roles?.some((r) => r === RoleName.ADMIN || r === RoleName.SUPER_ADMIN) ?? false
    );
  }
}
