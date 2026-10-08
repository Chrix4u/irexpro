import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { AiBidirectionalDecisionService } from './ai-bidirectional-decision.service';
import { AiBidirectionalDecisionResponseDto } from './dto/ai-bidirectional-decision-response.dto';

@ApiTags('AI')
@Controller('ai')
export class AiBidirectionalDecisionController {
  constructor(private readonly comparisons: AiBidirectionalDecisionService) {}

  @Get('decision-comparisons')
  @ApiOperation({
    summary: 'Get recent browser-safe BUY versus SELL decision comparisons',
    description:
      'Read-only projection of the latest prospective ensemble policy. Returns paired BUY/SELL scores, strategy route, consensus, net expected R, drift state, PAPER eligibility and blocker codes. Raw model metadata, prices, P&L, credentials and hidden reasoning are excluded.',
  })
  async getRecentComparisons(
    @CurrentUserId() userId: string,
  ): Promise<AiBidirectionalDecisionResponseDto> {
    return this.comparisons.getRecentComparisons(userId);
  }
}
