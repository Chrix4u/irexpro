import {
  Body,
  Controller,
  ForbiddenException,
  Get,
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
import { BrokerTradeReconciliationService } from './services/broker-trade-reconciliation.service';
import { RunReconciliationDto } from './dto/run-reconciliation.dto';

/**
 * BrokerReconciliationController
 *
 * API surface for broker trade reconciliation.
 *
 * Access rules:
 * - POST /run  — ADMIN / SUPER_ADMIN only.
 * - GET /runs  — ADMIN / SUPER_ADMIN (all); USER (own data only).
 * - GET /reconciled-trades — ADMIN / SUPER_ADMIN (any userId); USER (own only).
 *
 * SAFETY RULES (enforced by this controller):
 * - Normal users can only view their own reconciliation data.
 * - Normal users cannot trigger reconciliation for another user.
 * - No broker withdrawals or auto-charges occur here.
 * - No performance-fee assessments or invoices are created here.
 * - No credentials, secrets, or raw broker payloads in any response.
 */
@Controller('broker-reconciliation')
@UseGuards(RolesGuard)
export class BrokerReconciliationController {
  constructor(private readonly svc: BrokerTradeReconciliationService) {}

  /**
   * Trigger a broker trade reconciliation run.
   * Admin / super-admin only.
   */
  @Post('closed-trades/run')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  runReconciliation(
    @Body() dto: RunReconciliationDto,
    @CurrentUserId() actorId: string,
    @Request() req: { ip?: string },
  ) {
    return this.svc.runReconciliation(
      dto.userId,
      dto.brokerConnectionId,
      new Date(dto.fromTime),
      new Date(dto.toTime),
      actorId,
      req.ip,
    );
  }

  /**
   * List reconciliation runs.
   * - Admin: can filter by any userId query param.
   * - Normal user: always filtered to own userId regardless of query param.
   */
  @Get('runs')
  getRuns(@CurrentUser() principal: AuthenticatedPrincipal, @Query('userId') queryUserId?: string) {
    const isAdmin = principal.roles?.some(
      (r) => r === RoleName.ADMIN || r === RoleName.SUPER_ADMIN,
    );

    const effectiveUserId = isAdmin ? queryUserId : principal.userId;
    return this.svc.getRuns(effectiveUserId);
  }

  /**
   * List reconciled trades.
   * - Admin: can filter by any userId and brokerConnectionId.
   * - Normal user: always filtered to own userId.
   */
  @Get('reconciled-trades')
  getReconciledTrades(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('userId') queryUserId?: string,
    @Query('brokerConnectionId') brokerConnectionId?: string,
  ) {
    const isAdmin = principal.roles?.some(
      (r) => r === RoleName.ADMIN || r === RoleName.SUPER_ADMIN,
    );

    // Non-admin users attempting to view another user's data get a 403
    if (!isAdmin && queryUserId && queryUserId !== principal.userId) {
      throw new ForbiddenException('You can only view your own reconciliation data');
    }

    const effectiveUserId = isAdmin ? queryUserId : principal.userId;
    return this.svc.getReconciledTrades(effectiveUserId, brokerConnectionId);
  }
}
