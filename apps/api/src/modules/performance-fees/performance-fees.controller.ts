import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { RoleName } from '../users/entities/role.entity';
import { PerformanceFeeService } from './services/performance-fee.service';
import { PerformanceFeeSimulationService } from './services/performance-fee-simulation.service';
import { CreatePolicyDto } from './dto/create-policy.dto';
import { CalculateAssessmentDto } from './dto/calculate-assessment.dto';
import { CreateLedgerEntryDto } from './dto/create-ledger-entry.dto';

/**
 * PerformanceFeesController
 *
 * Provides admin/internal endpoints for the performance fee engine.
 *
 * Access rules:
 * - /me/summary and /me/simulation/* — authenticated user, own data only
 * - Policy, assessment and ledger administration — ADMIN or SUPER_ADMIN only
 *
 * IMPORTANT:
 * - No automatic charging occurs here.
 * - Invoicing creates a pending invoice; payment happens via verified webhook.
 * - No broker withdrawals. No live trading activation.
 */
@Controller('performance-fees')
@UseGuards(RolesGuard)
export class PerformanceFeesController {
  constructor(
    private readonly svc: PerformanceFeeService,
    private readonly simulation: PerformanceFeeSimulationService,
  ) {}

  // ── Policy endpoints (admin only) ──────────────────────────────────────────

  @Get('policies')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  getPolicies() {
    return this.svc.getPolicies();
  }

  @Post('policies')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  createPolicy(@Body() dto: CreatePolicyDto, @CurrentUserId() adminId: string) {
    return this.svc.createPolicy(dto, adminId);
  }

  @Post('policies/:id/deactivate')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  deactivatePolicy(@Param('id', ParseUUIDPipe) id: string, @CurrentUserId() adminId: string) {
    return this.svc.deactivatePolicy(id, adminId);
  }

  // ── User summary (own data) ────────────────────────────────────────────────

  @Get('me/summary')
  getMyPerformanceSummary(@CurrentUserId() userId: string) {
    return this.svc.getUserSummary(userId);
  }

  // ── PAPER / DEMO billing simulation (user-owned, never payable) ───────────

  @Get('me/simulation')
  getMySimulation(@CurrentUserId() userId: string) {
    return this.simulation.getUserSimulation(userId);
  }

  @Post('me/simulation/:brokerConnectionId/refresh')
  refreshMySimulation(
    @CurrentUserId() userId: string,
    @Param('brokerConnectionId', ParseUUIDPipe) brokerConnectionId: string,
  ) {
    return this.simulation.refresh(userId, brokerConnectionId);
  }

  @Post('me/simulation/charges/:chargeId/settle')
  settleMySimulationCharge(
    @CurrentUserId() userId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
  ) {
    return this.simulation.settleTestCharge(userId, chargeId);
  }

  // ── Assessment endpoints ───────────────────────────────────────────────────

  @Get('assessments')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  getAssessments(@Query('userId') userId?: string) {
    return this.svc.getAssessments(userId);
  }

  @Post('assessments/calculate')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  calculateAssessment(@Body() dto: CalculateAssessmentDto, @CurrentUserId() adminId: string) {
    return this.svc.calculateAssessment(
      dto.userId,
      dto.brokerConnectionId ?? null,
      dto.currency,
      new Date(dto.periodStart),
      new Date(dto.periodEnd),
      adminId,
    );
  }

  @Post('assessments/:id/invoice')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  invoiceAssessment(@Param('id', ParseUUIDPipe) id: string, @CurrentUserId() adminId: string) {
    return this.svc.invoiceAssessment(id, adminId);
  }

  // ── Ledger entry endpoint (admin only) ────────────────────────────────────

  @Post('ledger-entries')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  createLedgerEntry(@Body() dto: CreateLedgerEntryDto, @CurrentUserId() adminId: string) {
    return this.svc.recordLedgerEntry(dto, adminId);
  }
}
