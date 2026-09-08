import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import {
  clampPaginationLimit,
  clampPaginationOffset,
  LiveAccountService,
  normalizeOrderStatusFilter,
} from './live-account.service';
import { LiveOrderStatusFilter } from './dto/live-account.enums';
import { LiveAccountOverviewResponseDto } from './dto/live-account-overview-response.dto';
import { LiveAccountOrdersPageDto } from './dto/live-account-orders-response.dto';
import { LiveAccountPositionsViewDto } from './dto/live-account-positions-response.dto';
import { LiveAccountActivityPageDto } from './dto/live-account-activity-response.dto';

/**
 * USER LIVE ACCOUNT read API (Sprint 50 PR-5 — Directive PHASE J).
 *
 * Read-only aggregation powering the user's Live Account dashboard. All routes
 * are protected by the global JwtAuthGuard; the controller accepts ONLY the
 * authenticated user's UUID via @CurrentUserId() and never any
 * client-supplied userId / connectionId / accountId (Directive §40 tenant
 * isolation). The controller stays thin — validation and aggregation live in
 * LiveAccountService, DTOs serialize to the frozen
 * @irexpro/types/live-account contract.
 */
@ApiTags('Live Account')
@ApiBearerAuth()
@Controller('live-account')
export class LiveAccountController {
  constructor(private readonly liveAccountService: LiveAccountService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Aggregated, tenant-scoped Live Account overview for the authenticated user (connections, automation, execution health, derived alerts)',
  })
  @ApiResponse({ status: 200, type: LiveAccountOverviewResponseDto })
  async getOverview(@CurrentUserId() userId: string): Promise<LiveAccountOverviewResponseDto> {
    return this.liveAccountService.getOverview(userId);
  }

  @Get('orders')
  @ApiOperation({ summary: 'Paginated order rows for the authenticated user' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: LiveOrderStatusFilter,
    description: 'WORKING | HISTORY | ALL (default ALL; invalid values fall back to ALL)',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiResponse({ status: 200, type: LiveAccountOrdersPageDto })
  async getOrders(
    @CurrentUserId() userId: string,
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number = 0,
  ): Promise<LiveAccountOrdersPageDto> {
    return this.liveAccountService.getOrders(
      userId,
      normalizeOrderStatusFilter(status),
      clampPaginationLimit(limit),
      clampPaginationOffset(offset),
    );
  }

  @Get('positions')
  @ApiOperation({
    summary: 'Open / reconciliation-held positions for the authenticated user',
  })
  @ApiResponse({ status: 200, type: LiveAccountPositionsViewDto })
  async getPositions(@CurrentUserId() userId: string): Promise<LiveAccountPositionsViewDto> {
    return this.liveAccountService.getPositions(userId);
  }

  @Get('activity')
  @ApiOperation({ summary: 'Paginated audit activity timeline for the authenticated user' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiResponse({ status: 200, type: LiveAccountActivityPageDto })
  async getActivity(
    @CurrentUserId() userId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<LiveAccountActivityPageDto> {
    return this.liveAccountService.getActivity(
      userId,
      clampPaginationLimit(limit),
      clampPaginationOffset(offset),
    );
  }
}
