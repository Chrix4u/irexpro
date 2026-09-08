import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleName } from '../users/entities/role.entity';
import { AdminConnectionFilter, AdminDiscrepancyFilter } from './dto/admin-live-account.enums';
import { AdminLiveOpsOverviewViewDto } from './dto/admin-live-account-overview-response.dto';
import { AdminConnectionsPageDto } from './dto/admin-connections-response.dto';
import { AdminDiscrepanciesPageDto } from './dto/admin-discrepancies-response.dto';
import {
  AdminLiveAccountService,
  clampPaginationLimit,
  clampPaginationOffset,
  normalizeAdminConnectionFilter,
  normalizeAdminDiscrepancyFilter,
} from './admin-live-account.service';

/**
 * ADMIN LIVE OPERATIONS read API (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * Read-only admin visibility over broker connections, provider health,
 * authorization state, reconciliation discrepancies, execution-control
 * inventory, and automation suspension counts. Cross-user visibility is
 * INTENTIONAL here (admin scope) — RBAC is enforced exactly like
 * ExecutionControlController: @UseGuards(JwtAuthGuard, RolesGuard) +
 * @Roles(ADMIN, SUPER_ADMIN) at the CLASS level, so USER-role requests are
 * rejected with 403 by the RolesGuard before any handler runs.
 *
 * The controller stays thin — validation and aggregation live in
 * AdminLiveAccountService; DTOs serialize to the frozen
 * @irexpro/types/admin-live-account contract.
 */
@ApiTags('Admin Live Operations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
@Controller('admin/live-account')
export class AdminLiveAccountController {
  constructor(private readonly adminLiveAccountService: AdminLiveAccountService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Operational overview: connection state counts, discrepancy counts, active execution controls, provider registry, automation counts (admin only)',
  })
  @ApiResponse({ status: 200, type: AdminLiveOpsOverviewViewDto })
  @ApiResponse({ status: 403, description: 'USER role rejected (admin-only surface)' })
  async getOverview(): Promise<AdminLiveOpsOverviewViewDto> {
    return this.adminLiveAccountService.getOverview();
  }

  @Get('connections')
  @ApiOperation({ summary: 'Paginated broker-connection inventory (admin only)' })
  @ApiQuery({
    name: 'filter',
    required: false,
    enum: AdminConnectionFilter,
    description:
      'ALL | CONNECTED | ERROR | LIVE | DEMO (default ALL; invalid values fall back to ALL)',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiResponse({ status: 200, type: AdminConnectionsPageDto })
  @ApiResponse({ status: 403, description: 'USER role rejected (admin-only surface)' })
  async getConnections(
    @Query('filter') filter?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number = 0,
  ): Promise<AdminConnectionsPageDto> {
    return this.adminLiveAccountService.getConnections(
      normalizeAdminConnectionFilter(filter),
      clampPaginationLimit(limit),
      clampPaginationOffset(offset),
    );
  }

  @Get('reconciliation/discrepancies')
  @ApiOperation({
    summary: 'Paginated reconciliation discrepancy log for investigation (admin only)',
  })
  @ApiQuery({
    name: 'filter',
    required: false,
    enum: AdminDiscrepancyFilter,
    description:
      'ALL | OPEN | RESOLVED | CRITICAL | WARNING (severity filters imply OPEN rows; invalid values fall back to ALL)',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiResponse({ status: 200, type: AdminDiscrepanciesPageDto })
  @ApiResponse({ status: 403, description: 'USER role rejected (admin-only surface)' })
  async getDiscrepancies(
    @Query('filter') filter?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number = 0,
  ): Promise<AdminDiscrepanciesPageDto> {
    return this.adminLiveAccountService.getDiscrepancies(
      normalizeAdminDiscrepancyFilter(filter),
      clampPaginationLimit(limit),
      clampPaginationOffset(offset),
    );
  }
}
