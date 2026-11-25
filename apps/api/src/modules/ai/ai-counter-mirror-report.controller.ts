import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import {
  AiCounterMirrorReportService,
  type CounterMirrorWebReport,
} from './ai-counter-mirror-report.service';

@ApiTags('AI')
@Controller('ai')
export class AiCounterMirrorReportController {
  constructor(private readonly report: AiCounterMirrorReportService) {}

  @Get('counter-mirror')
  @ApiOperation({
    summary: 'Owner-scoped Pepperstone DEMO MAIN vs virtual COUNTER monitor',
    description:
      'Authenticated, strictly read-only. Actual MAIN broker results and separately labeled, simulated counter-direction estimates. Never grants broker execution authority.',
  })
  getCounterMirror(@CurrentUserId() userId: string): Promise<CounterMirrorWebReport> {
    return this.report.getOwnerReport(userId);
  }
}
