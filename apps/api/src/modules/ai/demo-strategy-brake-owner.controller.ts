import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { DemoStrategyBrakeOwnerService } from './demo-strategy-brake-owner.service';

@ApiTags('AI DEMO Strategy Safety')
@Controller('ai/external/vps-forex/m1-tactical/strategy-loss-alerts')
export class DemoStrategyBrakeOwnerController {
  constructor(private readonly owner: DemoStrategyBrakeOwnerService) {}

  @Get()
  @ApiOperation({summary:'Show qualified strategy-level loss brakes to the verified account owner'})
  status(@CurrentUserId() id:string) { return this.owner.getStatus(id); }

  @Post('decision')
  @HttpCode(200)
  @ApiOperation({summary:'Account-owner incident-scoped DEMO safety decision; resume normal strategy operation or keep paused'})
  decide(@CurrentUserId() id:string, @Body() body:{
    action:'KEEP_PAUSED'|'CONTINUE_TRADING';
    route:'EARLY_TRANSITION'|'CONFIRMED_REVERSAL';
    instrument:string;
    direction:'BUY'|'SELL';
    incidentClosedAt:string;
  }) {
    return this.owner.decide(id,body);
  }
}
