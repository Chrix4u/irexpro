import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleName } from '../users/entities/role.entity';
import { AdminAuditLogFilter } from './dto/admin-live-account.enums';
import { AdminAuditPageDto } from './dto/admin-audit-response.dto';
import {
  AdminLiveAccountService,
  clampPaginationLimit,
  clampPaginationOffset,
  normalizeAdminAuditFilter,
} from './admin-live-account.service';

/**
 * ADMIN AUDIT INVESTIGATION read API (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * Separate controller (different base path) for the audit-investigation
 * surface. Cross-user visibility is INTENTIONAL (admin scope); RBAC is
 * enforced exactly like ExecutionControlController at the CLASS level, so
 * USER-role requests are rejected with 403 before any handler runs.
 *
 * The optional actorUserId / resourceType query filters are forwarded to the
 * service as plain strings and used ONLY as equality filters — never trusted
 * for anything broader. Metadata blobs, IP addresses, and user agents never
 * leave the server.
 */
@ApiTags('Admin Audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly adminLiveAccountService: AdminLiveAccountService) {}

  @Get('logs')
  @ApiOperation({ summary: 'Paginated audit log investigation feed (admin only)' })
  @ApiQuery({
    name: 'filter',
    required: false,
    enum: AdminAuditLogFilter,
    description: 'ALL | CRITICAL | WARNING (default ALL; invalid values fall back to ALL)',
  })
  @ApiQuery({
    name: 'actorUserId',
    required: false,
    type: String,
    description: 'Optional equality filter on the acting user id.',
  })
  @ApiQuery({
    name: 'resourceType',
    required: false,
    type: String,
    description: 'Optional equality filter on the audited resource type.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiResponse({ status: 200, type: AdminAuditPageDto })
  @ApiResponse({ status: 403, description: 'USER role rejected (admin-only surface)' })
  async getLogs(
    @Query('filter') filter?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('resourceType') resourceType?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number = 0,
  ): Promise<AdminAuditPageDto> {
    return this.adminLiveAccountService.getAuditLogs(
      normalizeAdminAuditFilter(filter),
      actorUserId ?? null,
      resourceType ?? null,
      clampPaginationLimit(limit),
      clampPaginationOffset(offset),
    );
  }
}
