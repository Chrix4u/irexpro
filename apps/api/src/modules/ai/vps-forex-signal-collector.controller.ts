import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { VpsForexSignalCollectorService } from './vps-forex-signal-collector.service';
import { BrokerParityV7Service } from './broker-parity-v7.service';
import { V8DedicatedPaperReadinessService } from './v8-dedicated-paper-readiness.service';

@ApiTags('AI External Providers')
@Controller('ai/external/vps-forex')
export class VpsForexSignalCollectorController {
  constructor(
    private readonly collector: VpsForexSignalCollectorService,
    private readonly brokerParity: BrokerParityV7Service,
    private readonly v8DedicatedPaper: V8DedicatedPaperReadinessService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'Read the VPS-native six-pair PAPER scanner status',
    description:
      'User-scoped, read-only status. Never returns the Twelve Data API key or broker/user identifiers.',
  })
  getStatus(@CurrentUserId() userId: string) {
    return this.collector.getStatus(userId);
  }

  @Get('broker-parity/status')
  @ApiOperation({
    summary: 'Read Broker-Parity v7 preparation/runtime status',
    description:
      'Read-only status for the isolated broker-native MetaApi → PAPER path. Never exposes connection identifiers, credentials, or artifact secrets.',
  })
  getBrokerParityStatus(@CurrentUserId() userId: string) {
    return this.brokerParity.getStatus(userId);
  }

  @Get('v8-dedicated-paper/status')
  @ApiOperation({
    summary: 'Read dedicated v8 PAPER activation readiness',
    description:
      'Read-only guard status. v8 remains shadow-only until the prospective screen, isolated PAPER target, and frozen-artifact requirements are all satisfied.',
  })
  getV8DedicatedPaperStatus(@CurrentUserId() userId: string) {
    return this.v8DedicatedPaper.getStatus(userId);
  }
}
