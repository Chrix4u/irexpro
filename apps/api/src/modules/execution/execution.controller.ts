import { BadRequestException, Body, Controller, DefaultValuePipe, Get, ParseIntPipe, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { ExecutionReadService } from './execution-read.service';
import { AllocationError, AllocationService } from './services/allocation.service';
import { UpdateCapitalBudgetDto } from './dto/update-capital-budget.dto';
import {
  TradeExecutionResponseDto,
  toTradeExecutionResponse,
} from './dto/trade-execution-response.dto';

/**
 * Frontend-safe execution read API.
 *
 * All routes are protected by the global JwtAuthGuard. The controller accepts
 * only the authenticated user's UUID and returns explicit DTOs rather than raw
 * execution entities.
 */
@ApiTags('Execution')
@Controller('execution')
export class ExecutionController {
  constructor(
    private readonly executionReadService: ExecutionReadService,
    private readonly allocationService: AllocationService,
  ) {}

  @Get('allocation')
  @ApiOperation({ summary: 'Get the explicit AI capital allocation for one broker connection' })
  async getCapitalAllocation(
    @CurrentUserId() userId: string,
    @Query('brokerConnectionId', ParseUUIDPipe) brokerConnectionId: string,
  ) {
    try {
      return await this.allocationService.getUserCapitalBudget(userId, brokerConnectionId);
    } catch (error) {
      if (error instanceof AllocationError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  @Put('allocation')
  @ApiOperation({ summary: 'Set the explicit AI capital allocation for one broker connection' })
  async updateCapitalAllocation(
    @CurrentUserId() userId: string,
    @Body() dto: UpdateCapitalBudgetDto,
  ) {
    try {
      return await this.allocationService.setUserCapitalBudget(
        userId,
        dto.brokerConnectionId,
        dto.totalCapital,
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
