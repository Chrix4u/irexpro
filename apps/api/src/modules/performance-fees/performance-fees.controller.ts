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
import { CreatePolicyDto } from './dto/create-policy.dto';
import { ReplacePolicyDto } from './dto/replace-policy.dto';
import { CalculateAssessmentDto } from './dto/calculate-assessment.dto';
import { CreateLedgerEntryDto } from './dto/create-ledger-entry.dto';

/**
 * PerformanceFeesController
 *
 * Provides admin/internal endpoints for the performance fee engine.
 *
 * Access rules:
 * - GET /me/summary — authenticated user (own data only)
 * - All other endpoints — ADMIN or SUPER_ADMIN only
 *
 * IMPORTANT:
 * - No automatic charging occurs here.
 * - Invoicing creates a pending invoice; payment happens via verified webhook.
 * - No broker withdrawals. No live trading activation.
 */
@Controller('api/v1/performance-fees')
@UseGuards(RolesGuard)
export class PerformanceFeesController {
  constructor(private readonly svc: PerformanceFeeService) {}

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

  @Post('policies/replace')
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  replacePolicy(@Body() dto: ReplacePolicyDto, @CurrentUserId() adminId: string) {
    return this.svc.replaceActiveGlobalPolicy(dto, adminId);
  }

  // ── User summary (own data) ────────────────────────────────────────────────

  @Get('me/summary')
  getMyPerformanceSummary(@CurrentUserId() userId: string) {
    return this.svc.getUserSummary(userId);
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
