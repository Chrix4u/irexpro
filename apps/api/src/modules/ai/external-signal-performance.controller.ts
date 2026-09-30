import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { ExternalSignalPerformanceService } from './external-signal-performance.service';

@ApiTags('AI External Providers')
@Controller('ai/external/providers')
export class ExternalSignalPerformanceController {
  constructor(private readonly performance: ExternalSignalPerformanceService) {}

  @Get('performance')
  @ApiOperation({
    summary: 'Read PAPER performance evidence for an external signal provider',
    description:
      'Read-only user-scoped evidence. Eligibility means DEMO review may begin; it never automatically grants DEMO or LIVE execution authority.',
  })
  @ApiQuery({ name: 'providerCode', required: true, example: 'tradingview-relay' })
  async getPerformance(
    @CurrentUserId() userId: string,
    @Query('providerCode') providerCode: string,
  ) {
    const normalized = String(providerCode ?? '').trim();
    if (!/^[a-zA-Z0-9._-]{2,64}$/.test(normalized)) {
      throw new BadRequestException('Invalid providerCode');
    }
    return this.performance.getProviderPerformance(userId, normalized);
  }
}
