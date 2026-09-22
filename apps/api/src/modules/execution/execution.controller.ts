import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { ExecutionReadService } from './execution-read.service';
import { ExecutionService } from './execution.service';
import {
  AllocationError,
  AllocationService,
  type UserCapitalAllocationState,
} from './services/allocation.service';
import { SetCapitalAllocationDto } from './dto/set-capital-allocation.dto';
import {
  TradeExecutionResponseDto,
  toTradeExecutionResponse,
} from './dto/trade-execution-response.dto';
import { ManualPositionCloseResponseDto } from './dto/manual-position-close-response.dto';

/**
 * Frontend-safe execution read API.
 *
 * All routes are protected by the global JwtAuthGuard. The controller accepts
 * only the authenticated user's UUID and returns explicit DTOs rather than raw
 * execution entities.
 *
 * October UAT hardening (WS1): POST /execution/positions/:tradeId/close is
 * the ONLY user-facing order-action route — a risk-REDUCING single-position
 * close routed through the full execution domain (ownership checks,
 * orchestrator gates, exactly-once close attempts, reconciliation for
 * unknown provider outcomes). Order PLACEMENT stays pipeline-only.
 */
@ApiTags('Execution')
@Controller('execution')
export class ExecutionController {
  constructor(
    private readonly executionReadService: ExecutionReadService,
    private readonly allocationService: AllocationService,
    private readonly executionService: ExecutionService,
  ) {}

  @Get('capital-allocation')
  @ApiOperation({ summary: 'Read explicit AI capital allocation for one broker account' })
  @ApiQuery({ name: 'brokerConnectionId', required: true, type: String })
  async getCapitalAllocation(
    @CurrentUserId() userId: string,
    @Query('brokerConnectionId') brokerConnectionId: string,
  ): Promise<UserCapitalAllocationState> {
    try {
      return await this.allocationService.getUserCapitalAllocationState(userId, brokerConnectionId);
    } catch (error) {
      if (error instanceof AllocationError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  @Post('capital-allocation')
  @ApiOperation({ summary: 'Set the capital amount the AI may allocate for one broker account' })
  async setCapitalAllocation(
    @CurrentUserId() userId: string,
    @Body() dto: SetCapitalAllocationDto,
  ): Promise<UserCapitalAllocationState> {
    try {
      return await this.allocationService.setUserCapitalBudget(
        userId,
        dto.brokerConnectionId,
        dto.amount,
      );
    } catch (error) {
      if (error instanceof AllocationError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  @Get('positions/open')
  @ApiOperation({ summary: 'List current open positions for the authenticated user' })
  @ApiResponse({ status: 200, type: TradeExecutionResponseDto, isArray: true })
  async listOpenPositions(@CurrentUserId() userId: string): Promise<TradeExecutionResponseDto[]> {
    const trades = await this.executionReadService.listOpenPositions(userId);
    return trades.map(toTradeExecutionResponse);
  }

  @Post('positions/:tradeId/close')
  @ApiOperation({
    summary: 'Close ONE open position (manual) — honest typed outcome, never a fabricated success',
    description:
      'Ownership-checked single-position close routed through the execution domain ' +
      '(orchestrator gates, exactly-once close attempts, reconciliation for unknown ' +
      'provider outcomes). Outcomes: CLOSED / ALREADY_CLOSED / CLOSE_IN_PROGRESS / ' +
      'RECONCILIATION_REQUIRED / PROVIDER_REFUSED.',
  })
  @ApiResponse({ status: 200, type: ManualPositionCloseResponseDto })
  @ApiResponse({ status: 403, description: 'Position belongs to a different user or connection.' })
  @ApiResponse({ status: 404, description: 'Position not found for this user.' })
  async closeOpenPosition(
    @CurrentUserId() userId: string,
    @Param('tradeId', ParseUUIDPipe) tradeId: string,
  ): Promise<ManualPositionCloseResponseDto> {
    return this.executionService.closeOpenPositionManually(tradeId, userId);
  }

  @Get('trades/recent')
  @ApiOperation({ summary: 'List recent execution lifecycle records for the authenticated user' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiResponse({ status: 200, type: TradeExecutionResponseDto, isArray: true })
  async listRecentExecutions(
    @CurrentUserId() userId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): Promise<TradeExecutionResponseDto[]> {
    const trades = await this.executionReadService.listRecentExecutions(userId, limit);
    return trades.map(toTradeExecutionResponse);
  }
}
