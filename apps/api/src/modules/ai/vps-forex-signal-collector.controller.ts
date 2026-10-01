import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { VpsForexSignalCollectorService } from './vps-forex-signal-collector.service';

@ApiTags('AI External Providers')
@Controller('ai/external/vps-forex')
export class VpsForexSignalCollectorController {
  constructor(private readonly collector: VpsForexSignalCollectorService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Read the VPS-native six-pair PAPER scanner status',
    description:
      'User-scoped, read-only status. Never returns the Twelve Data API key or broker/user identifiers.',
  })
  getStatus(@CurrentUserId() userId: string) {
    return this.collector.getStatus(userId);
  }
}
