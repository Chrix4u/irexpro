import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { DemoDrawdownExitAuditService } from './demo-drawdown-exit-audit.service';

@ApiTags('AI Research')
@Controller('ai/research')
export class DemoDrawdownExitAuditController {
  constructor(private readonly audit: DemoDrawdownExitAuditService) {}

  @Get('demo-drawdown-guard-after-exit')
  @ApiOperation({
    summary: 'Read quote-close outcomes after DEMO drawdown-guard exits',
    description:
      'Authenticated read-only account/currency-isolated retrospective. No stop/order authority; observed M1 closes cannot establish actual broker fills.',
  })
  getAfterGuardExit(@CurrentUserId() userId: string) {
    return this.audit.getUserRetrospective(userId);
  }
}
